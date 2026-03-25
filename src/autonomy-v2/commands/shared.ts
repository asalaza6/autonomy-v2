import fs from 'fs';
import https from 'https';
import path from 'path';
import { execFileSync } from 'child_process';
import { validateAutonomyConfig } from '../../config/index.js';
import { DEFAULT_SYNC_STATE, buildPrdSpecPayload, buildPrdStateRelativePath, commitPrdSpecToIntegrationBranch, commitTrackedFilesToIntegrationBranch, hasActivePrdSpecInIntegrationBranch, hasPrdSpecInIntegrationBranch, listTrackedPrdSpecs, readTrackedPrdStateMap, syncPrdSpecsFromIntegrationBranch, } from '../../sync/index.js';
import { resolveGithubAuthToken } from '../../github/index.js';
import { AGENT_ROLES, TASK_TYPES, getRoleAgentLabel, getRoleLabel, isImplementationRole, isPmRole, isReviewRole, usesTrackedQueueForRole, } from '../../agents/role-catalog.js';
import type { AnyRecord, AutonomyConfig, BranchLocksState, PullRequestRecord, PrState, PrdSpecPayload, QueueMap, QueueState, TaskRecord, TrackedPrdRecord } from '../../types.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_PACKAGE_ROOT = path.join(__dirname, '..', '..', '..');
const SOURCE_PACKAGE_ROOT = path.join(DIST_PACKAGE_ROOT, '..');
const PACKAGE_ROOT = fs.existsSync(path.join(DIST_PACKAGE_ROOT, 'templates'))
  ? DIST_PACKAGE_ROOT
  : SOURCE_PACKAGE_ROOT;
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, 'templates', 'prompts', 'autonomous', 'v2');
const DEFAULT_AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const DEFAULT_RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const PRD_SPECS_SEGMENTS = [...DEFAULT_AUTONOMY_SEGMENTS, 'specs', 'prds'];
const PRD_QUEUE_SEGMENTS = [...PRD_SPECS_SEGMENTS, 'queue'];
const PRD_ARCHIVE_SEGMENTS = [...PRD_SPECS_SEGMENTS, 'archived'];
const DEFAULT_AUTONOMY_ENV = [
  'AUTONOMY_INITIALIZED=1',
  'GITHUB_TOKEN=',
  '',
].join('\n');
const DEFAULT_GITIGNORE = [
  '# System-generated default ignore file for autonomy-v2.',
  '# Keep this file aligned with repository bootstrap defaults.',
  '',
  '# Node / tooling artifacts',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.DS_Store',
  '',
  '# Env files',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '',
  '# Autonomy runtime state',
  '.autonomy/',
  '',
  '# Autonomy local environment placeholder',
  '.env.autonomy',
  '',
].join('\n');
const GENERATED_TEMPLATE_FILES = {
  'state/prs.json': () => `${JSON.stringify({ pullRequests: [] }, null, 2)}\n`,
  'state/branch-locks.json': () => `${JSON.stringify({ locks: [] }, null, 2)}\n`,
  'state/spec-sync.json': () => `${JSON.stringify(DEFAULT_SYNC_STATE, null, 2)}\n`,
  'state/runtime.json': () => `${JSON.stringify({ workers: {} }, null, 2)}\n`,
  '.env.autonomy': () => DEFAULT_AUTONOMY_ENV,
  '.gitignore': () => DEFAULT_GITIGNORE,
};
const BASE_TEMPLATE_FILES = [
  '.env.autonomy',
  '.gitignore',
  'README.md',
  'config/agents.json',
  'config/sprint.json',
  'state/prs.json',
  'state/branch-locks.json',
  'state/spec-sync.json',
  'state/runtime.json',
  'specs/README.md',
  'specs/prd-state/README.md',
  'specs/prds/archived/README.md',
];

function getAutonomyPaths(rootDir) {
  const repoAutonomyDir = path.join(rootDir, ...DEFAULT_AUTONOMY_SEGMENTS);
  const runtimeAutonomyDir = path.join(rootDir, ...DEFAULT_RUNTIME_SEGMENTS);
  const configDir = path.join(repoAutonomyDir, 'config');
  const stateDir = path.join(runtimeAutonomyDir, 'state');
  return {
    repoAutonomyDir,
    runtimeAutonomyDir,
    configDir,
    stateDir,
    queuesDir: path.join(stateDir, 'queues'),
    agentsConfig: path.join(configDir, 'agents.json'),
    sprintConfig: path.join(configDir, 'sprint.json'),
    prsState: path.join(stateDir, 'prs.json'),
    branchLocksState: path.join(stateDir, 'branch-locks.json'),
    specSyncState: path.join(stateDir, 'spec-sync.json'),
    runtimeState: path.join(stateDir, 'runtime.json'),
  };
}

function getPrdSpecsDir(rootDir) {
  return path.join(rootDir, ...PRD_SPECS_SEGMENTS);
}

function getArchivedPrdSpecsDir(rootDir) {
  return path.join(rootDir, ...PRD_ARCHIVE_SEGMENTS);
}



function listCurrentPrdSpecEntries(rootDir) {
  const specsDir = getPrdSpecsDir(rootDir);
  return listPrdSpecEntriesInDir(specsDir);
}

function listQueuedPrdSpecEntries(rootDir) {
  const queueDir = path.join(rootDir, ...PRD_QUEUE_SEGMENTS);
  return listPrdSpecEntriesInDir(queueDir);
}

function listPrdSpecEntriesInDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(dirPath, entry.name);
      try {
        const spec = readJson(filePath);
        return {
          id: String(spec.id || entry.name.replace(/\.json$/i, '')),
          fileName: entry.name,
          filePath,
        };
      } catch (_) {
        return {
          id: entry.name.replace(/\.json$/i, ''),
          fileName: entry.name,
          filePath,
        };
      }
    });
}

function findArchivablePrdIds(prdIds: string[], { taskQueues, prs, prds }: { taskQueues: QueueMap; prs: PrState; prds: { prds: TrackedPrdRecord[] } }) {
  const prdIdSet = new Set(prdIds || []);
  const prdById = new Map<string, TrackedPrdRecord>(((prds && prds.prds) || []).map((prd) => [prd.id, prd]));
  const tasksByPrdId = new Map();
  listTasks(taskQueues).forEach((task) => {
    if (!task || !task.prdId || !prdIdSet.has(task.prdId)) {
      return;
    }
    const tasks = tasksByPrdId.get(task.prdId) || [];
    tasks.push(task);
    tasksByPrdId.set(task.prdId, tasks);
  });
  const prsByPrdId = new Map();
  ((prs && prs.pullRequests) || []).forEach((pr) => {
    if (!pr || !pr.prdId || !prdIdSet.has(pr.prdId)) {
      return;
    }
    const pullRequests = prsByPrdId.get(pr.prdId) || [];
    pullRequests.push(pr);
    prsByPrdId.set(pr.prdId, pullRequests);
  });

  return Array.from(prdIdSet).filter((prdId) => {
    const linkedPullRequests = prsByPrdId.get(prdId) || [];
    if (linkedPullRequests.length > 0) {
      return linkedPullRequests.every((pr) => String(pr.status || '') === 'merged');
    }

    const linkedTasks = tasksByPrdId.get(prdId) || [];
    if (linkedTasks.some((task) => !isTerminalTaskStatus(task.status))) {
      return false;
    }

    const prd = prdById.get(prdId);
    return Boolean(prd && prd.status === 'completed');
  });
}

function loadTrackedPrds(rootDir: string, config: AutonomyConfig, options: AnyRecord = {}): { prds: TrackedPrdRecord[] } {
  const taskQueues = (options.taskQueues as QueueMap) || readTaskQueues(rootDir, config);
  const prs = (options.prs as PrState) || readJson<PrState>(getAutonomyPaths(rootDir).prsState);
  const prdStateMap = readTrackedPrdStateMap(rootDir, config.integrationBranch);
  const tasksByPrdId = new Map();
  const prsByPrdId = new Map();

  listTasks(taskQueues).forEach((task) => {
    if (!task || !task.prdId) {
      return;
    }
    const tasks = tasksByPrdId.get(task.prdId) || [];
    tasks.push(task);
    tasksByPrdId.set(task.prdId, tasks);
  });
  ((prs && prs.pullRequests) || []).forEach((pr) => {
    if (!pr || !pr.prdId) {
      return;
    }
    const pullRequests = prsByPrdId.get(pr.prdId) || [];
    pullRequests.push(pr);
    prsByPrdId.set(pr.prdId, pullRequests);
  });

  return {
    prds: listTrackedPrdSpecs(rootDir, config.integrationBranch).map((entry) => {
      const trackedState = prdStateMap.get(entry.spec.id) || null;
      const linkedTasks = tasksByPrdId.get(entry.spec.id) || [];
      const linkedPullRequests = prsByPrdId.get(entry.spec.id) || [];
      const plannedTaskIds = trackedState && Array.isArray(trackedState.plannedTaskIds) && trackedState.plannedTaskIds.length > 0
        ? trackedState.plannedTaskIds.slice()
        : linkedTasks.map((task) => task.id);
      let status = 'queued';
      if (trackedState && (trackedState.status === 'planning' || trackedState.status === 'failed')) {
        status = trackedState.status;
      } else if (linkedPullRequests.length > 0 && linkedPullRequests.every((pr) => String(pr.status || '') === 'merged')) {
        status = 'completed';
      } else if ((trackedState && trackedState.status === 'planned') || plannedTaskIds.length > 0) {
        status = 'planned';
      } else if (entry.isQueued) {
        status = 'queued';
      }
      return {
        ...entry.spec,
        status,
        plannedTaskIds: plannedTaskIds.length > 0 ? plannedTaskIds : undefined,
        lastError: trackedState && trackedState.lastError ? trackedState.lastError : undefined,
        updatedAt: trackedState && trackedState.updatedAt ? trackedState.updatedAt : entry.spec.createdAt,
      };
    }),
  };
}

