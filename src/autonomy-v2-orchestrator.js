const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { acquireStateLock } = require('./autonomy-v2-lock');
const { validateAutonomyConfig } = require('./autonomy-v2-config');
const { planPrdTasksWithCodex } = require('./autonomy-v2-codex');
const {
  commitPrdSpecToIntegrationBranch,
  commitTrackedFilesToIntegrationBranch,
  syncPrdSpecsFromIntegrationBranch,
} = require('./autonomy-v2-dev-sync');

const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const CLI_PATH = path.join(__dirname, 'autonomy-v2.js');
const WORKER_PATH = path.join(__dirname, 'autonomy-v2-worker.js');
const IMPLEMENTATION_DUE_STATUSES = new Set(['queued', 'active']);
const BACKLOG_GRACE_MS = 15000;

function emitSchedulerProgress(options, event, payload = {}) {
  if (!options || typeof options.onProgress !== 'function') {
    return;
  }
  try {
    options.onProgress(event, payload);
  } catch (_) {
    // Progress logs must never break scheduling.
  }
}

function resolveRootDir(rootOption) {
  if (!rootOption) {
    return process.cwd();
  }

  return path.isAbsolute(rootOption)
    ? rootOption
    : path.resolve(process.cwd(), rootOption);
}

function getPaths(rootDir) {
  const repoAutonomyDir = path.join(rootDir, ...AUTONOMY_SEGMENTS);
  const runtimeAutonomyDir = path.join(rootDir, ...RUNTIME_SEGMENTS);
  const configDir = path.join(repoAutonomyDir, 'config');
  const stateDir = path.join(runtimeAutonomyDir, 'state');
  return {
    repoAutonomyDir,
    runtimeAutonomyDir,
    configDir,
    stateDir,
    agentsConfig: path.join(configDir, 'agents.json'),
    sprintConfig: path.join(configDir, 'sprint.json'),
    tasksState: path.join(stateDir, 'tasks.json'),
    leasesState: path.join(stateDir, 'leases.json'),
    prdsState: path.join(stateDir, 'prds.json'),
    runtimeState: path.join(stateDir, 'runtime.json'),
    prsState: path.join(stateDir, 'prs.json'),
    branchLocksState: path.join(stateDir, 'branch-locks.json'),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) {
    return fallbackValue;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function loadConfig(rootDir) {
  const paths = getPaths(rootDir);
  return {
    config: validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig),
    sprint: readJson(paths.sprintConfig, {}),
  };
}

function getAgent(config, agentId) {
  const agent = (config.agents || []).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent "${agentId}".`);
  }
  return agent;
}

function resolveQueuePath(rootDir, agent) {
  const relativePath = agent.taskQueue || (
    String(agent.role || '') === 'implementation'
      ? buildImplementationQueueRelativePath(agent.id)
      : path.join('prompts', 'autonomous', 'v2', 'state', 'queues', `${agent.id}.json`)
  );
  if (String(agent.role || '') === 'implementation') {
    return path.isAbsolute(relativePath)
      ? relativePath
      : path.join(rootDir, relativePath);
  }
  return path.isAbsolute(relativePath)
    ? relativePath
    : resolveRuntimeManagedPath(rootDir, relativePath);
}

function buildImplementationQueueRelativePath(agentId) {
  return path.join('prompts', 'autonomous', 'v2', 'queues', `${agentId}.json`);
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

function trimLeadingSeparator(value) {
  let normalized = String(value || '');
  while (normalized.startsWith('/') || normalized.startsWith('\\')) {
    normalized = normalized.slice(1);
  }
  return normalized;
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

function loadQueues(rootDir, config) {
  const queues = {};
  (config.agents || []).forEach((agent) => {
    const queuePath = resolveQueuePath(rootDir, agent);
    const fallbackValue = buildTaskQueueState(agent, []);
    queues[agent.id] = String(agent.role || '') === 'implementation'
      ? readJsonFromGitRef(
          rootDir,
          resolveTrackedQueueRef(rootDir, config.integrationBranch),
          agent.taskQueue || buildImplementationQueueRelativePath(agent.id),
          fs.existsSync(queuePath) ? readJson(queuePath, fallbackValue) : fallbackValue
        )
      : readJson(queuePath, fallbackValue);
  });
  return queues;
}

function buildTaskQueueState(agent, tasks = []) {
  return String(agent.role || '') === 'implementation'
    ? {
        schemaVersion: 1,
        agentId: agent.id,
        role: agent.role,
        tasks,
      }
    : {
        agentId: agent.id,
        role: agent.role,
        tasks,
      };
}

function writeQueue(rootDir, agent, queue) {
  const queuePath = resolveQueuePath(rootDir, agent);
  if (!queuePath) {
    return;
  }
  writeJson(queuePath, queue);
}

function writeQueueAndAggregate(rootDir, config, agentId, queue) {
  const paths = getPaths(rootDir);
  const agent = getAgent(config, agentId);
  writeQueue(rootDir, agent, queue);
  const queues = loadQueues(rootDir, config);
  queues[agentId] = queue;
  writeJson(paths.tasksState, {
    tasks: Object.values(queues)
      .filter((entry) => String((entry && entry.role) || '') !== 'implementation')
      .flatMap((entry) => listTasks(entry)),
  });
}

function loadPrds(rootDir) {
  const paths = getPaths(rootDir);
  return readJson(paths.prdsState, { prds: [] });
}

function writePrds(rootDir, prds) {
  const paths = getPaths(rootDir);
  writeJson(paths.prdsState, prds);
}

function loadRuntime(rootDir) {
  const paths = getPaths(rootDir);
  return readJson(paths.runtimeState, { workers: {} });
}

function loadBranchLocks(rootDir) {
  return readJson(getPaths(rootDir).branchLocksState, { locks: [] });
}

function loadLeases(rootDir) {
  const paths = getPaths(rootDir);
  return readJson(paths.leasesState, { leases: [] });
}

function writeRuntime(rootDir, runtime) {
  const paths = getPaths(rootDir);
  writeJson(paths.runtimeState, runtime);
}

function getAgentLogPath(rootDir, agentId) {
  return path.join(rootDir, ...RUNTIME_SEGMENTS, 'agents', agentId, 'log.md');
}

function getRunnerErrorReportPath(rootDir, agentId) {
  return path.join(rootDir, ...RUNTIME_SEGMENTS, 'agents', agentId, 'last-runner-error.json');
}

function appendAgentLog(rootDir, config, agentId, event, payload = {}) {
  getAgent(config, agentId);
  const logPath = getAgentLogPath(rootDir, agentId);
  ensureDir(path.dirname(logPath));
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${agentId} Log\n`, 'utf8');
  }

  const lines = ['', `## ${new Date().toISOString()} ${event}`];
  if (typeof payload.input !== 'undefined') {
    lines.push('### Input', '```json', JSON.stringify(payload.input, null, 2), '```');
  }
  if (typeof payload.output !== 'undefined') {
    lines.push('### Output', '```json', JSON.stringify(payload.output, null, 2), '```');
  }
  fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
}

