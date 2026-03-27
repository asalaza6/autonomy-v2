import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { commitTrackedFilesToIntegrationBranch } from '../../sync/git.js';
import { TASK_TYPES, isImplementationRole, isReviewRole, usesTrackedQueueForRole } from '../../agents/role-catalog.js';
import type { AnyRecord, AutonomyConfig, BranchLocksState, QueueMap, QueueState, TaskRecord } from '../types.js';
import {
  DEFAULT_AUTONOMY_SEGMENTS,
  DEFAULT_RUNTIME_SEGMENTS,
  getAgent,
  readJson,
  writeJson,
} from './shared-core.js';
import {
  gitRefExists,
} from './shared-repo.js';

function resolveTaskQueuePath(rootDir, config, agentId) {
  const agent = getAgent(config, agentId);
  const relativePath = agent.taskQueue;
  if (!relativePath) {
    throw new Error(`Agent "${agent.id}" is missing taskQueue in config/agents.json`);
  }
  if (isImplementationRole(agent.role)) {
    return path.isAbsolute(relativePath)
      ? relativePath
      : path.join(rootDir, relativePath);
  }
  return path.isAbsolute(relativePath)
    ? relativePath
    : resolveRuntimeManagedPath(rootDir, relativePath);
}

function resolveTrackedQueueRef(rootDir, integrationBranch) {
  const remoteRef = `origin/${integrationBranch}`;
  if (gitRefExists(rootDir, remoteRef)) {
    return remoteRef;
  }
  if (gitRefExists(rootDir, integrationBranch)) {
    return integrationBranch;
  }
  return null;
}

function readJsonFromGitRef<T = any>(rootDir: string, ref: string, relativePath: string, fallbackValue: T): T {
  if (!ref || path.isAbsolute(relativePath)) {
    return fallbackValue;
  }
  try {
    return JSON.parse(execFileSync('git', [
      'show',
      `${ref}:${relativePath.replace(/\\/g, '/')}`,
    ], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })) as T;
  } catch (_) {
    return fallbackValue;
  }
}

function resolveRuntimeManagedPath(rootDir, relativePath) {
  const normalized = path.normalize(relativePath);
  const trackedStatePrefix = path.join(...DEFAULT_AUTONOMY_SEGMENTS, 'state');
  const runtimeStateDir = path.join(rootDir, ...DEFAULT_RUNTIME_SEGMENTS, 'state');
  if (normalized === trackedStatePrefix || normalized.startsWith(`${trackedStatePrefix}${path.sep}`)) {
    return path.join(runtimeStateDir, trimLeadingSeparator(normalized.slice(trackedStatePrefix.length)));
  }
  if (normalized === 'state' || normalized.startsWith(`state${path.sep}`)) {
    return path.join(runtimeStateDir, trimLeadingSeparator(normalized.slice('state'.length)));
  }
  return path.join(rootDir, normalized);
}