function archiveCompletedPrdSpecs(rootDir, state) {
  const currentSpecs = state && state.config && state.config.integrationBranch
    ? listTrackedPrdSpecs(rootDir, state.config.integrationBranch).map((entry) => ({
      id: entry.spec.id,
      fileName: path.basename(entry.relativePath),
      filePath: path.join(rootDir, entry.relativePath),
      relativePath: entry.relativePath,
      spec: entry.spec,
    }))
    : [
      ...listCurrentPrdSpecEntries(rootDir),
      ...listQueuedPrdSpecEntries(rootDir),
    ].map((entry) => ({
      ...entry,
      relativePath: path.relative(rootDir, entry.filePath),
      spec: readJson<PrdSpecPayload>(entry.filePath, {} as PrdSpecPayload),
    }));
  const archivableIds = new Set(findArchivablePrdIds(
    currentSpecs.map((entry) => entry.id),
    state
  ));

  if (archivableIds.size === 0) {
    return [];
  }

  ensureDir(getArchivedPrdSpecsDir(rootDir));
  const archivableEntries = currentSpecs.filter((entry) => archivableIds.has(entry.id));
  if (state && state.config && state.config.integrationBranch) {
    const trackedUpdates = [];
    archivableEntries.forEach((entry) => {
      const destinationPath = path.join(getArchivedPrdSpecsDir(rootDir), entry.fileName);
      trackedUpdates.push({
        relativePath: path.relative(rootDir, destinationPath),
        content: entry.spec,
      });
      trackedUpdates.push({
        relativePath: entry.relativePath,
        delete: true,
      });
      trackedUpdates.push({
        relativePath: buildPrdStateRelativePath(entry.id),
        delete: true,
      });
    });
    commitTrackedFilesToIntegrationBranch(rootDir, state.config.integrationBranch, trackedUpdates, {
      commitMessage: `autonomy(specs): archive completed prd${archivableEntries.length === 1 ? '' : 's'}`,
    });
  }

  const archived = [];
  archivableEntries.forEach((entry) => {
    const destinationPath = path.join(getArchivedPrdSpecsDir(rootDir), entry.fileName);
    if (fs.existsSync(entry.filePath)) {
      ensureDir(path.dirname(destinationPath));
      fs.renameSync(entry.filePath, destinationPath);
    }
    const prdStatePath = path.join(rootDir, buildPrdStateRelativePath(entry.id));
    fs.rmSync(prdStatePath, { force: true });
    archived.push({
      id: entry.id,
      from: entry.relativePath,
      to: path.relative(rootDir, destinationPath),
    });
  });
  return archived;
}

function ensureInitialized(rootDir) {
  const paths = getAutonomyPaths(rootDir);
  if (!fs.existsSync(paths.agentsConfig)) {
    throw new Error(`Autonomy v2 is not initialized under ${paths.repoAutonomyDir}. Run "autonomy-v2 init".`);
  }
}

function loadAllState(rootDir: string): {
  config: AutonomyConfig;
  sprint: AnyRecord;
  taskQueues: QueueMap;
  prs: PrState;
  branchLocks: BranchLocksState;
} {
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  return {
    config,
    sprint: readJson(paths.sprintConfig),
    taskQueues: readTaskQueues(rootDir, config),
    prs: readJson<PrState>(paths.prsState),
    branchLocks: readJson<BranchLocksState>(paths.branchLocksState),
  };
}

function syncIntegrationSpecs(rootDir: string, options: AnyRecord = {}) {
  if (options.sync !== true) {
    return null;
  }
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  return syncPrdSpecsFromIntegrationBranch(rootDir, config.integrationBranch);
}

function readJson<T = any>(filePath: string, fallbackValue?: T): T {
  if (!fs.existsSync(filePath)) {
    if (arguments.length >= 2) {
      return JSON.parse(JSON.stringify(fallbackValue)) as T;
    }
    throw new Error(`Missing JSON file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getAgentLogPath(rootDir, agentId) {
  return path.join(rootDir, ...DEFAULT_RUNTIME_SEGMENTS, 'agents', agentId, 'log.md');
}

function appendAgentLog(rootDir: string, config: AutonomyConfig, agentId: string, event: string, payload: AnyRecord = {}) {
  getAgent(config, agentId);
  const logPath = getAgentLogPath(rootDir, agentId);
  ensureDir(path.dirname(logPath));
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${agentId} Log\n`, 'utf8');
  }

  const lines = [
    '',
    `## ${new Date().toISOString()} ${event}`,
  ];

  if (payload.summary) {
    lines.push(payload.summary);
  }

  appendLogSection(lines, 'Input', payload.input);
  appendLogSection(lines, 'Output', payload.output);
  fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
}

function appendLogSection(lines, heading, value) {
  if (typeof value === 'undefined') {
    return;
  }

  lines.push(`### ${heading}`);
  if (typeof value === 'string') {
    lines.push('```text');
    lines.push(value);
    lines.push('```');
    return;
  }

  lines.push('```json');
  lines.push(JSON.stringify(value, null, 2));
  lines.push('```');
}

function getAgentPersona(agent) {
  return agent.personaName || agent.id;
}

function buildPersonaTag(agent) {
  return `[${getAgentPersona(agent)}]`;
}

function ensurePrefixed(value, prefix) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return prefix;
  }
  return trimmed.startsWith(`${prefix} `) ? trimmed : `${prefix} ${trimmed}`;
}

function buildPersonaPrTitle(agent, title) {
  return ensurePrefixed(title, buildPersonaTag(agent));
}

function buildPersonaPrBody(agent, task, sprint, body) {
  const trimmedBody = String(body || '').trim();
  const metadata = [
    '<!-- autonomy-persona -->',
    `Agent: ${getAgentPersona(agent)}`,
    `Task: ${task.id}`,
    `Scope: ${(agent.include || []).join(', ') || 'repo-scoped'}`,
    `Run: ${task.sprintId || sprint.sprintId || 'shared'}`,
  ].join('\n');

  if (!trimmedBody) {
    return metadata;
  }

  return `${trimmedBody}\n\n${metadata}`;
}

function buildSignedReviewSummary(agent, summary) {
  const trimmed = String(summary || '').trim();
  const signature = `${agent.commentSignature || getAgentPersona(agent)}:`;
  if (!trimmed) {
    return signature;
  }
  return trimmed.startsWith(signature) ? trimmed : `${signature}\n\n${trimmed}`;
}

function buildMergeCommitTitle(actor, pr) {
  return `${buildPersonaTag(actor)} merge ${pr.title}`;
}

function buildPullRequestLabels(agent, baseBranch) {
  const labels = new Set();
  labels.add(`agent:${slugify(getAgentPersona(agent)).replace(/-agent$/, '')}`);
  labels.add(`target:${slugify(baseBranch)}`);
  for (const label of agent.prLabels || []) {
    if (label) {
      labels.add(label);
    }
  }
  return Array.from(labels);
}

function configureWorktreeGitIdentity(worktreePath, agent) {
  if (!agent.gitIdentity) {
    return;
  }

  runGit(worktreePath, ['config', 'extensions.worktreeConfig', 'true']);
  if (agent.gitIdentity.name) {
    runGit(worktreePath, ['config', '--worktree', 'user.name', agent.gitIdentity.name]);
  }
  if (agent.gitIdentity.email) {
    runGit(worktreePath, ['config', '--worktree', 'user.email', agent.gitIdentity.email]);
  }
}