function listTasks(queue) {
  return queue && Array.isArray(queue.tasks) ? queue.tasks : [];
}

function getImplementationTaskState(task) {
  return String((task && (task.state || task.status)) || '').trim();
}

function isPendingImplementationTask(task) {
  const state = getImplementationTaskState(task);
  return state === 'active' || state === 'queued';
}

function buildTaskLaneKey(task) {
  if (task && task.laneKey) {
    return task.laneKey;
  }
  if (task && task.prdId) {
    return `${task.prdId}:${task.agentId}`;
  }
  return task ? task.id : '';
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'shared';
}

function buildTaskBranchName(config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const agentSegment = slugify(task.agentId);
  const laneSegment = slugify(buildTaskLaneKey(task));
  return `${config.branchPrefixes.task}/${sprintSegment}/${agentSegment}/${laneSegment}`;
}

function readImplementationQueueFromWorktree(config, agentId, worktreePath) {
  const agent = getAgent(config, agentId);
  const relativePath = agent.taskQueue || buildImplementationQueueRelativePath(agentId);
  const queuePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(worktreePath, relativePath);
  if (!fs.existsSync(queuePath)) {
    return null;
  }
  try {
    const queueState = readJson(queuePath, buildTaskQueueState(agent, []));
    return buildTaskQueueState(agent, Array.isArray(queueState.tasks) ? queueState.tasks : []);
  } catch (_) {
    return null;
  }
}

function completedImplementationTaskIds(branchLocks, agentId) {
  return new Set(
    ((branchLocks && branchLocks.locks) || [])
      .filter((lock) => lock && lock.agentId === agentId)
      .flatMap((lock) => ((lock && lock.completedTasks) || []).map((task) => task.id))
      .filter(Boolean)
  );
}

function filterCompletedImplementationTasks(queue, branchLocks, agentId) {
  const completedIds = completedImplementationTaskIds(branchLocks, agentId);
  return {
    ...(queue || {}),
    tasks: listTasks(queue).filter((task) => !completedIds.has(task.id)),
  };
}

function resolveImplementationQueueContext(rootDir, config, branchLocks, agent, fallbackQueue) {
  const locks = ((branchLocks && branchLocks.locks) || [])
    .filter((lock) => lock && lock.agentId === agent.id && lock.worktreePath && fs.existsSync(lock.worktreePath))
    .slice()
    .sort((left, right) => {
      return (Date.parse(right && right.updatedAt || '') || 0) - (Date.parse(left && left.updatedAt || '') || 0);
    });

  for (const lock of locks) {
    const queue = readImplementationQueueFromWorktree(config, agent.id, lock.worktreePath);
    if (!queue) {
      continue;
    }
    if (listTasks(queue).some((task) => isPendingImplementationTask(task))) {
      return {
        source: 'branch',
        queue,
        branch: lock.branch || null,
        worktreePath: lock.worktreePath,
      };
    }
  }

  return {
    source: 'root',
    queue: filterCompletedImplementationTasks(fallbackQueue, branchLocks, agent.id),
    branch: null,
    worktreePath: null,
  };
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stat) {
      return !stat.includes('Z');
    }
    return true;
  } catch (_) {
    return false;
  }
}