function trimLeadingSeparator(value) {
  let normalized = String(value || '');
  while (normalized.startsWith('/') || normalized.startsWith('\\')) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function buildTaskQueueState(agent: AnyRecord, tasks: TaskRecord[] = []): QueueState {
  const base: QueueState = {
    agentId: agent.id,
    role: agent.role,
    tasks,
  };
  if (isImplementationRole(agent.role)) {
    base.schemaVersion = 1;
  }
  return base;
}

function normalizeTaskStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function isProcessAcceptance(value) {
  return /(reflog|origin\/|merge-base|created from|branch|commit)/i.test(String(value || ''));
}

function buildFallbackAcceptance(taskId) {
  return [`Task \`${taskId}\` is complete within the assigned agent scope.`];
}

function sanitizePlannedTaskSpecs(taskSpecs) {
  return (Array.isArray(taskSpecs) ? taskSpecs : []).map((task) => {
    const acceptance = normalizeTaskStringList(task && task.acceptance)
      .filter((entry) => !isProcessAcceptance(entry));
    return {
      ...task,
      acceptance: acceptance.length > 0
        ? acceptance
        : buildFallbackAcceptance(task && task.id),
    };
  });
}

function buildTrackedImplementationQueueUpdates(rootDir, config, taskSpecs, { prd, sprint, source = 'planned' }) {
  const queues = readTaskQueues(rootDir, config);
  const nextByAgent = new Map();
  const now = new Date().toISOString();

  (Array.isArray(taskSpecs) ? taskSpecs : []).forEach((spec) => {
    const agent = getAgent(config, spec.agentId);
    const baseQueue = nextByAgent.get(agent.id) || buildTaskQueueState(agent, ((queues[agent.id] && queues[agent.id].tasks) || []).slice());
    const existingIndex = (baseQueue.tasks || []).findIndex((task) => task.id === spec.id);
    const nextTask = {
      id: spec.id,
      title: spec.title,
      description: spec.description || '',
      agentId: spec.agentId,
      prdId: prd.id || undefined,
      laneKey: spec.laneKey || `${prd.id}:${spec.agentId}`,
      type: spec.type || TASK_TYPES.DEFAULT,
      source: spec.source || source,
      sprintId: spec.sprintId || prd.sprintId || sprint.sprintId || 'shared',
      baseBranch: config.integrationBranch,
      checks: normalizeTaskStringList(agent.checks || []),
      acceptance: normalizeTaskStringList(spec.acceptance),
      state: 'queued',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    if (!nextTask.prdId) {
      delete nextTask.prdId;
    }
    if (existingIndex >= 0) {
      baseQueue.tasks[existingIndex] = {
        ...baseQueue.tasks[existingIndex],
        ...nextTask,
      };
    } else {
      baseQueue.tasks.push(nextTask);
    }
    nextByAgent.set(agent.id, baseQueue);
  });

  return Array.from(nextByAgent.entries()).map(([agentId, queueState]) => {
    const agent = getAgent(config, agentId);
    const relativePath = agent.taskQueue;
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Implementation queue for "${agentId}" must be repo-relative to commit it to ${config.integrationBranch}.`);
    }
    return {
      relativePath,
      content: buildTaskQueueState(agent, queueState.tasks || []),
    };
  });
}

function commitTrackedImplementationQueue(rootDir, config, agent, queueState, options = {}) {
  const relativePath = agent.taskQueue;
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Implementation queue for "${agent.id}" must be repo-relative to commit it to ${config.integrationBranch}.`);
  }
  return commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, [{
    relativePath,
    content: buildTaskQueueState(agent, queueState.tasks || []),
  }], options);
}

function commitTrackedAgentQueue(rootDir, config, agent, queueState, options = {}) {
  const relativePath = agent.taskQueue;
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Tracked queue for "${agent.id}" must be repo-relative to commit it to ${config.integrationBranch}.`);
  }
  return commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, [{
    relativePath,
    content: buildTaskQueueState(agent, queueState.tasks || []),
  }], options);
}

function readTaskQueues(rootDir, config) {
  return (config.agents || []).reduce((queues, agent) => {
    const queuePath = resolveTaskQueuePath(rootDir, config, agent.id);
    const usesTrackedQueue = usesTrackedQueueForRole(agent.role);
    const rawQueue = usesTrackedQueue
      ? readJsonFromGitRef(
          rootDir,
          resolveTrackedQueueRef(rootDir, config.integrationBranch),
          agent.taskQueue,
          fs.existsSync(queuePath) ? readJson(queuePath) : buildTaskQueueState(agent, [])
        )
      : fs.existsSync(queuePath)
        ? readJson(queuePath)
        : buildTaskQueueState(agent, []);
    queues[agent.id] = buildTaskQueueState(agent, Array.isArray(rawQueue.tasks) ? rawQueue.tasks : []);
    return queues;
  }, {});
}

function writeTaskQueues(rootDir: string, config: AutonomyConfig, taskQueues: QueueMap, options: AnyRecord = {}) {
  (config.agents || []).forEach((agent) => {
    if (isImplementationRole(agent.role)) {
      return;
    }
    const queueState = getTaskQueue(taskQueues, config, agent.id);
    if (isReviewRole(agent.role)) {
      commitTrackedAgentQueue(rootDir, config, agent, queueState, {
        commitMessage: options.reviewCommitMessage || `autonomy(queue): update ${agent.id}`,
        gitIdentity: options.reviewGitIdentity || agent.gitIdentity,
      });
      return;
    }
    writeJson(resolveTaskQueuePath(rootDir, config, agent.id), queueState);
  });
}

function getTaskQueue(taskQueues: QueueMap, config: AutonomyConfig, agentId: string): QueueState {
  if (taskQueues[agentId]) {
    return taskQueues[agentId];
  }
  const agent = getAgent(config, agentId);
  taskQueues[agentId] = buildTaskQueueState(agent, []);
  return taskQueues[agentId];
}

function listTasks(taskQueues: QueueMap): TaskRecord[] {
  return Object.values(taskQueues).flatMap((queue) => queue.tasks);
}

function getTask(taskQueues: QueueMap, taskId: string): TaskRecord {
  const task = findTask(taskQueues, taskId);
  if (task) {
    return task;
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function findTask(taskQueues: QueueMap, taskId: string): TaskRecord | null {
  for (const queue of Object.values(taskQueues)) {
    const task = queue.tasks.find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

function readImplementationQueueFromGitRef(rootDir, config, agentId, ref, fallbackValue = null) {
  if (!ref) {
    return fallbackValue;
  }
  const agent = getAgent(config, agentId);
  const queueState = readJsonFromGitRef(rootDir, ref, agent.taskQueue, fallbackValue);
  if (!queueState) {
    return fallbackValue;
  }
  return buildTaskQueueState(agent, Array.isArray(queueState.tasks) ? queueState.tasks : []);
}

function readImplementationQueueSnapshot(rootDir: string, config: AutonomyConfig, agentId: string, options: AnyRecord = {}) {
  const queueFromBranch = options.branch && gitRefExists(rootDir, options.branch)
    ? readImplementationQueueFromGitRef(rootDir, config, agentId, options.branch, null)
    : null;
  if (queueFromBranch) {
    return queueFromBranch;
  }
  if (options.worktreePath && fs.existsSync(options.worktreePath)) {
    return readImplementationQueueFromWorktree(rootDir, config, agentId, options.worktreePath);
  }
  return null;
}

function readImplementationQueueFromWorktree(rootDir, config, agentId, worktreePath) {
  const relativePath = getAgent(config, agentId).taskQueue;
  const queuePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(worktreePath, relativePath);
  if (!fs.existsSync(queuePath)) {
    return null;
  }
  try {
    const queueState = readJson(queuePath);
    return buildTaskQueueState(getAgent(config, agentId), Array.isArray(queueState.tasks) ? queueState.tasks : []);
  } catch (_) {
    return null;
  }
}

function filterCompletedImplementationQueueTasks(queue, branchLocksState, agentId) {
  const completedTaskIds = new Set(
    ((branchLocksState && branchLocksState.locks) || [])
      .filter((lock) => lock && lock.agentId === agentId)
      .flatMap((lock) => ((lock && lock.completedTasks) || []).map((task) => task.id))
      .filter(Boolean)
  );
  return {
    ...(queue || {}),
    tasks: (queue && Array.isArray(queue.tasks) ? queue.tasks : []).filter((task) => !completedTaskIds.has(task.id)),
  };
}

function getImplementationTaskState(task) {
  return String((task && (task.state || task.status)) || '').trim();
}

function isTerminalTaskStatus(status) {
  return ['merged', 'approved', 'done'].includes(String(status || ''));
}

export {
  buildFallbackAcceptance,
  buildTaskQueueState,
  buildTrackedImplementationQueueUpdates,
  commitTrackedImplementationQueue,
  filterCompletedImplementationQueueTasks,
  findTask,
  getImplementationTaskState,
  getTask,
  getTaskQueue,
  isTerminalTaskStatus,
  listTasks,
  normalizeTaskStringList,
  readImplementationQueueSnapshot,
  readTaskQueues,
  resolveRuntimeManagedPath,
  resolveTaskQueuePath,
  sanitizePlannedTaskSpecs,
  writeTaskQueues,
};
