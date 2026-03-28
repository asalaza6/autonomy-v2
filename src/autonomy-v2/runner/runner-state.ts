import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { acquireStateLock } from '../../lock/lock-main.js';
import { AGENT_ROLES, TASK_TYPES, getRoleLabel, isImplementationRole, isReviewRole } from '../../agents/role-catalog.js';
import type { AnyRecord, AutonomyConfig, QueueMap, QueueState, TaskRecord } from '../autonomy-types.js';
import { commitTrackedFilesToIntegrationBranch } from '../../sync/sync-git.js';
import { AUTONOMY_SEGMENTS, RUNTIME_SEGMENTS } from './runner-constants.js';
import { readJson, trimLeadingSeparator, uniqueScopeViolations, uniqueStrings, writeJson } from './runner-shared.js';

function loadState(rootDir: string, options: AnyRecord = {}): { config: AutonomyConfig; queues: QueueMap } {
  const repoAutonomyDir = path.join(rootDir, ...AUTONOMY_SEGMENTS);
  const config = readJson(path.join(repoAutonomyDir, 'config', 'agents.json'));
  const queues = {};
  (config.agents || []).forEach((agent) => {
    const relativePath = agent.taskQueue;
    const queuePath = isImplementationRole(agent.role)
      ? (
        options.worktreePath && options.implementationAgentId === agent.id
          ? path.join(options.worktreePath, relativePath)
          : path.join(rootDir, relativePath)
      )
      : path.isAbsolute(relativePath)
        ? relativePath
        : resolveRuntimeManagedPath(rootDir, relativePath);
    const fallbackValue = fs.existsSync(queuePath)
      ? readJson(queuePath)
      : buildTaskQueueState(agent, []);
    queues[agent.id] = isReviewRole(agent.role)
      ? readJsonFromGitRef(rootDir, resolveTrackedQueueRef(rootDir, config.integrationBranch), relativePath, fallbackValue)
      : fallbackValue;
  });
  return { config, queues };
}

function buildTaskQueueState(agent: AnyRecord, tasks: TaskRecord[] = []): QueueState {
  return isImplementationRole(agent.role)
    ? { schemaVersion: 1, agentId: agent.id, role: agent.role, tasks }
    : { agentId: agent.id, role: agent.role, tasks };
}

function getImplementationTaskState(task) {
  return String((task && (task.state || task.status)) || '').trim();
}

function isPendingImplementationTask(task) {
  const state = getImplementationTaskState(task);
  return state === 'active' || state === 'queued';
}