function refreshRuntime(rootDir, config, queues, leases, runtime) {
  const now = new Date().toISOString();
  const recoveredAgents = new Set();
  let leasesChanged = false;
  Object.values(runtime.workers || {}).forEach((worker) => {
    if (worker.status === 'running' && worker.pid && !isProcessAlive(worker.pid)) {
      const agent = getAgent(config, worker.agentId);
      worker.status = 'idle';
      worker.finishedAt = now;
      worker.pid = null;
      if (!worker.lastResult && !worker.lastError) {
        worker.lastError = 'worker process exited before reporting result';
      }

      const queue = queues[agent.id];
      if (!queue) {
        return;
      }

      if (agent.role === 'review') {
        let queueChanged = false;
        listTasks(queue).forEach((task) => {
          if (task.status !== 'assigned') {
            return;
          }
          task.status = 'failed';
          task.updatedAt = now;
          task.lastError = 'review worker exited before completion';
          delete task.dispatchedAt;
          delete task.dispatcher;
          queueChanged = true;
        });
        if (queueChanged) {
          recoveredAgents.add(agent.id);
        }
        return;
      }

      if (agent.role === 'implementation') {
        return;
      }
    }
  });

  if (recoveredAgents.size > 0) {
    recoveredAgents.forEach((agentId) => {
      writeQueue(rootDir, getAgent(config, agentId), queues[agentId]);
    });
    writeJson(getPaths(rootDir).tasksState, {
      tasks: Object.values(queues)
        .filter((queue) => String((queue && queue.role) || '') !== 'implementation')
        .flatMap((queue) => listTasks(queue)),
    });
  }
  if (leasesChanged) {
    writeJson(getPaths(rootDir).leasesState, leases);
  }
}

function workerIsRunning(runtime, agentId) {
  const worker = runtime.workers[agentId];
  if (!worker) {
    return false;
  }
  return worker.status === 'running' && (!worker.pid || isProcessAlive(worker.pid));
}

function listPrds(prdsState) {
  return Array.isArray(prdsState && prdsState.prds) ? prdsState.prds : [];
}