function getAgent(config, agentId) {
  const agent = (config.agents || []).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent "${agentId}".`);
  }
  return agent;
}

function getPr(prState, prId) {
  const pr = prState.pullRequests.find((candidate) => candidate.id === prId);
  if (!pr) {
    throw new Error(`Unknown PR "${prId}".`);
  }
  return pr;
}

function getStringOption(options, key, fallbackValue = '') {
  if (!Object.prototype.hasOwnProperty.call(options, key)) {
    return fallbackValue;
  }
  const value = options[key];
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (value[index] !== true) {
        return String(value[index]);
      }
    }
    return fallbackValue;
  }
  if (value === true) {
    return fallbackValue;
  }
  return String(value);
}

function requireOption(options, key) {
  const value = getStringOption(options, key, '');
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function getListOption(options, key) {
  if (!Object.prototype.hasOwnProperty.call(options, key)) {
    return [];
  }

  const raw = Array.isArray(options[key]) ? options[key] : [options[key]];
  return raw
    .filter((value) => value !== true)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function printOutput(options, payload, printer) {
  if (options.json === true) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printer();
}

function countBy(items, key) {
  return items.reduce((accumulator, item) => {
    const value = item[key] || 'unknown';
    accumulator[value] = (accumulator[value] || 0) + 1;
    return accumulator;
  }, {});
}

function formatCountSummary(counts) {
  return Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function normalizeLaneKey(record) {
  if (!record) {
    return '';
  }
  if (record.laneKey) {
    return String(record.laneKey);
  }
  if (record.prdId && record.agentId) {
    return `${record.prdId}:${record.agentId}`;
  }
  return '';
}

function buildAgentStatusSummaries({ rootDir, config, taskQueues, prs, branchLocks, runtime, prds }) {
  const prById = new Map((prs.pullRequests || []).map((pr) => [pr.id, pr]));
  const branchLockByLane = new Map(
    (branchLocks.locks || [])
      .map((lock) => [normalizeLaneKey(lock), lock])
      .filter(([laneKey]) => laneKey)
  );

  return (config.agents || []).map((agent) => {
    const queue = getTaskQueue(taskQueues, config, agent.id);
    const worker = ((runtime && runtime.workers) || {})[agent.id] || {
      agentId: agent.id,
      status: 'idle',
      pid: null,
    };
    if (isPmRole(agent.role)) {
      return buildPmAgentStatus(agent, worker, prds);
    }
    if (isReviewRole(agent.role)) {
      return buildReviewAgentStatus(agent, queue, worker, prById);
    }
    return buildImplementationAgentStatus(rootDir, config, branchLocks, agent, queue, worker, prById, branchLockByLane);
  });
}

function buildPmAgentStatus(agent, worker, prds) {
  const pendingPrds = (prds.prds || []).filter((prd) => ['planned', 'queued', 'planning'].includes(prd.status));
  let detail = 'no PRDs awaiting planning';
  if (pendingPrds.length > 0) {
    const label = `${pendingPrds.length} PRD${pendingPrds.length === 1 ? '' : 's'} awaiting planning`;
    detail = worker.status === 'running'
      ? `planning backlog (${label})`
      : label;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }
  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
  };
}

function buildImplementationAgentStatus(rootDir, config, branchLocksState, agent, queue, worker, prById, branchLockByLane) {
  const resolvedQueueState = resolveImplementationStatusQueue(rootDir, config, branchLocksState, agent, queue);
  const tasks = (resolvedQueueState.queue && resolvedQueueState.queue.tasks) || [];
  const activeTask = selectImplementationTaskForStatus(tasks);
  const extraCount = countAdditionalPendingTasks(tasks, activeTask && activeTask.id);
  const branch = resolvedQueueState.branch || (activeTask ? resolveTaskBranch(activeTask, prById, branchLockByLane) : null);

  let detail = 'no queued tasks';
  if (activeTask) {
    const taskState = getImplementationTaskState(activeTask);
    const prefix = worker.status === 'running'
      ? (taskState === 'active'
        ? 'working on'
        : 'starting')
      : taskState === 'active'
        ? 'current task'
      : (activeTask.type === 'review_followup' ? `queued ${getRoleLabel(AGENT_ROLES.REVIEW)} follow-up` : 'next task');
    detail = `${prefix} ${describeImplementationTask(activeTask)}`;
  }
  if (extraCount > 0) {
    detail = `${detail} | ${extraCount} more queued`;
  }
  if (branch) {
    detail = `${detail} | branch=${branch}`;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }

  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
    activeTaskId: activeTask ? activeTask.id : null,
    branch,
  };
}

function resolveImplementationStatusQueue(rootDir, config, branchLocksState, agent, fallbackQueue) {
  const branchQueueState = readLatestImplementationBranchQueue(rootDir, config, branchLocksState, agent, fallbackQueue);
  if (branchQueueState) {
    return branchQueueState;
  }
  return {
    queue: filterCompletedImplementationQueueTasks(fallbackQueue, branchLocksState, agent.id),
    branch: null,
    worktreePath: null,
  };
}

function readLatestImplementationBranchQueue(rootDir, config, branchLocksState, agent, fallbackQueue) {
  const agentId = agent.id;
  const locks = ((branchLocksState && branchLocksState.locks) || [])
    .filter((lock) => lock && lock.agentId === agentId)
    .slice()
    .sort((left, right) => {
      return (Date.parse(right && right.updatedAt || '') || 0) - (Date.parse(left && left.updatedAt || '') || 0);
    });

  for (const lock of locks) {
    const queueState = readImplementationQueueSnapshot(rootDir, config, agentId, {
      branch: lock.branch || null,
      worktreePath: lock.worktreePath || null,
    });
    if (!queueState) {
      continue;
    }
    const pendingTasks = (queueState.tasks || []).filter((task) => !isTerminalTaskStatus(getImplementationTaskState(task)));
    if (pendingTasks.length > 0) {
      return {
        queue: queueState,
        branch: lock.branch || null,
        worktreePath: lock.worktreePath,
      };
    }
  }

  const branchTasks = (fallbackQueue && Array.isArray(fallbackQueue.tasks) ? fallbackQueue.tasks : [])
    .filter((task) => !isTerminalTaskStatus(getImplementationTaskState(task)))
    .slice()
    .sort((left, right) => {
      const rankDiff = rankImplementationTaskForStatus(left) - rankImplementationTaskForStatus(right);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    });

  for (const task of branchTasks) {
    const branch = resolveImplementationBranchRef(rootDir, config, branchLocksState, task.agentId, buildTaskLaneKey(task), {
      task,
    });
    if (!branch) {
      continue;
    }
    const queueState = readImplementationQueueSnapshot(rootDir, config, agentId, {
      branch,
      worktreePath: buildWorktreePath(rootDir, config, task),
    });
    if (!queueState) {
      continue;
    }
    const pendingTasks = (queueState.tasks || []).filter((candidate) => !isTerminalTaskStatus(getImplementationTaskState(candidate)));
    if (pendingTasks.length > 0) {
      return {
        queue: queueState,
        branch,
        worktreePath: fs.existsSync(buildWorktreePath(rootDir, config, task))
          ? buildWorktreePath(rootDir, config, task)
          : null,
      };
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

function buildReviewAgentStatus(agent, queue, worker, prById) {
  const tasks = queue.tasks || [];
  const assignedTask = tasks.find((task) => task.status === 'assigned') || null;
  const queuedTask = tasks.find((task) => task.status === 'queued') || null;
  const blockedTask = tasks.find((task) => task.status === 'changes_requested') || null;
  const failedTask = tasks.find((task) => task.status === 'failed') || null;
  const extraCount = countAdditionalPendingTasks(
    tasks.filter((task) => ['assigned', 'queued', 'changes_requested', 'failed'].includes(task.status)),
    (assignedTask || queuedTask || blockedTask || failedTask || {}).id
  );

  let detail = `no ${getRoleLabel(AGENT_ROLES.REVIEW)} tasks`;
  if (worker.status === 'running' && (assignedTask || queuedTask)) {
    detail = `${assignedTask ? `${getRoleLabel(AGENT_ROLES.REVIEW)}ing` : `starting ${getRoleLabel(AGENT_ROLES.REVIEW)} of`} ${describeReviewTask(assignedTask || queuedTask, prById)}`;
  } else if (queuedTask) {
    detail = `next ${getRoleLabel(AGENT_ROLES.REVIEW)} ${describeReviewTask(queuedTask, prById)}`;
  } else if (blockedTask) {
    const pr = blockedTask.prId ? prById.get(blockedTask.prId) : null;
    detail = `waiting for ${blockedTask.sourceAgentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to address ${describeReviewTarget(pr, blockedTask.prId)}`;
  } else if (failedTask) {
    detail = `failed ${getRoleLabel(AGENT_ROLES.REVIEW)} ${describeReviewTask(failedTask, prById)}`;
  }
  if (extraCount > 0) {
    detail = `${detail} | ${extraCount} more pending`;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }

  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
    activeTaskId: assignedTask ? assignedTask.id : queuedTask ? queuedTask.id : null,
  };
}

function buildPullRequestStatusSummaries({ taskQueues, prs, runtime, branchLocks }) {
  const workerByAgentId = new Map(Object.entries(((runtime && runtime.workers) || {})));
  const branchLockByLane = new Map(
    ((branchLocks && branchLocks.locks) || [])
      .map((lock) => [normalizeLaneKey(lock), lock])
      .filter(([laneKey]) => laneKey)
  );
  const tasksByPrId = new Map();
  listTasks(taskQueues).forEach((task) => {
    if (!task || !task.prId) {
      return;
    }
    const linked = tasksByPrId.get(task.prId) || [];
    linked.push(task);
    tasksByPrId.set(task.prId, linked);
  });

  return ((prs && prs.pullRequests) || [])
    .filter((pr) => isActivePullRequest(pr))
    .sort(comparePullRequestStatuses)
    .map((pr) => {
      const linkedTasks = tasksByPrId.get(pr.id) || [];
      const reviewTask = linkedTasks.find((task) => task.type === TASK_TYPES.REVIEW) || null;
      const implementationTask = selectImplementationTaskForStatus(
        linkedTasks.filter((task) => task.type !== TASK_TYPES.REVIEW)
      );
      return {
        prId: pr.id,
        number: pr.remote && pr.remote.number ? Number(pr.remote.number) : null,
        title: pr.title || pr.id,
        status: String(pr.status || 'open'),
        branch: pr.headBranch || resolveTaskBranch(implementationTask, new Map(), branchLockByLane) || null,
        action: describePullRequestAction(pr, reviewTask, implementationTask, workerByAgentId),
        url: pr.remote && pr.remote.url ? pr.remote.url : null,
        updatedAt: pr.updatedAt || '',
      };
    });
}

function isActivePullRequest(pr) {
  if (!pr) {
    return false;
  }
  if (String(pr.status || '') === 'merged') {
    return false;
  }
  if (pr.remote && pr.remote.mergedAt) {
    return false;
  }
  return true;
}

function comparePullRequestStatuses(left, right) {
  const leftTime = Date.parse(left && left.updatedAt || '') || 0;
  const rightTime = Date.parse(right && right.updatedAt || '') || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const leftNumber = Number(left && left.remote && left.remote.number) || 0;
  const rightNumber = Number(right && right.remote && right.remote.number) || 0;
  if (leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function describePullRequestAction(pr, reviewTask, implementationTask, workerByAgentId) {
  if (implementationTask) {
    return describePullRequestImplementationAction(
      implementationTask,
      workerByAgentId.get(implementationTask.agentId) || null
    );
  }
  if (reviewTask) {
    return describePullRequestReviewAction(pr, reviewTask, workerByAgentId.get('reviewer') || null);
  }
  if (String(pr.status || '') === 'changes_requested') {
    return `waiting for ${pr.agentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to respond to ${getRoleLabel(AGENT_ROLES.REVIEW)}`;
  }
  if (String(pr.status || '') === 'approved') {
    return 'approved, waiting for merge';
  }
  if (String(pr.status || '') === 'conflicted') {
    return `waiting for ${pr.agentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to resolve merge conflict`;
  }
  return 'waiting for reviewer';
}

function describePullRequestImplementationAction(task, worker) {
  const agentId = task.agentId || `${AGENT_ROLES.IMPLEMENTATION}-agent`;
  const taskState = getImplementationTaskState(task);
  const isRunning = Boolean(
    worker
      && worker.status === 'running'
      && taskState === 'active'
  );
  if (task.type === 'review_followup') {
    return isRunning
      ? `${agentId} responding to ${getRoleLabel(AGENT_ROLES.REVIEW)}`
      : `waiting for ${agentId} to respond to ${getRoleLabel(AGENT_ROLES.REVIEW)}`;
  }
  if (task.type === 'conflict_resolution') {
    return isRunning
      ? `${agentId} resolving merge conflict`
      : `waiting for ${agentId} to resolve merge conflict`;
  }
  return isRunning
    ? `${agentId} updating the PR`
    : `waiting for ${agentId}`;
}

function describePullRequestReviewAction(pr, reviewTask, reviewerWorker) {
  if (reviewTask.status === 'assigned') {
    return reviewerWorker && reviewerWorker.status === 'running'
      ? `${getRoleLabel(AGENT_ROLES.REVIEW)}er ${getRoleLabel(AGENT_ROLES.REVIEW)}ing`
      : `${getRoleLabel(AGENT_ROLES.REVIEW)}er assigned`;
  }
  if (reviewTask.status === 'queued') {
    if (String(pr.status || '') === 'approved') {
      return reviewerWorker && reviewerWorker.status === 'running'
        ? `${getRoleLabel(AGENT_ROLES.REVIEW)}er retrying merge`
        : `waiting for ${getRoleLabel(AGENT_ROLES.REVIEW)}er merge follow-up`;
    }
    return reviewerWorker && reviewerWorker.status === 'running'
      ? `${getRoleLabel(AGENT_ROLES.REVIEW)}er ${getRoleLabel(AGENT_ROLES.REVIEW)}ing`
      : `waiting for ${getRoleLabel(AGENT_ROLES.REVIEW)}er`;
  }
  if (reviewTask.status === 'changes_requested') {
    return `waiting for ${reviewTask.sourceAgentId || pr.agentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to respond to ${getRoleLabel(AGENT_ROLES.REVIEW)}`;
  }
  if (reviewTask.status === 'blocked_conflict') {
    return `waiting for ${reviewTask.sourceAgentId || pr.agentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to resolve merge conflict`;
  }
  if (reviewTask.status === 'approved') {
    return 'approved, waiting for merge';
  }
  return `${getRoleLabel(AGENT_ROLES.REVIEW)} status: ${formatStatusLabel(reviewTask.status)}`;
}

function formatPullRequestStatusLine(prStatus) {
  const numberLabel = prStatus.number ? `PR #${prStatus.number}` : `PR ${prStatus.prId}`;
  return `${numberLabel} | ${formatStatusLabel(prStatus.status)} | ${prStatus.title} | ${prStatus.action}`;
}

function formatStatusLabel(status) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

function selectImplementationTaskForStatus(tasks) {
  const pendingTasks = (tasks || []).filter((task) => !isTerminalTaskStatus(task.status));
  if (pendingTasks.length === 0) {
    return null;
  }
  return pendingTasks
    .slice()
    .sort((left, right) => {
      const rankDiff = rankImplementationTaskForStatus(left) - rankImplementationTaskForStatus(right);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    })[0];
}

function rankImplementationTaskForStatus(task) {
  const taskState = getImplementationTaskState(task);
  if (taskState === 'active') {
    return 0;
  }
  if (taskState === 'queued') {
    return task.type === 'review_followup'
      ? 1
      : task.type === 'conflict_resolution'
        ? 2
        : 3;
  }
  if (task.type === 'review_followup') {
    return 4;
  }
  if (task.type === 'conflict_resolution') {
    return 5;
  }
  return 10;
}

function countAdditionalPendingTasks(tasks, primaryTaskId) {
  const pendingCount = (tasks || []).filter((task) => !isTerminalTaskStatus(task.status)).length;
  if (!primaryTaskId) {
    return pendingCount;
  }
  return Math.max(0, pendingCount - 1);
}

function isTerminalTaskStatus(status) {
  return ['merged', 'approved', 'done'].includes(String(status || ''));
}

function resolveTaskBranch(task, prById, branchLockByLane) {
  if (task && task.branch) {
    return task.branch;
  }
  if (task && task.execution && task.execution.branch) {
    return task.execution.branch;
  }
  if (task && task.laneKey && branchLockByLane.has(task.laneKey)) {
    return branchLockByLane.get(task.laneKey).branch || null;
  }
  if (task && task.prId && prById.has(task.prId)) {
    return prById.get(task.prId).headBranch || null;
  }
  return null;
}

function describeImplementationTask(task) {
  const typeLabel = task.type === 'review_followup'
    ? `${getRoleLabel(AGENT_ROLES.REVIEW)} follow-up`
    : task.type === 'conflict_resolution'
      ? 'conflict resolution'
      : 'task';
  return `${typeLabel} "${task.title}" (${task.id})`;
}

function describeReviewTask(task, prById) {
  const pr = task && task.prId ? prById.get(task.prId) : null;
  return `${describeReviewTarget(pr, task && task.prId)} from ${task && task.sourceAgentId ? task.sourceAgentId : 'unknown source'}`;
}

function describeReviewTarget(pr, fallbackPrId) {
  const prLabel = pr && pr.remote && pr.remote.number
    ? `PR #${pr.remote.number}`
    : `PR ${fallbackPrId || (pr && pr.id) || 'unknown'}`;
  const prTitle = pr && pr.title ? pr.title : '';
  return prTitle ? `${prLabel} "${prTitle}"` : prLabel;
}

function summarizeStatusText(value, maxLength = 120) {
  const summary = String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
  if (summary.length <= maxLength) {
    return summary;
  }
  return `${summary.slice(0, maxLength - 1)}…`;
}

function formatAgentStatusLine(agentStatus: AnyRecord, options: AnyRecord = {}) {
  const parts = [
    agentStatus.agentId,
    agentStatus.role,
    agentStatus.workerStatus,
  ];
  if (options.includePid === true) {
    parts.push(`pid=${agentStatus.pid || '-'}`);
  }
  if (agentStatus.detail) {
    parts.push(agentStatus.detail);
  }
  return parts.join(' | ');
}

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

function resolvePrRecordTask(rootDir, state, taskId) {
  const liveTask = findTask(state.taskQueues, taskId);
  if (liveTask) {
    return liveTask;
  }
  const branchTask = findImplementationTaskInBranchQueues(rootDir, state.config, state.branchLocks, taskId);
  if (branchTask) {
    return branchTask;
  }
  const completedTask = findCompletedTask(state.branchLocks, taskId);
  if (completedTask) {
    return completedTask;
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function resolveTaskForWorktreePreparation(rootDir, state, taskId) {
  const liveTask = findTask(state.taskQueues, taskId);
  if (liveTask) {
    return liveTask;
  }
  const completedTask = findCompletedTask(state.branchLocks, taskId);
  if (completedTask) {
    return completedTask;
  }
  const branchTask = findImplementationTaskInBranchQueues(rootDir, state.config, state.branchLocks, taskId);
  if (branchTask) {
    return branchTask;
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function findCompletedTask(branchLocksState, taskId) {
  for (const branchLock of (branchLocksState && branchLocksState.locks) || []) {
    const task = ((branchLock && branchLock.completedTasks) || []).find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

function findImplementationTaskInBranchQueues(rootDir, config, branchLocksState, taskId) {
  const locks = ((branchLocksState && branchLocksState.locks) || [])
    .slice()
    .sort((left, right) => {
      return (Date.parse(right && right.updatedAt || '') || 0) - (Date.parse(left && left.updatedAt || '') || 0);
    });

  for (const lock of locks) {
    if (!lock || !lock.agentId) {
      continue;
    }
    const queueState = readImplementationQueueSnapshot(rootDir, config, lock.agentId, {
      branch: lock.branch || null,
      worktreePath: lock.worktreePath || null,
    });
    if (!queueState) {
      continue;
    }
    const task = (queueState.tasks || []).find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
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

function listLaneTasks(taskQueues: QueueMap, agentId: string, laneKey: string): TaskRecord[] {
  return Object.values(taskQueues)
    .filter((queue) => queue.agentId === agentId)
    .flatMap((queue) => queue.tasks)
    .filter((task) => buildTaskLaneKey(task) === laneKey);
}

function findLatestCompletedLaneTask(branchLocksState, agentId, laneKey) {
  const completedLaneTasks = listCompletedLaneTasks(branchLocksState, agentId, laneKey);
  return completedLaneTasks.length > 0
    ? completedLaneTasks[completedLaneTasks.length - 1]
    : null;
}

function buildImplementationLaneSeedTask(config: AutonomyConfig, branchLocksState: BranchLocksState, taskQueues: QueueMap, agentId: string, laneKey: string, options: AnyRecord = {}) {
  if (options.task) {
    return options.task;
  }
  const liveLaneTasks = listLaneTasks(taskQueues, agentId, laneKey);
  if (liveLaneTasks.length > 0) {
    return liveLaneTasks[0];
  }
  const completedTask = findLatestCompletedLaneTask(branchLocksState, agentId, laneKey);
  if (completedTask) {
    return completedTask;
  }
  if (options.pr) {
    const seedTask: TaskRecord = {
      id: options.pr.taskId || `${agentId}-${laneKey}`,
      agentId,
      laneKey,
      sprintId: options.pr.sprintId || 'shared',
      baseBranch: options.pr.baseBranch || config.integrationBranch,
    };
    if (options.pr.prdId) {
      seedTask.prdId = options.pr.prdId;
    }
    return seedTask;
  }
  return null;
}

function resolveImplementationBranchRef(rootDir: string, config: AutonomyConfig, branchLocksState: BranchLocksState, agentId: string, laneKey: string, options: AnyRecord = {}) {
  const branchLock = findBranchLockByLane(branchLocksState, agentId, laneKey);
  const seedTask = buildImplementationLaneSeedTask(config, branchLocksState, {}, agentId, laneKey, options);
  const branchCandidates = uniqueStrings([
    options.branchHint,
    branchLock ? branchLock.branch : null,
    options.pr ? options.pr.headBranch : null,
    options.task ? options.task.branch : null,
    seedTask ? buildTaskBranchName(config, seedTask) : null,
  ]);

  return branchCandidates.find((candidate) => gitRefExists(rootDir, candidate)) || null;
}

function listImplementationLaneTasks(rootDir: string, state: AnyRecord, agentId: string, laneKey: string, options: AnyRecord = {}) {
  const seedTask = buildImplementationLaneSeedTask(state.config, state.branchLocks, state.taskQueues, agentId, laneKey, options);
  const branch = resolveImplementationBranchRef(rootDir, state.config, state.branchLocks, agentId, laneKey, {
    ...options,
    task: options.task || seedTask || null,
  });
  const branchLock = findBranchLockByLane(state.branchLocks, agentId, laneKey);
  const fallbackWorktreePath = seedTask
    ? buildWorktreePath(rootDir, state.config, seedTask)
    : null;
  const queueState = readImplementationQueueSnapshot(rootDir, state.config, agentId, {
    branch,
    worktreePath: branchLock && branchLock.worktreePath
      ? branchLock.worktreePath
      : fallbackWorktreePath,
  });
  if (!queueState) {
    return {
      tasks: listLaneTasks(state.taskQueues, agentId, laneKey),
      branch: null,
      worktreePath: branchLock ? branchLock.worktreePath || null : null,
      source: 'root',
      task: seedTask,
    };
  }
  return {
    tasks: (queueState.tasks || []).filter((task) => buildTaskLaneKey(task) === laneKey),
    branch,
    worktreePath: branchLock && branchLock.worktreePath
      ? branchLock.worktreePath
      : (fallbackWorktreePath && fs.existsSync(fallbackWorktreePath) ? fallbackWorktreePath : null),
    source: 'branch',
    task: seedTask,
  };
}

function listCompletedLaneTasks(branchLocksState, agentId, laneKey) {
  const branchLock = findBranchLockByLane(branchLocksState, agentId, laneKey);
  if (!branchLock || !Array.isArray(branchLock.completedTasks)) {
    return [];
  }
  return branchLock.completedTasks
    .slice()
    .sort((left, right) => String(left.completedAt || '').localeCompare(String(right.completedAt || '')));
}

function prepareTaskWorktree(rootDir: string, config: AutonomyConfig, branchLocksState: BranchLocksState, task: TaskRecord, options: AnyRecord = {}) {
  const agent = getAgent(config, task.agentId);
  if (!isImplementationRole(agent.role) && agent.role !== TASK_TYPES.CONFLICT) {
    throw new Error(`Agent "${agent.id}" does not use worktree preparation.`);
  }
  const create = options.create === true;
  const branchName = options.branchName || buildTaskBranchName(config, task);
  const worktreePath = options.worktreePath || buildWorktreePath(rootDir, config, task);
  let mode = create ? 'created' : 'planned';

  if (create) {
    const baseBranch = task.baseBranch || config.integrationBranch;
    const baseRef = resolveBaseRef(rootDir, baseBranch);
    ensureDir(path.dirname(worktreePath));
    const worktreeExists = fs.existsSync(worktreePath);
    const branchExists = gitRefExists(rootDir, branchName);

    if (!worktreeExists && branchExists) {
      runGitWorktreeAdd(rootDir, [worktreePath, branchName], worktreePath);
      mode = 'reused-branch';
    } else if (!worktreeExists) {
      runGitWorktreeAdd(rootDir, ['-b', branchName, worktreePath, baseRef], worktreePath);
      mode = 'created';
    } else if (!isGitWorktree(worktreePath)) {
      throw new Error(`Worktree path "${worktreePath}" exists but is not a git worktree.`);
    } else {
      mode = 'reused-worktree';
    }
    configureWorktreeGitIdentity(worktreePath, agent);
  }

  upsertBranchLock(branchLocksState, {
    taskId: task.id,
    laneKey: buildTaskLaneKey(task),
    agentId: task.agentId,
    branch: branchName,
    worktreePath,
    baseBranch: task.baseBranch || config.integrationBranch,
    mode,
    updatedAt: new Date().toISOString(),
  });

  return {
    taskId: task.id,
    branch: branchName,
    worktreePath,
    mode,
  };
}

function getPrimaryReviewer(config) {
  const reviewer = (config.agents || []).find((agent) => isReviewRole(agent.role));
  if (!reviewer) {
    throw new Error('No reviewer agent configured.');
  }
  return reviewer;
}

function buildReviewerTaskId(pr) {
  return `${getRoleLabel(AGENT_ROLES.REVIEW)}-${pr.id}`;
}

function ensureReviewerTask(taskQueues, config, pr, sourceTask, now) {
  const reviewer = getPrimaryReviewer(config);
  const reviewerQueue = getTaskQueue(taskQueues, config, reviewer.id);
  const reviewTaskId = buildReviewerTaskId(pr);
  let reviewTask = reviewerQueue.tasks.find((candidate) => candidate.id === reviewTaskId);
  if (!reviewTask) {
    reviewTask = {
      id: reviewTaskId,
      title: `Review ${pr.title}`,
      description: `Review ${pr.id} for ${sourceTask.title}`,
      agentId: reviewer.id,
      type: TASK_TYPES.REVIEW,
      prId: pr.id,
      sourceTaskId: sourceTask.id,
      sourceAgentId: sourceTask.agentId,
      reviewRound: (pr.reviews || []).length + 1,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    reviewerQueue.tasks.push(reviewTask);
  }
  return reviewTask;
}

function queueReviewerTask(taskQueues, config, pr, sourceTask, now) {
  const reviewerTask = ensureReviewerTask(taskQueues, config, pr, sourceTask, now);
  reviewerTask.title = `Review ${pr.title}`;
  reviewerTask.description = `Review ${pr.id} for ${sourceTask.title}`;
  reviewerTask.headBranch = pr.headBranch;
  reviewerTask.baseBranch = pr.baseBranch;
  reviewerTask.sourceTaskId = sourceTask.id;
  reviewerTask.sourceAgentId = sourceTask.agentId;
  reviewerTask.acceptance = sourceTask.acceptance || [];
  reviewerTask.scopeViolations = (pr.scopeViolations || []).slice();
  reviewerTask.reviewRound = (pr.reviews || []).length + 1;
  reviewerTask.status = 'queued';
  reviewerTask.updatedAt = now;
  return reviewerTask;
}

function getReviewerTask(taskQueues, config, pr) {
  const reviewer = (config.agents || []).find((agent) => isReviewRole(agent.role));
  if (!reviewer) {
    return null;
  }
  const reviewerQueue = getTaskQueue(taskQueues, config, reviewer.id);
  return reviewerQueue.tasks.find((candidate) => candidate.id === buildReviewerTaskId(pr)) || null;
}

function enqueueLaneFollowupTask(taskQueues, config, pr, patch) {
  const queue = getTaskQueue(taskQueues, config, pr.agentId);
  const taskId = patch.id;
  let task = queue.tasks.find((candidate) => candidate.id === taskId);
  const nextDescription = String(
    patch.description
      || (task && task.description)
      || `Address ${getRoleLabel(AGENT_ROLES.REVIEW)}er feedback for ${pr.title}`
  ).trim();
  if (!task) {
    task = {
      id: taskId,
      title: patch.title,
      description: nextDescription,
      agentId: pr.agentId,
      prdId: pr.prdId || undefined,
      laneKey: pr.laneKey || pr.taskId,
      type: patch.type || TASK_TYPES.DEFAULT,
      sprintId: pr.sprintId || 'shared',
      baseBranch: pr.baseBranch,
      checks: [],
      acceptance: buildReviewFollowupAcceptance(pr, nextDescription),
      status: 'queued',
      createdAt: patch.createdAt || new Date().toISOString(),
      updatedAt: patch.updatedAt || new Date().toISOString(),
      prId: pr.id,
    };
    if (!task.prdId) {
      delete task.prdId;
    }
    queue.tasks.push(task);
    return task;
  }

  task.title = patch.title || task.title;
  task.description = nextDescription;
  task.type = patch.type || task.type;
  task.acceptance = buildReviewFollowupAcceptance(pr, nextDescription, task.acceptance);
  task.status = 'queued';
  task.updatedAt = patch.updatedAt || new Date().toISOString();
  task.prId = pr.id;
  return task;
}

function buildLaneFollowupTaskId(pr) {
  return `${pr.agentId}-followup-${pr.id}-${(pr.reviews || []).length}`;
}

function buildLaneConflictTaskId(pr) {
  const conflictCount = Array.isArray(pr.conflicts) ? pr.conflicts.length + 1 : 1;
  return `${pr.agentId}-conflict-${pr.id}-${conflictCount}`;
}

function ensureImplementationLaneWorktree(rootDir: string, state: AnyRecord, pr: PullRequestRecord, options: AnyRecord = {}) {
  const agent = getAgent(state.config, pr.agentId);
  if (!isImplementationRole(agent.role)) {
    throw new Error(`Agent "${agent.id}" does not use tracked ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} queues.`);
  }
  const laneKey = pr.laneKey || pr.taskId;
  const laneContext = listImplementationLaneTasks(rootDir, state, pr.agentId, laneKey, {
    pr,
    task: options.task || null,
  });
  const seedTask = laneContext.task || buildImplementationLaneSeedTask(
    state.config,
    state.branchLocks,
    state.taskQueues,
    pr.agentId,
    laneKey,
    { pr, task: options.task || null }
  );
  if (!seedTask) {
    throw new Error(`Unable to resolve lane task state for ${pr.id}.`);
  }
  const branch = laneContext.branch || resolveImplementationBranchRef(
    rootDir,
    state.config,
    state.branchLocks,
    pr.agentId,
    laneKey,
    { pr, task: seedTask }
  );
  if (!branch) {
    throw new Error(`Unable to resolve ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} branch for lane "${laneKey}".`);
  }

  const preparedTask = {
    ...seedTask,
    id: seedTask.id || pr.taskId,
    agentId: pr.agentId,
    laneKey,
    sprintId: seedTask.sprintId || pr.sprintId || 'shared',
    baseBranch: seedTask.baseBranch || pr.baseBranch || state.config.integrationBranch,
  };
  if (pr.prdId && !preparedTask.prdId) {
    preparedTask.prdId = pr.prdId;
  }

  const payload = prepareTaskWorktree(rootDir, state.config, state.branchLocks, preparedTask, {
    create: true,
    branchName: branch,
    worktreePath: laneContext.worktreePath || buildWorktreePath(rootDir, state.config, preparedTask),
  });
  writeJson(getAutonomyPaths(rootDir).branchLocksState, state.branchLocks);
  return payload;
}

function appendTrackedBranchFollowupTask(rootDir, state, pr, patch) {
  const agent = getAgent(state.config, pr.agentId);
  if (!isImplementationRole(agent.role)) {
    return null;
  }
  const baseTask = findTask(state.taskQueues, pr.taskId)
    || findCompletedTask(state.branchLocks, pr.taskId)
    || null;
  const worktree = ensureImplementationLaneWorktree(rootDir, state, pr, { task: baseTask });

  const relativePath = agent.taskQueue;
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Implementation queue for "${agent.id}" must be repo-relative inside the worktree.`);
  }
  const queuePath = path.join(worktree.worktreePath, relativePath);
  const queueState = fs.existsSync(queuePath)
    ? readJson(queuePath)
    : buildTaskQueueState(agent, []);
  const tasks = Array.isArray(queueState.tasks) ? queueState.tasks : [];
  const taskId = patch.id;
  const nextDescription = String(
    patch.description
      || `Address reviewer feedback for ${pr.title}`
  ).trim();
  let task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    const hasActiveTask = tasks.some((candidate) => getImplementationTaskState(candidate) === 'active');
    task = {
      id: taskId,
      title: patch.title,
      description: nextDescription,
      agentId: pr.agentId,
      prdId: pr.prdId || undefined,
      laneKey: pr.laneKey || pr.taskId,
      type: patch.type || 'review_followup',
      source: patch.source || patch.type || 'review_followup',
      sprintId: pr.sprintId || 'shared',
      baseBranch: pr.baseBranch,
      checks: [],
      acceptance: buildReviewFollowupAcceptance(pr, nextDescription),
      state: hasActiveTask ? 'queued' : 'active',
      status: hasActiveTask ? 'queued' : 'active',
      branch: worktree.branch || null,
      createdAt: patch.createdAt || new Date().toISOString(),
      updatedAt: patch.updatedAt || new Date().toISOString(),
      startedAt: hasActiveTask ? null : (patch.updatedAt || new Date().toISOString()),
      prId: pr.id,
    };
    if (!task.prdId) {
      delete task.prdId;
    }
    tasks.push(task);
  } else {
    task.title = patch.title || task.title;
    task.description = nextDescription;
    task.type = patch.type || task.type;
    task.source = patch.source || patch.type || task.source || 'review_followup';
    task.acceptance = buildReviewFollowupAcceptance(pr, nextDescription, task.acceptance);
    task.updatedAt = patch.updatedAt || new Date().toISOString();
    task.prId = pr.id;
    if (!tasks.some((candidate) => candidate.id !== task.id && getImplementationTaskState(candidate) === 'active')) {
      task.state = 'active';
      task.status = 'active';
      task.startedAt = task.startedAt || task.updatedAt;
      task.branch = worktree.branch || task.branch || null;
    }
  }

  writeJson(queuePath, buildTaskQueueState(agent, tasks));
  runGit(worktree.worktreePath, ['add', '--', relativePath]);
  if (hasStagedGitChanges(worktree.worktreePath)) {
    runGit(worktree.worktreePath, ['commit', '-m', `auto(${pr.agentId}): queue ${task.id}`]);
  }
  return task;
}

function hasStagedGitChanges(cwd) {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], {
      cwd,
      stdio: 'ignore',
    });
    return false;
  } catch (_) {
    return true;
  }
}

function buildReviewFollowupAcceptance(pr, description, existingAcceptance = []) {
  const explicitAcceptance = uniqueStrings(existingAcceptance || []);
  const prAcceptance = uniqueStrings((pr && pr.acceptance) || []);
  if (explicitAcceptance.length > 0 && !stringListsEqual(explicitAcceptance, prAcceptance)) {
    return explicitAcceptance;
  }
  const summary = String(description || '').trim();
  return [summary || `Address reviewer feedback for ${pr && pr.title ? pr.title : 'this PR'}`];
}

function stringListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function findPullRequestByLane(prState, task) {
  const laneKey = buildTaskLaneKey(task);
  return (prState.pullRequests || []).find((candidate) => {
    return candidate.agentId === task.agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function findBranchLockByLane(branchLocksState, agentId, laneKey) {
  return (branchLocksState.locks || []).find((candidate) => {
    return candidate.agentId === agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function collectTaskScopeViolations(task) {
  return (task && Array.isArray(task.scopeViolations) ? task.scopeViolations : []).map((entry) => ({
    taskId: task.id,
    file: String(entry && entry.file || '').trim(),
    reason: String(entry && entry.reason || '').trim(),
  })).filter((entry) => entry.file && entry.reason);
}

function uniqueScopeViolations(values) {
  const seen = new Set();
  const output = [];
  (values || []).forEach((value) => {
    const taskId = String(value && value.taskId || '').trim();
    const file = String(value && value.file || '').trim();
    const reason = String(value && value.reason || '').trim();
    const key = `${taskId}::${file}::${reason}`;
    if (!taskId || !file || !reason || seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push({ taskId, file, reason });
  });
  return output;
}

function buildLaneSourceSummary(task, completedLaneTasks, pendingLaneTasks) {
  const laneTasks = uniqueTasksById([
    ...completedLaneTasks,
    task,
    ...pendingLaneTasks,
  ]);
  if (laneTasks.length <= 1) {
    return {
      title: task.title,
      body: task.description || '',
    };
  }

  return {
    title: `${task.agentId.replace(/-agent$/, '')} lane work for ${task.prdId || task.id}`,
    body: `Lane task ids: ${laneTasks.map((candidate) => candidate.id).join(', ')}`,
  };
}

function uniqueTasksById(tasks) {
  const seen = new Set();
  return (tasks || []).filter((task) => {
    const id = String(task && task.id || '');
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function buildTaskBranchName(config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const agentSegment = slugify(task.agentId);
  const laneSegment = slugify(buildTaskLaneKey(task));
  return `${config.branchPrefixes.task}/${sprintSegment}/${agentSegment}/${laneSegment}`;
}

function buildWorktreePath(rootDir, config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const laneSegment = slugify(buildTaskLaneKey(task));
  return path.join(rootDir, config.worktreesRoot, task.agentId, `${sprintSegment}-${laneSegment}`);
}

function resolveBaseRef(rootDir, branchName) {
  const remoteRef = `origin/${branchName}`;
  if (gitRefExists(rootDir, remoteRef)) {
    return remoteRef;
  }
  if (gitRefExists(rootDir, branchName)) {
    return branchName;
  }
  throw new Error(`Base branch "${branchName}" does not exist locally or on origin.`);
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

function isGitWorktree(worktreePath) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function runGit(rootDir, args) {
  execFileSync('git', args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGitWorktreeAdd(rootDir: string, args: string[], worktreePath: string, options: AnyRecord = {}) {
  const runner = options.quiet === true ? runGitQuiet : runGit;
  try {
    runner(rootDir, ['worktree', 'add', ...args]);
  } catch (error) {
    const message = extractExecError(error);
    if (!fs.existsSync(worktreePath) && message.includes('missing but already registered worktree')) {
      pruneStaleWorktrees(rootDir);
      runner(rootDir, ['worktree', 'add', ...args]);
      return;
    }
    throw error;
  }
}

function pruneStaleWorktrees(rootDir) {
  try {
    runGitQuiet(rootDir, ['worktree', 'prune', '--expire', 'now']);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function upsertBranchLock(branchLocksState, nextLock) {
  const currentIndex = branchLocksState.locks.findIndex((lock) => {
    if (nextLock.laneKey && lock.laneKey) {
      return lock.laneKey === nextLock.laneKey && lock.agentId === nextLock.agentId;
    }
    return lock.taskId === nextLock.taskId;
  });
  if (currentIndex >= 0) {
    branchLocksState.locks[currentIndex] = {
      ...branchLocksState.locks[currentIndex],
      ...nextLock,
    };
    return;
  }
  branchLocksState.locks.push(nextLock);
}

function collectFilesForValidation(rootDir, options) {
  const explicitFiles = getListOption(options, 'files');
  if (explicitFiles.length > 0) {
    return explicitFiles.map(normalizeRepoPath);
  }

  if (options.worktree) {
    const worktreePath = path.isAbsolute(options.worktree)
      ? options.worktree
      : path.join(rootDir, options.worktree);
    const output = execFileSync('git', ['diff', '--name-only'], {
      cwd: worktreePath,
      encoding: 'utf8',
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(normalizeRepoPath);
  }

  return [];
}

function evaluateScope({ files, agent, task: _task }: { files: string[]; agent: AnyRecord; task?: AnyRecord }) {
  const violations = [];
  const includeGlobs = agent.include || [];
  const excludeGlobs = agent.exclude || [];

  for (const file of files) {
    const inAgentScope = includeGlobs.length === 0 || matchesAnyGlob(file, includeGlobs);
    const excluded = excludeGlobs.length > 0 && matchesAnyGlob(file, excludeGlobs);

    if (!inAgentScope) {
      violations.push({ file, reason: 'outside agent include scope' });
      continue;
    }
    if (excluded) {
      violations.push({ file, reason: 'matches agent exclude scope' });
    }
  }

  return {
    ok: violations.length === 0,
    files,
    includeGlobs,
    excludeGlobs,
    violations,
  };
}

function normalizeRepoPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesAnyGlob(filePath, globs) {
  const normalizedPath = normalizeRepoPath(filePath);
  return globs.some((glob) => globToRegExp(normalizeRepoPath(glob)).test(normalizedPath));
}

function globToRegExp(glob) {
  const normalizedGlob = normalizeRepoPath(glob);
  const segments = normalizedGlob.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return /^$/;
  }
  let pattern = '^';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const isPrevWildcardStar = i > 0 && segments[i - 1] === '**';
    if (segment === '**') {
      if (i > 0) {
        pattern += '/';
      }
      if (i === segments.length - 1) {
        pattern += '.*';
      } else {
        pattern += '(?:[^/]+/)*';
      }
      continue;
    }
    if (i > 0 && !isPrevWildcardStar) {
      pattern += '/';
    }
    const escaped = segment.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    pattern += escaped;
  }
  return new RegExp(`${pattern}$`);
}

function buildStablePullRequestId(laneKey) {
  return `pr-${slugify(laneKey || 'lane')}`;
}

function normalizeReviewDecision(decision) {
  if (decision === 'approve' || decision === 'approved') {
    return 'approved';
  }
  if (decision === 'changes-requested' || decision === 'changes_requested') {
    return 'changes_requested';
  }
  throw new Error(`Unsupported ${getRoleLabel(AGENT_ROLES.REVIEW)} decision "${decision}". Use approve or changes-requested.`);
}

function evaluateMerge({ config, pr, actor }) {
  const reasons = [];
  const mergeActors = config.mergeActors || [];
  if (mergeActors.length > 0) {
    if (!mergeActors.includes(actor.id)) {
      reasons.push(`actor ${actor.id} is not allowed to merge`);
    }
  } else if (actor.role !== 'merge') {
    reasons.push(`actor ${actor.id} is not a merge agent`);
  }
  if (pr.baseBranch !== config.integrationBranch) {
    reasons.push(`PR base branch must be ${config.integrationBranch}, received ${pr.baseBranch}`);
  }
  if ((config.blockedBranches || []).includes(pr.baseBranch)) {
    reasons.push(`PR base branch ${pr.baseBranch} is blocked`);
  }
  if (pr.status !== 'approved') {
    reasons.push(`PR status must be approved before merge, received ${pr.status}`);
  }
  if (!pr.reviews || pr.reviews.length === 0) {
    reasons.push(`PR has no recorded ${getRoleLabel(AGENT_ROLES.REVIEW)}`);
  } else {
    const latestDecision = pr.reviews[pr.reviews.length - 1].decision;
    if (latestDecision !== 'approved') {
      reasons.push(`latest ${getRoleLabel(AGENT_ROLES.REVIEW)} decision is ${latestDecision}`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    mergeStrategy: config.mergeStrategy || 'merge',
    integrationBranch: config.integrationBranch,
  };
}

function resolveGithubRepo(rootDir) {
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).trim();

  const parsed = parseGithubRemoteUrl(remoteUrl);
  if (parsed) {
    return parsed;
  }
 
  throw new Error(`Could not parse GitHub repo from remote URL: ${remoteUrl}`);
}

function parseGithubRemoteUrl(remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.hostname === 'github.com') {
      const trimmedPath = parsedUrl.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
      const segments = trimmedPath.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return {
          owner: segments[0],
          repo: segments.slice(1).join('/'),
        };
      }
    }
  } catch (error) {
    // Fall back to regex parsing for non-URL formats.
  }

  const httpsMatch = remoteUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
    };
  }
  return null;
}


function publishPullRequest(repo, token, payload) {
  return githubRequest(repo, token, 'POST', '/pulls', payload);
}

async function createOrFindPullRequest(repo, token, payload) {
  try {
    return await publishPullRequest(repo, token, payload);
  } catch (error) {
    if (!isGithubValidationError(error)) {
      throw error;
    }
    const existing = await findPullRequestByHead(repo, token, payload.base, payload.head);
    if (existing) {
      return existing;
    }
    throw error;
  }
}

function publishReview(repo, token, pullNumber, decisionRecord) {
  const event = decisionRecord.decision === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
  return githubRequest(repo, token, 'POST', `/pulls/${pullNumber}/reviews`, {
    body: decisionRecord.publishedSummary || decisionRecord.summary || '',
    event,
  });
}

function mergePullRequest(repo, token, pullNumber, payload) {
  return githubRequest(repo, token, 'PUT', `/pulls/${pullNumber}/merge`, payload);
}

function addIssueLabels(repo, token, issueNumber, labels) {
  return githubRequest(repo, token, 'POST', `/issues/${issueNumber}/labels`, {
    labels,
  });
}

function addIssueComment(repo, token, issueNumber, body) {
  return githubRequest(repo, token, 'POST', `/issues/${issueNumber}/comments`, {
    body,
  });
}

async function findPullRequestByHead(repo, token, baseBranch, headBranch) {
  const pulls = await githubRequest(
    repo,
    token,
    'GET',
    `/pulls?state=all&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(`${repo.owner}:${headBranch}`)}`,
    null
  );
  if (!Array.isArray(pulls) || pulls.length === 0) {
    return null;
  }
  return pulls[0];
}

function performLocalMerge(rootDir, config, pr, actor) {
  const mergeRunDir = path.join(rootDir, '.autonomy', 'merge-runs');
  const mergePath = path.join(mergeRunDir, slugify(pr.id));
  const tempBranch = `merge-run-${slugify(pr.id)}`;
  const rootBranch = getCheckedOutBranch(rootDir);
  const syncRootWorktree = rootBranch === pr.baseBranch && isTrackedWorktreeClean(rootDir);
  ensureDir(mergeRunDir);
  cleanupWorktree(rootDir, mergePath);
  deleteLocalBranch(rootDir, tempBranch);

  try {
    const baseRef = resolveBaseRef(rootDir, pr.baseBranch);
    runGitWorktreeAdd(rootDir, ['--detach', mergePath, baseRef], mergePath, { quiet: true });
    runGitQuiet(mergePath, ['switch', '-c', tempBranch]);

    const strategy = config.mergeStrategy || 'merge';
    if (strategy === 'squash') {
      runGitQuiet(mergePath, ['merge', '--squash', pr.headBranch]);
      runGitQuiet(mergePath, ['commit', '-m', buildMergeCommitTitle(actor, pr)]);
    } else {
      runGitQuiet(mergePath, ['merge', '--no-ff', '--no-edit', pr.headBranch]);
    }

    const sha = runGitRead(mergePath, ['rev-parse', 'HEAD']).trim();
    runGitQuiet(rootDir, ['update-ref', `refs/heads/${pr.baseBranch}`, sha]);
    if (syncRootWorktree) {
      syncCheckedOutBranchWorktree(rootDir);
    }
    cleanupWorktree(rootDir, mergePath);
    deleteLocalBranch(rootDir, tempBranch);
    return { ok: true, sha };
  } catch (error) {
    cleanupWorktree(rootDir, mergePath);
    deleteLocalBranch(rootDir, tempBranch);
    return { ok: false, message: extractExecError(error) };
  }
}

function cleanupWorktree(rootDir, worktreePath) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: rootDir,
      stdio: 'ignore',
    });
  } catch (_) {
    // Ignore; the path may not be a registered worktree yet.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function deleteLocalBranch(rootDir, branchName) {
  try {
    execFileSync('git', ['branch', '-D', branchName], {
      cwd: rootDir,
      stdio: 'ignore',
    });
  } catch (_) {
    // Ignore; the branch may not exist yet.
  }
}

function getCheckedOutBranch(rootDir) {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (_) {
    return null;
  }
}

function isTrackedWorktreeClean(rootDir) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() === '';
}

function syncCheckedOutBranchWorktree(rootDir) {
  execFileSync('git', ['reset', '--hard', 'HEAD'], {
    cwd: rootDir,
    stdio: 'ignore',
  });
}

function runGitQuiet(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGitRead(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function extractExecError(error) {
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return error.message;
}

function githubRequest(repo, token, method, endpoint, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo.owner}/${repo.repo}${endpoint}`,
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'autonomy-v2',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };

  if (body) {
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise<any>((resolve, reject) => {
    const request = https.request(options, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        const parsed: AnyRecord = raw ? JSON.parse(raw) : {};
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(parsed);
          return;
        }
        const error = new Error(`GitHub API ${response.statusCode}: ${parsed.message || raw}`);
        error.statusCode = response.statusCode;
        error.payload = parsed;
        reject(error);
      });
    });

    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function isGithubValidationError(error) {
  return Boolean(error && error.statusCode === 422);
}

function isSelfPullRequestReviewError(error) {
  if (!error) {
    return false;
  }
  const payloadErrors = Array.isArray(error.payload && error.payload.errors)
    ? error.payload.errors
    : [];
  return payloadErrors.some((entry) => String(entry || '').toLowerCase().includes('own pull request'));
}

export {
  BASE_TEMPLATE_FILES,
  GENERATED_TEMPLATE_FILES,
  TEMPLATE_ROOT,
  addIssueComment,
  addIssueLabels,
  appendAgentLog,
  appendTrackedBranchFollowupTask,
  archiveCompletedPrdSpecs,
  buildAgentStatusSummaries,
  buildLaneConflictTaskId,
  buildLaneFollowupTaskId,
  buildLaneSourceSummary,
  buildMergeCommitTitle,
  buildPersonaPrBody,
  buildPersonaPrTitle,
  buildPrdSpecPayload,
  buildPullRequestLabels,
  buildPullRequestStatusSummaries,
  
  buildSignedReviewSummary,
  buildStablePullRequestId,
  buildTaskLaneKey,
  buildTrackedImplementationQueueUpdates,
  collectFilesForValidation,
  collectTaskScopeViolations,
  commitPrdSpecToIntegrationBranch,
  commitTrackedFilesToIntegrationBranch,
  commitTrackedImplementationQueue,
  countBy,
  createOrFindPullRequest,
  ensureDir,
  
  ensureInitialized,
  ensureReviewerTask,
  enqueueLaneFollowupTask,
  evaluateMerge,
  evaluateScope,
  findPullRequestByLane,
  findTask,
  formatAgentStatusLine,
  formatCountSummary,
  formatPullRequestStatusLine,
  getAgent,
  getAgentLogPath,
  getAutonomyPaths,
  getImplementationTaskState,
  getListOption,
  getPr,
  getReviewerTask,
  getStringOption,
  getTask,
  getTaskQueue,
  hasActivePrdSpecInIntegrationBranch,
  hasPrdSpecInIntegrationBranch,
  isSelfPullRequestReviewError,
  isTerminalTaskStatus,
  listCompletedLaneTasks,
  listImplementationLaneTasks,
  listLaneTasks,
  listTasks,
  loadAllState,
  loadTrackedPrds,
  mergePullRequest,
  normalizeReviewDecision,
  performLocalMerge,
  prepareTaskWorktree,
  printOutput,
  publishReview,
  queueReviewerTask,
  readJson,
  requireOption,
  resolveGithubAuthToken,
  resolveGithubRepo,
  resolveImplementationBranchRef,
  resolvePrRecordTask,
  resolveTaskForWorktreePreparation,
  resolveTaskQueuePath,
  sanitizePlannedTaskSpecs,
  syncIntegrationSpecs,
  uniqueScopeViolations,
  uniqueStrings,
  validateAutonomyConfig,
  writeJson,
  writeTaskQueues,
};