function getTask(queues: QueueMap, taskId: string): TaskRecord {
  for (const queue of Object.values(queues)) {
    const task = (queue.tasks || []).find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function getLaneTasks(queues: QueueMap, agentId: string, laneKey: string): TaskRecord[] {
  return Object.values(queues)
    .filter((queue) => queue.agentId === agentId)
    .flatMap((queue) => queue.tasks || [])
    .filter((candidate) => buildTaskLaneKey(candidate) === laneKey)
    .sort((left, right) => {
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    });
}

function buildTaskLaneKey(task) {
  if (task.laneKey) {
    return task.laneKey;
  }
  if (task.prdId) {
    return `${task.prdId}:${task.agentId}`;
  }
  return task.id;
}

function getAgentConfig(config, agentId) {
  const agent = (config.agents || []).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent "${agentId}".`);
  }
  return agent;
}

function getPrForLane(rootDir, agentId, laneKey) {
  const prsPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'prs.json');
  const prsState = readJson(prsPath);
  return (prsState.pullRequests || []).find((candidate) => {
    return candidate.agentId === agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function getPr(rootDir, prId) {
  const prsPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'prs.json');
  const prsState = readJson(prsPath);
  const pr = (prsState.pullRequests || []).find((candidate) => candidate.id === prId);
  if (!pr) {
    throw new Error(`Unknown PR "${prId}".`);
  }
  return pr;
}

function getReviewTask(queues: QueueMap, reviewTaskId: string): TaskRecord {
  for (const queue of Object.values(queues)) {
    const task = (queue.tasks || []).find((candidate) => candidate.id === reviewTaskId);
    if (task) {
      return task;
    }
  }
  throw new Error(`Unknown ${getRoleLabel(AGENT_ROLES.REVIEW)} task "${reviewTaskId}".`);
}

function gitRefExists(rootDir, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
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

function readJsonFromGitRef(rootDir, ref, relativePath, fallbackValue) {
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
    }));
  } catch (_) {
    return fallbackValue;
  }
}

function resolveRuntimeManagedPath(rootDir, relativePath) {
  const normalized = path.normalize(relativePath);
  const trackedStatePrefix = path.join(...AUTONOMY_SEGMENTS, 'state');
  const runtimeStateDir = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state');
  if (normalized === trackedStatePrefix || normalized.startsWith(`${trackedStatePrefix}${path.sep}`)) {
    return path.join(runtimeStateDir, trimLeadingSeparator(normalized.slice(trackedStatePrefix.length)));
  }
  return path.join(rootDir, normalized);
}

function getCompletedLaneTasks(rootDir, agentId, laneKey) {
  const branchLocksPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'branch-locks.json');
  if (!fs.existsSync(branchLocksPath)) {
    return [];
  }
  const branchLocks = readJson(branchLocksPath);
  const branchLock = findBranchLock(branchLocks, agentId, laneKey);
  return Array.isArray(branchLock && branchLock.completedTasks)
    ? branchLock.completedTasks.slice()
    : [];
}

function recordLaneTaskCompletion(rootDir, task, branch, worktreePath, scopeResult) {
  const laneKey = buildTaskLaneKey(task);
  const release = acquireStateLock(rootDir);
  try {
    const branchLocksPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'branch-locks.json');
    const branchLocks = fs.existsSync(branchLocksPath)
      ? readJson(branchLocksPath)
      : { locks: [] };
    let branchLock = findBranchLock(branchLocks, task.agentId, laneKey);
    if (!branchLock) {
      branchLock = {
        taskId: task.id,
        laneKey,
        agentId: task.agentId,
        branch,
        worktreePath,
        completedTasks: [],
      };
      branchLocks.locks.push(branchLock);
    }
    branchLock.taskId = task.id;
    branchLock.branch = branch;
    branchLock.worktreePath = worktreePath;
    branchLock.updatedAt = new Date().toISOString();
    branchLock.completedTasks = Array.isArray(branchLock.completedTasks) ? branchLock.completedTasks : [];
    const snapshot = buildTaskSnapshot(task, scopeResult);
    const currentIndex = branchLock.completedTasks.findIndex((candidate) => candidate.id === task.id);
    if (currentIndex >= 0) {
      branchLock.completedTasks[currentIndex] = {
        ...branchLock.completedTasks[currentIndex],
        ...snapshot,
      };
    } else {
      branchLock.completedTasks.push(snapshot);
    }
    writeJson(branchLocksPath, branchLocks);
    return branchLock.completedTasks.slice();
  } finally {
    release();
  }
}

function buildTaskSnapshot(task, scopeResult) {
  return {
    id: task.id,
    title: task.title,
    description: task.description || '',
    agentId: task.agentId,
    prdId: task.prdId || null,
    laneKey: buildTaskLaneKey(task),
    type: task.type || TASK_TYPES.DEFAULT,
    sprintId: task.sprintId || null,
    baseBranch: task.baseBranch || null,
    checks: uniqueStrings(task.checks || []),
    acceptance: uniqueStrings(task.acceptance || []),
    scopeViolations: uniqueScopeViolations(scopeResult && scopeResult.violations),
    completedAt: new Date().toISOString(),
  };
}

function findBranchLock(branchLocks, agentId, laneKey) {
  return (branchLocks.locks || []).find((candidate) => {
    return candidate.agentId === agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function persistReviewerTaskState(rootDir: string, config: AutonomyConfig, reviewTaskId: string, patch: AnyRecord) {
  const release = acquireStateLock(rootDir);
  try {
    const state = loadState(rootDir);
    const reviewerTask = getReviewTask(state.queues, reviewTaskId);
    Object.entries(patch || {}).forEach(([key, value]) => {
      if (value === null || typeof value === 'undefined') {
        delete reviewerTask[key];
        return;
      }
      reviewerTask[key] = value;
    });
    writeQueuesState(rootDir, config, state.queues);
  } finally {
    release();
  }
}

function writeQueuesState(rootDir: string, config: AutonomyConfig, queues: QueueMap) {
  (config.agents || []).forEach((agent) => {
    if (isImplementationRole(agent.role)) {
      return;
    }
    if (isReviewRole(agent.role)) {
      commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, [{
        relativePath: agent.taskQueue,
        content: queues[agent.id],
      }], {
        commitMessage: `autonomy(queue): update ${agent.id}`,
        gitIdentity: agent.gitIdentity,
      });
      return;
    }
    const relativePath = agent.taskQueue;
    const queuePath = path.isAbsolute(relativePath)
      ? relativePath
      : resolveRuntimeManagedPath(rootDir, relativePath);
    writeJson(queuePath, queues[agent.id]);
  });
  writeJson(path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'tasks.json'), {
    tasks: Object.values(queues)
      .filter((queue) => {
        const agent = getAgentConfig(config, queue.agentId);
        return !isImplementationRole((agent && agent.role) || queue.role || '');
      })
      .flatMap((queue) => queue.tasks || []),
  });
}

export {
  buildTaskLaneKey,
  buildTaskQueueState,
  getAgentConfig,
  getCompletedLaneTasks,
  getImplementationTaskState,
  getLaneTasks,
  getPr,
  getPrForLane,
  getReviewTask,
  getTask,
  isPendingImplementationTask,
  loadState,
  persistReviewerTaskState,
  recordLaneTaskCompletion,
};