function comparePrdBacklogOrder(left, right) {
  const leftCreated = String(left && left.createdAt || '');
  const rightCreated = String(right && right.createdAt || '');
  const createdOrder = leftCreated.localeCompare(rightCreated);
  if (createdOrder !== 0) {
    return createdOrder;
  }

  const leftUpdated = String(left && left.updatedAt || '');
  const rightUpdated = String(right && right.updatedAt || '');
  const updatedOrder = leftUpdated.localeCompare(rightUpdated);
  if (updatedOrder !== 0) {
    return updatedOrder;
  }

  return String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function findDueAgents(rootDir, config, queues, branchLocks, prds, runtime, leases, options = {}) {
  const due = [];
  const knownPrds = listPrds(prds);
  const hasQueuedPrd = knownPrds.some((prd) => prd.status === 'queued');
  const hasPlanningPrd = knownPrds.some((prd) => prd.status === 'planning');
  const hasActivePrd = knownPrds.some((prd) => prd.status === 'planning' || prd.status === 'planned');
  (config.agents || []).forEach((agent) => {
    if (workerIsRunning(runtime, agent.id)) {
      return;
    }

    if (agent.role === 'pm') {
      if (hasQueuedPrd && !hasActivePrd) {
        due.push({ agentId: agent.id, reason: 'queued_prd' });
      }
      return;
    }

    if (hasPlanningPrd || options.suppressNonPmDispatch === true) {
      return;
    }

    const queue = queues[agent.id];
    if (!queue) {
      return;
    }

    if (agent.role === 'review') {
      if (listTasks(queue).some((task) => task.status === 'queued')) {
        due.push({ agentId: agent.id, reason: 'queued_review' });
      }
      return;
    }

    if (agent.role === 'implementation') {
      const queueContext = resolveImplementationQueueContext(rootDir, config, branchLocks, agent, queue);
      if (listTasks(queueContext.queue).some((task) => implementationTaskNeedsDispatch(task))) {
        due.push({ agentId: agent.id, reason: 'queued_task' });
      }
    }
  });
  return due;
}

function implementationTaskNeedsDispatch(task) {
  return IMPLEMENTATION_DUE_STATUSES.has(getImplementationTaskState(task));
}

function setWorkerState(runtime, agentId, patch) {
  runtime.workers[agentId] = {
    agentId,
    ...(runtime.workers[agentId] || {}),
    ...patch,
  };
}

function spawnWorkerProcess(rootDir, agentId, options = {}) {
  const streamOutput = options.streamOutput === true;
  const child = spawn(process.execPath, [WORKER_PATH, 'run', '--root', rootDir, '--agent', agentId], {
    cwd: rootDir,
    stdio: streamOutput ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    detached: !streamOutput,
    env: {
      ...process.env,
      AUTONOMY_STREAM_WORKER_OUTPUT: streamOutput ? '1' : (process.env.AUTONOMY_STREAM_WORKER_OUTPUT || ''),
    },
  });
  if (!streamOutput) {
    child.unref();
  }
  return child;
}

function runSchedulerTick(rootDir, options = {}) {
  const { config: syncConfig } = loadConfig(rootDir);
  const syncStartedAt = Date.now();
  emitSchedulerProgress(options, 'sync:start', {
    integrationBranch: syncConfig.integrationBranch,
    skipped: options.skipSync === true ? 'yes' : 'no',
  });
  const sync = options.skipSync === true
    ? {
        integrationBranch: syncConfig.integrationBranch,
        ref: null,
        fetchedRef: null,
        imported: [],
        updated: [],
        skipped: [],
        invalid: [],
        fetchMessage: '',
      }
    : syncPrdSpecsFromIntegrationBranch(rootDir, syncConfig.integrationBranch, {
        onProgress: options.onProgress,
      });
  emitSchedulerProgress(options, 'sync:done', {
    integrationBranch: sync.integrationBranch || syncConfig.integrationBranch,
    durationMs: Date.now() - syncStartedAt,
    fetchedRef: sync.fetchedRef || '-',
    imported: Array.isArray(sync.imported) ? sync.imported.length : 0,
    updated: Array.isArray(sync.updated) ? sync.updated.length : 0,
    invalid: Array.isArray(sync.invalid) ? sync.invalid.length : 0,
  });
  emitSchedulerProgress(options, 'state-lock:wait', { lock: 'state-lock' });
  const release = acquireStateLock(rootDir);
  let dueAgents = [];
  let runtime = null;
  const started = [];

  try {
    emitSchedulerProgress(options, 'state-lock:acquired', { lock: 'state-lock' });
    const { config } = loadConfig(rootDir);
    const queues = loadQueues(rootDir, config);
    const branchLocks = loadBranchLocks(rootDir);
    const prds = loadPrds(rootDir);
    const leases = loadLeases(rootDir);
    runtime = loadRuntime(rootDir);
    emitSchedulerProgress(options, 'state:loaded', {
      agents: (config.agents || []).length,
      queues: Object.keys(queues).length,
      prds: Array.isArray(prds.prds) ? prds.prds.length : 0,
      leases: Array.isArray(leases.leases) ? leases.leases.length : 0,
      workers: Object.keys((runtime && runtime.workers) || {}).length,
    });
    refreshRuntime(rootDir, config, queues, leases, runtime);
    emitSchedulerProgress(options, 'runtime:refreshed', {
      workers: Object.keys((runtime && runtime.workers) || {}).length,
    });

    const pendingPrdWork = (prds.prds || []).some((prd) => prd.status === 'queued' || prd.status === 'planning');
    let suppressNonPmDispatch = false;
    if (options.inline !== true) {
      if (pendingPrdWork) {
        runtime.backlogGraceConsumed = false;
        delete runtime.backlogGraceUntil;
      } else if (runtime.backlogGraceConsumed !== true && hasPendingBacklogWork(rootDir, config, queues, branchLocks, leases)) {
        const nowMs = Date.now();
        const graceUntilMs = Date.parse(runtime.backlogGraceUntil || '');
        if (!Number.isFinite(graceUntilMs)) {
          runtime.backlogGraceUntil = new Date(nowMs + BACKLOG_GRACE_MS).toISOString();
          suppressNonPmDispatch = true;
        } else if (graceUntilMs > nowMs) {
          suppressNonPmDispatch = true;
        } else {
          runtime.backlogGraceConsumed = true;
          delete runtime.backlogGraceUntil;
        }
      }
    }

    dueAgents = findDueAgents(rootDir, config, queues, branchLocks, prds, runtime, leases, {
      suppressNonPmDispatch,
    });
    emitSchedulerProgress(options, 'due:computed', {
      due: dueAgents.length,
      pendingPrdWork: pendingPrdWork ? 'yes' : 'no',
      suppressNonPmDispatch: suppressNonPmDispatch ? 'yes' : 'no',
      dueAgents: dueAgents.map((entry) => `${entry.agentId}:${entry.reason}`).join(','),
    });

    for (const due of dueAgents) {
      const now = new Date().toISOString();
      emitSchedulerProgress(options, 'worker:dispatch:start', {
        agentId: due.agentId,
        mode: options.inline === true ? 'inline' : 'spawn',
        reason: due.reason,
      });
      if (options.inline === true) {
        setWorkerState(runtime, due.agentId, {
          status: 'running',
          mode: 'inline',
          startedAt: now,
          pid: null,
          reason: due.reason,
        });
        started.push({ agentId: due.agentId, mode: 'inline', reason: due.reason });
        emitSchedulerProgress(options, 'worker:dispatch:done', {
          agentId: due.agentId,
          mode: 'inline',
          reason: due.reason,
        });
        continue;
      }

      const child = spawnWorkerProcess(rootDir, due.agentId, {
        streamOutput: options.streamWorkerOutput === true,
      });
      const pid = child.pid;
      setWorkerState(runtime, due.agentId, {
        status: 'running',
        mode: 'spawn',
        startedAt: now,
        pid,
        reason: due.reason,
      });
      started.push({ agentId: due.agentId, mode: 'spawn', reason: due.reason, pid });
      emitSchedulerProgress(options, 'worker:dispatch:done', {
        agentId: due.agentId,
        mode: 'spawn',
        reason: due.reason,
        pid,
      });
      if (typeof options.onWorkerSpawn === 'function') {
        options.onWorkerSpawn({
          agentId: due.agentId,
          mode: 'spawn',
          reason: due.reason,
          pid,
          child,
        });
      }
    }

    emitSchedulerProgress(options, 'runtime:write:start', {
      started: started.length,
    });
    writeRuntime(rootDir, runtime);
    emitSchedulerProgress(options, 'runtime:write:done', {
      started: started.length,
      running: Object.values((runtime && runtime.workers) || {})
        .filter((worker) => worker && worker.status === 'running').length,
    });
  } finally {
    emitSchedulerProgress(options, 'state-lock:release', { lock: 'state-lock' });
    release();
  }

  if (options.inline === true) {
    for (let index = 0; index < started.length; index += 1) {
      const entry = started[index];
      try {
        entry.result = runWorkerOnce(rootDir, entry.agentId);
      } catch (error) {
        entry.error = error.message;
        finalizePendingInlineWorkers(rootDir, started.slice(index + 1));
        throw error;
      } finally {
        const runtimeRelease = acquireStateLock(rootDir);
        try {
          const nextRuntime = loadRuntime(rootDir);
          setWorkerState(nextRuntime, entry.agentId, {
            status: 'idle',
            mode: 'inline',
            finishedAt: new Date().toISOString(),
            pid: null,
            reason: entry.reason,
            lastResult: entry.result || null,
            lastError: entry.error || null,
          });
          writeRuntime(rootDir, nextRuntime);
          runtime = nextRuntime;
        } finally {
          runtimeRelease();
        }
      }
    }
  }

  return {
    rootDir,
    sync,
    dueAgents,
    started,
    runtime,
  };
}

function hasPendingBacklogWork(rootDir, config, queues, branchLocks, leases) {
  return (config.agents || []).some((agent) => {
    const queue = queues[agent.id];
    if (!queue) {
      return false;
    }
    if (agent.role === 'review') {
      return listTasks(queue).some((task) => task.status === 'queued');
    }
    if (agent.role === 'implementation') {
      const queueContext = resolveImplementationQueueContext(rootDir, config, branchLocks, agent, queue);
      return listTasks(queueContext.queue).some((task) => implementationTaskNeedsDispatch(task));
    }
    return false;
  });
}

function runWorkerOnce(rootDir, agentId) {
  const { config, sprint } = loadConfig(rootDir);
  const agent = getAgent(config, agentId);
  try {
    if (agent.role === 'pm') {
      return runPmWorker(rootDir, config, sprint, agent);
    }
    if (agent.role === 'review') {
      return runReviewerWorker(rootDir, config, agent);
    }
    if (agent.role === 'implementation') {
      return runImplementationWorker(rootDir, config, agent);
    }

    appendAgentLog(rootDir, config, agent.id, 'worker:skip', {
      input: { role: agent.role },
      output: { status: 'unsupported' },
    });
    return { ok: true, status: 'unsupported' };
  } catch (error) {
    appendAgentLog(rootDir, config, agent.id, 'worker:error', {
      input: {
        role: agent.role,
      },
      output: {
        message: extractExecError(error),
      },
    });
    throw error;
  }
}

function runPmWorker(rootDir, config, sprint, agent) {
  const prd = claimQueuedPrd(rootDir);
  if (!prd) {
    return { ok: true, status: 'noop', reason: 'no_queued_prd' };
  }

  const plannedSpecs = useCodexStub()
    ? buildPmStubTaskSpecs(config, sprint, prd)
    : planPrdTasksWithCodex({ rootDir, agent, config, sprint, prd }).tasks;
  const sanitizedPlannedSpecs = sanitizePlannedTaskSpecs(plannedSpecs);
  if (!Array.isArray(sanitizedPlannedSpecs) || sanitizedPlannedSpecs.length === 0) {
    throw new Error(`PM planning produced no tasks for PRD "${prd.id}".`);
  }

  const createdTaskIds = [];
  try {
    commitPrdSpecToIntegrationBranch(rootDir, config.integrationBranch, {
      id: prd.id,
      title: prd.title,
      createdAt: prd.createdAt,
      specification: prd.specification,
      requirements: prd.requirements,
    }, {
      commitMessage: `autonomy(prd): persist plan ${prd.id}`,
      gitIdentity: agent.gitIdentity,
    });

    const queueUpdates = buildTrackedImplementationQueueUpdates(rootDir, config, sanitizedPlannedSpecs, {
      prd,
      sprint,
    });
    commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, queueUpdates, {
      commitMessage: `autonomy(queue): enqueue plan ${prd.id}`,
      gitIdentity: agent.gitIdentity,
    });
    createdTaskIds.push(...sanitizedPlannedSpecs.map((spec) => spec.id));
  } catch (error) {
    finalizePrd(rootDir, prd.id, {
      status: 'failed',
      error: extractExecError(error),
    });
    appendAgentLog(rootDir, config, agent.id, 'prd:failed', {
      input: {
        prdId: prd.id,
        taskCount: Array.isArray(prd.plannedTaskIds) ? prd.plannedTaskIds.length : 0,
      },
      output: {
        createdTaskIds,
        status: 'failed',
      },
    });
    throw error;
  }

  finalizePrd(rootDir, prd.id, {
    status: 'planned',
    plannedTaskIds: createdTaskIds,
  });
  appendAgentLog(rootDir, config, agent.id, 'prd:planned', {
    input: {
      prdId: prd.id,
      taskCount: sanitizedPlannedSpecs.length,
    },
    output: {
      plannedTaskIds: createdTaskIds,
      status: 'planned',
    },
  });

  return {
    ok: true,
    status: 'planned',
    prdId: prd.id,
    createdTaskIds,
  };
}

function buildPmStubTaskSpecs(config, sprint, prd) {
  const implementationAgents = (config.agents || []).filter((candidate) => String(candidate.role || '') === 'implementation');
  const primaryAgent = implementationAgents[0];
  if (!primaryAgent) {
    return [];
  }
  const taskId = `${prd.id}-${primaryAgent.id}-1`;
  const allowedPaths = normalizeStringList(primaryAgent.include || []);
  const acceptance = normalizeStringList(prd.requirements);
  const description = typeof prd.specification === 'string' && prd.specification.trim()
    ? prd.specification.trim()
    : acceptance[0] || `Implement ${prd.title || prd.id}.`;
  return [{
    id: taskId,
    title: `Implement ${prd.title || prd.id}`,
    agentId: primaryAgent.id,
    description,
    laneKey: `${prd.id}:${primaryAgent.id}`,
    sprintId: prd.sprintId || sprint.sprintId || 'shared',
    allowedPaths,
    acceptance: acceptance.length > 0 ? acceptance : buildFallbackAcceptance(taskId, allowedPaths),
  }];
}

function sanitizePlannedTaskSpecs(taskSpecs) {
  return (Array.isArray(taskSpecs) ? taskSpecs : []).map((task) => {
    const allowedPaths = normalizeStringList(task && task.allowedPaths);
    const acceptance = normalizeStringList(task && task.acceptance)
      .filter((entry) => !isProcessAcceptance(entry));
    return {
      ...task,
      allowedPaths,
      acceptance: acceptance.length > 0
        ? acceptance
        : buildFallbackAcceptance(task && task.id, allowedPaths),
    };
  });
}

function buildFallbackAcceptance(taskId, allowedPaths) {
  if (allowedPaths.length === 1) {
    return [`Only \`${allowedPaths[0]}\` is modified by task \`${taskId}\`.`];
  }
  if (allowedPaths.length > 1) {
    return [`Changes for task \`${taskId}\` stay within the allowed paths: ${allowedPaths.join(', ')}.`];
  }
  return [`Task \`${taskId}\` is complete within its declared scope.`];
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function buildTrackedImplementationQueueUpdates(rootDir, config, taskSpecs, { prd, sprint }) {
  const queues = loadQueues(rootDir, config);
  const nextByAgent = new Map();
  const now = new Date().toISOString();

  (Array.isArray(taskSpecs) ? taskSpecs : []).forEach((spec) => {
    const agent = getAgent(config, spec.agentId);
    const baseQueue = nextByAgent.get(agent.id) || buildTaskQueueState(agent, listTasks(queues[agent.id]).slice());
    const existingIndex = listTasks(baseQueue).findIndex((task) => task.id === spec.id);
    const nextTask = {
      id: spec.id,
      title: spec.title,
      description: spec.description || '',
      agentId: spec.agentId,
      prdId: prd.id || undefined,
      laneKey: spec.laneKey || `${prd.id}:${spec.agentId}`,
      type: spec.type || 'implementation',
      source: spec.source || 'planned',
      sprintId: spec.sprintId || prd.sprintId || sprint.sprintId || 'shared',
      baseBranch: config.integrationBranch,
      allowedPaths: normalizeStringList(spec.allowedPaths),
      checks: normalizeStringList(agent.checks || []),
      acceptance: normalizeStringList(spec.acceptance),
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
    const relativePath = agent.taskQueue || buildImplementationQueueRelativePath(agentId);
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Implementation queue for "${agentId}" must be repo-relative to commit it to ${config.integrationBranch}.`);
    }
    return {
      relativePath,
      content: buildTaskQueueState(agent, listTasks(queueState)),
    };
  });
}

function isProcessAcceptance(value) {
  return /(reflog|origin\/|merge-base|created from|branch|commit)/i.test(String(value || ''));
}

function runReviewerWorker(rootDir, config, agent) {
  const reviewTask = claimQueuedReviewTask(rootDir, config, agent.id);
  if (!reviewTask) {
    return { ok: true, status: 'noop', reason: 'no_queued_review' };
  }

  let runner = null;
  if (Array.isArray(agent.runnerCommand) && agent.runnerCommand.length > 0) {
    try {
      runner = executeRunnerCommand(agent.runnerCommand, {
        AUTONOMY_ROOT: rootDir,
        AUTONOMY_AGENT_ID: agent.id,
        AUTONOMY_REVIEW_TASK_ID: reviewTask.id,
        AUTONOMY_PR_ID: reviewTask.prId || '',
        AUTONOMY_SOURCE_AGENT_ID: reviewTask.sourceAgentId || '',
        AUTONOMY_ERROR_REPORT: getRunnerErrorReportPath(rootDir, agent.id),
      });
    } catch (error) {
      markReviewDispatchFailure(rootDir, config, agent.id, reviewTask.id, extractExecError(error));
      throw error;
    }
  }
  appendAgentLog(rootDir, config, agent.id, 'worker:dispatch', {
    input: {
      taskId: reviewTask.id,
      prId: reviewTask.prId,
    },
    output: {
      status: reviewTask.status,
      runner,
    },
  });

  return {
    ok: true,
    status: 'assigned',
    taskId: reviewTask.id,
    prId: reviewTask.prId,
    runner,
  };
}

function claimTrackedImplementationTask(rootDir, config, agent, queue, task) {
  const nextQueue = buildTaskQueueState(agent, listTasks(queue).map((candidate) => ({ ...candidate })));
  const nextTask = listTasks(nextQueue).find((candidate) => candidate.id === task.id);
  if (!nextTask) {
    throw new Error(`Task "${task.id}" disappeared before tracked claim.`);
  }
  const branch = buildTaskBranchName(config, nextTask);
  const claimedAt = new Date().toISOString();
  nextTask.state = 'active';
  nextTask.status = 'active';
  nextTask.branch = branch;
  nextTask.startedAt = nextTask.startedAt || claimedAt;
  nextTask.updatedAt = claimedAt;
  delete nextTask.completedAt;
  delete nextTask.commitSha;
  delete nextTask.completionMode;

  const relativePath = agent.taskQueue || buildImplementationQueueRelativePath(agent.id);
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Implementation queue for "${agent.id}" must be repo-relative to commit it to ${config.integrationBranch}.`);
  }
  commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, [{
    relativePath,
    content: nextQueue,
  }], {
    commitMessage: `autonomy(queue): start ${task.id}`,
    gitIdentity: agent.gitIdentity,
  });

  return {
    task: nextTask,
    branch,
  };
}

function runImplementationWorker(rootDir, config, agent) {
  const queues = loadQueues(rootDir, config);
  const queue = queues[agent.id];
  const branchLocks = loadBranchLocks(rootDir);
  const prds = loadPrds(rootDir);
  const queueContext = resolveImplementationQueueContext(rootDir, config, branchLocks, agent, queue);
  const task = selectImplementationTask(listTasks(queueContext.queue), prds.prds || [], new Set());
  if (!task) {
    return { ok: true, status: 'noop', reason: 'no_queued_task' };
  }

  let branch = queueContext.branch || task.branch || null;
  let worktreePath = queueContext.worktreePath || null;
  let dispatchTask = task;
  if (queueContext.source !== 'branch') {
    const claim = claimTrackedImplementationTask(rootDir, config, agent, queue, task);
    branch = claim.branch;
    dispatchTask = claim.task;
    const worktreePayload = JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, 'worktree:prepare', '--root', rootDir, '--task', task.id, '--create', '--json'], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    );
    branch = worktreePayload.branch;
    worktreePath = worktreePayload.worktreePath;
  }

  let runner = null;
  if (Array.isArray(agent.runnerCommand) && agent.runnerCommand.length > 0) {
    try {
      runner = executeRunnerCommand(agent.runnerCommand, {
        AUTONOMY_ROOT: rootDir,
        AUTONOMY_AGENT_ID: agent.id,
        AUTONOMY_TASK_ID: dispatchTask.id,
        AUTONOMY_BRANCH: branch,
        AUTONOMY_WORKTREE: worktreePath,
        AUTONOMY_ERROR_REPORT: getRunnerErrorReportPath(rootDir, agent.id),
      });
    } catch (error) {
      markImplementationDispatchFailure(rootDir, config, agent.id, dispatchTask.id, extractExecError(error));
      throw error;
    }
  }

  appendAgentLog(rootDir, config, agent.id, 'worker:dispatch', {
    input: {
      taskId: dispatchTask.id,
    },
    output: {
      branch,
      worktreePath,
      runner,
    },
  });

  return {
    ok: true,
    status: 'active',
    taskId: dispatchTask.id,
    branch,
    worktreePath,
    runner,
  };
}

function selectImplementationTask(tasks, prds, activeLeaseTaskIds) {
  const prdById = new Map((prds || []).map((prd) => [prd.id, prd]));
  return (tasks || [])
    .filter((candidate) => implementationTaskNeedsDispatch(candidate))
    .sort((left, right) => {
      const priorityOrder = compareImplementationTaskPriority(left, right, activeLeaseTaskIds);
      if (priorityOrder !== 0) {
        return priorityOrder;
      }
      const prdOrder = comparePrdBacklogOrder(prdById.get(left.prdId), prdById.get(right.prdId));
      if (prdOrder !== 0) {
        return prdOrder;
      }
      return 0;
    })[0] || null;
}

function compareImplementationTaskPriority(left, right, activeLeaseTaskIds) {
  return getImplementationTaskPriority(left, activeLeaseTaskIds)
    - getImplementationTaskPriority(right, activeLeaseTaskIds);
}

function getImplementationTaskPriority(task, activeLeaseTaskIds) {
  if (!task) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (getImplementationTaskState(task) === 'active') {
    return 0;
  }
  if (task.type === 'review_followup') {
    return 1;
  }
  if (task.type === 'conflict_resolution') {
    return 2;
  }
  if (getImplementationTaskState(task) === 'queued') {
    return 3;
  }
  return 10;
}

function claimQueuedPrd(rootDir) {
  const release = acquireStateLock(rootDir);
  try {
    const prds = loadPrds(rootDir);
    const prd = listPrds(prds)
      .filter((candidate) => candidate.status === 'queued')
      .sort(comparePrdBacklogOrder)[0];
    if (!prd) {
      return null;
    }
    prd.status = 'planning';
    prd.updatedAt = new Date().toISOString();
    writePrds(rootDir, prds);
    return JSON.parse(JSON.stringify(prd));
  } finally {
    release();
  }
}

function finalizePrd(rootDir, prdId, patch) {
  const release = acquireStateLock(rootDir);
  try {
    const prds = loadPrds(rootDir);
    const prd = (prds.prds || []).find((candidate) => candidate.id === prdId);
    if (!prd) {
      return;
    }
    Object.assign(prd, patch, {
      updatedAt: new Date().toISOString(),
    });
    writePrds(rootDir, prds);
  } finally {
    release();
  }
}

function claimQueuedReviewTask(rootDir, config, agentId) {
  const release = acquireStateLock(rootDir);
  try {
    const queues = loadQueues(rootDir, config);
    const reviewerQueue = queues[agentId];
    const reviewTask = listTasks(reviewerQueue).find((task) => task.status === 'queued');
    if (!reviewTask) {
      return null;
    }
    reviewTask.status = 'assigned';
    reviewTask.dispatchedAt = new Date().toISOString();
    reviewTask.dispatcher = 'scheduler';
    writeQueueAndAggregate(rootDir, config, agentId, reviewerQueue);
    return JSON.parse(JSON.stringify(reviewTask));
  } finally {
    release();
  }
}

function extractExecError(error) {
  const runnerSummary = normalizeNonEmptyString(error && error.autonomyErrorReport && error.autonomyErrorReport.summary);
  if (runnerSummary) {
    return runnerSummary;
  }
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return normalizeNonEmptyString(error && error.message) || 'Command failed without stderr/stdout output.';
}

function executeRunnerCommand(command, env) {
  const [binary, ...args] = command;
  const streamOutput = (env && env.AUTONOMY_STREAM_WORKER_OUTPUT === '1')
    || process.env.AUTONOMY_STREAM_WORKER_OUTPUT === '1';
  const errorReportPath = normalizeNonEmptyString(env && env.AUTONOMY_ERROR_REPORT);
  if (errorReportPath && fs.existsSync(errorReportPath)) {
    fs.rmSync(errorReportPath, { force: true });
  }
  try {
    execFileSync(binary, args, {
      cwd: (env && env.AUTONOMY_ROOT) || process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: streamOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    return {
      command,
      status: 'executed',
    };
  } catch (error) {
    const runnerErrorReport = readRunnerErrorReport(errorReportPath);
    if (runnerErrorReport) {
      error.autonomyErrorReport = runnerErrorReport;
    }
    throw error;
  }
}

function readRunnerErrorReport(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function markImplementationDispatchFailure(rootDir, config, agentId, taskId, message) {
  void rootDir;
  void config;
  void agentId;
  void taskId;
  void message;
}

function normalizeNonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function markReviewDispatchFailure(rootDir, config, agentId, taskId, message) {
  const release = acquireStateLock(rootDir);
  try {
    const queues = loadQueues(rootDir, config);
    const queue = queues[agentId];
    const task = listTasks(queue).find((candidate) => candidate.id === taskId);
    if (!task) {
      return;
    }
    task.status = 'failed';
    task.updatedAt = new Date().toISOString();
    task.lastError = message;
    delete task.dispatchedAt;
    delete task.dispatcher;
    writeQueueAndAggregate(rootDir, config, agentId, queue);
  } finally {
    release();
  }
}

function finalizePendingInlineWorkers(rootDir, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }
  const runtimeRelease = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    const finishedAt = new Date().toISOString();
    entries.forEach((entry) => {
      setWorkerState(runtime, entry.agentId, {
        status: 'idle',
        mode: 'inline',
        finishedAt,
        pid: null,
        reason: entry.reason,
        lastResult: null,
        lastError: 'not run because a prior inline worker failed',
      });
    });
    writeRuntime(rootDir, runtime);
  } finally {
    runtimeRelease();
  }
}

function useCodexStub() {
  return process.env.AUTONOMY_CODEX_STUB === '1';
}

module.exports = {
  extractExecError,
  findDueAgents,
  getPaths,
  loadConfig,
  loadPrds,
  loadQueues,
  loadRuntime,
  readJson,
  resolveRootDir,
  runSchedulerTick,
  runWorkerOnce,
  writeJson,
};
