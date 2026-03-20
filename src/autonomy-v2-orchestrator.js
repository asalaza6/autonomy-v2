const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { acquireStateLock } = require('./autonomy-v2-lock');
const { validateAutonomyConfig } = require('./autonomy-v2-config');
const { planPrdTasksWithCodex } = require('./autonomy-v2-codex');
const {
  commitPrdSpecToIntegrationBranch,
  syncPrdSpecsFromIntegrationBranch,
} = require('./autonomy-v2-dev-sync');

const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const CLI_PATH = path.join(__dirname, 'autonomy-v2.js');
const WORKER_PATH = path.join(__dirname, 'autonomy-v2-worker.js');
const IMPLEMENTATION_DUE_STATUSES = new Set(['queued']);
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
  if (!agent.taskQueue) {
    return null;
  }
  return path.isAbsolute(agent.taskQueue)
    ? agent.taskQueue
    : resolveRuntimeManagedPath(rootDir, agent.taskQueue);
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

function loadQueues(rootDir, config) {
  const queues = {};
  (config.agents || []).forEach((agent) => {
    const queuePath = resolveQueuePath(rootDir, agent);
    if (!queuePath) {
      return;
    }
    queues[agent.id] = readJson(queuePath, {
      agentId: agent.id,
      role: agent.role,
      tasks: [],
    });
  });
  return queues;
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
    tasks: Object.values(queues).flatMap((entry) => listTasks(entry)),
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
          task.status = 'queued';
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
        const strandedTaskIds = [];
        let queueChanged = false;
        listTasks(queue).forEach((task) => {
          if (task.status !== 'leased' && !(task.execution && task.execution.status === 'waiting_for_external_agent')) {
            return;
          }
          task.status = 'queued';
          task.updatedAt = now;
          task.lastError = 'implementation worker exited before completion';
          delete task.execution;
          strandedTaskIds.push(task.id);
          queueChanged = true;
        });
        if (strandedTaskIds.length > 0) {
          const before = (leases.leases || []).length;
          leases.leases = (leases.leases || []).filter((lease) => !strandedTaskIds.includes(lease.taskId));
          leasesChanged = leasesChanged || before !== leases.leases.length;
        }
        if (queueChanged) {
          recoveredAgents.add(agent.id);
        }
      }
    }
  });

  if (recoveredAgents.size > 0) {
    recoveredAgents.forEach((agentId) => {
      writeQueue(rootDir, getAgent(config, agentId), queues[agentId]);
    });
    writeJson(getPaths(rootDir).tasksState, {
      tasks: Object.values(queues).flatMap((queue) => listTasks(queue)),
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

function findDueAgents(rootDir, config, queues, prds, runtime, leases, options = {}) {
  const due = [];
  const activeLeaseTaskIds = new Set((leases.leases || []).map((lease) => lease.taskId));
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
      if (listTasks(queue).some((task) => implementationTaskNeedsDispatch(task, activeLeaseTaskIds))) {
        due.push({ agentId: agent.id, reason: 'queued_task' });
      }
    }
  });
  return due;
}

function implementationTaskNeedsDispatch(task, activeLeaseTaskIds) {
  if (task.status === 'changes_requested' || task.status === 'conflicted') {
    return true;
  }
  if (task.execution && task.execution.status === 'waiting_for_external_agent') {
    return false;
  }
  if (IMPLEMENTATION_DUE_STATUSES.has(task.status)) {
    return true;
  }
  if (task.status === 'leased') {
    return true;
  }
  return activeLeaseTaskIds.has(task.id);
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
      } else if (runtime.backlogGraceConsumed !== true && hasPendingBacklogWork(config, queues, leases)) {
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

    dueAgents = findDueAgents(rootDir, config, queues, prds, runtime, leases, {
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

function hasPendingBacklogWork(config, queues, leases) {
  const activeLeaseTaskIds = new Set((leases.leases || []).map((lease) => lease.taskId));
  return (config.agents || []).some((agent) => {
    const queue = queues[agent.id];
    if (!queue) {
      return false;
    }
    if (agent.role === 'review') {
      return listTasks(queue).some((task) => task.status === 'queued');
    }
    if (agent.role === 'implementation') {
      return listTasks(queue).some((task) => implementationTaskNeedsDispatch(task, activeLeaseTaskIds));
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
    ? (Array.isArray(prd.tasks) ? prd.tasks.slice() : [])
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
      tasks: sanitizedPlannedSpecs,
    }, {
      commitMessage: `autonomy(prd): persist plan ${prd.id}`,
      gitIdentity: agent.gitIdentity,
    });

    for (const spec of sanitizedPlannedSpecs) {
      const args = [
        CLI_PATH,
        'task:add',
        '--root',
        rootDir,
        '--id',
        spec.id,
        '--title',
        spec.title,
        '--agent',
        spec.agentId,
      ];

      if (spec.description) {
        args.push('--description', spec.description);
      }
      if (prd.id) {
        args.push('--prd-id', prd.id);
      }
      for (const allowedPath of spec.allowedPaths || []) {
        args.push('--allowed-path', allowedPath);
      }
      for (const acceptance of spec.acceptance || []) {
        args.push('--acceptance', acceptance);
      }
      if (spec.sprintId) {
        args.push('--sprint-id', spec.sprintId);
      } else if (prd.sprintId || sprint.sprintId) {
        args.push('--sprint-id', prd.sprintId || sprint.sprintId);
      }

      execFileSync(process.execPath, args, {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      createdTaskIds.push(spec.id);
    }
  } catch (error) {
    finalizePrd(rootDir, prd.id, {
      status: 'failed',
      error: extractExecError(error),
    });
    appendAgentLog(rootDir, config, agent.id, 'prd:failed', {
      input: {
        prdId: prd.id,
        taskCount: (prd.tasks || []).length,
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
    tasks: sanitizedPlannedSpecs,
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

function runImplementationWorker(rootDir, config, agent) {
  const queues = loadQueues(rootDir, config);
  const queue = queues[agent.id];
  const leases = loadLeases(rootDir);
  const prds = loadPrds(rootDir);
  const activeLeaseTaskIds = new Set((leases.leases || []).map((lease) => lease.taskId));
  const task = selectImplementationTask(listTasks(queue), prds.prds || [], activeLeaseTaskIds);
  if (!task) {
    return { ok: true, status: 'noop', reason: 'no_queued_task' };
  }

  if (!activeLeaseTaskIds.has(task.id)) {
    const leasePayload = JSON.parse(execFileSync(process.execPath, [
      CLI_PATH,
      'lease',
      '--root',
      rootDir,
      '--agent',
      agent.id,
      '--task',
      task.id,
      '--json',
    ], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
    if (!leasePayload.task || leasePayload.task.id !== task.id) {
      throw new Error(`Expected lease for task "${task.id}" but received "${leasePayload.task && leasePayload.task.id}".`);
    }
  }
  const worktreePayload = JSON.parse(
    execFileSync(process.execPath, [CLI_PATH, 'worktree:prepare', '--root', rootDir, '--task', task.id, '--create', '--json'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  );

  const refreshedQueues = loadQueues(rootDir, config);
  const refreshedQueue = refreshedQueues[agent.id];
  const leasedTask = listTasks(refreshedQueue).find((candidate) => candidate.id === task.id);
  if (!leasedTask) {
    throw new Error(`Leased task "${task.id}" disappeared before dispatch.`);
  }
  leasedTask.execution = {
    status: 'waiting_for_external_agent',
    dispatchedAt: new Date().toISOString(),
    branch: worktreePayload.branch,
    worktreePath: worktreePayload.worktreePath,
  };
  const queueRelease = acquireStateLock(rootDir);
  try {
    const lockedQueues = loadQueues(rootDir, config);
    const lockedQueue = lockedQueues[agent.id];
    const lockedTask = listTasks(lockedQueue).find((candidate) => candidate.id === task.id);
    if (!lockedTask) {
      throw new Error(`Leased task "${task.id}" disappeared before dispatch.`);
    }
    lockedTask.status = 'leased';
    lockedTask.updatedAt = new Date().toISOString();
    lockedTask.execution = {
      ...leasedTask.execution,
    };
    writeQueueAndAggregate(rootDir, config, agent.id, lockedQueue);
  } finally {
    queueRelease();
  }

  let runner = null;
  if (Array.isArray(agent.runnerCommand) && agent.runnerCommand.length > 0) {
    try {
      runner = executeRunnerCommand(agent.runnerCommand, {
        AUTONOMY_ROOT: rootDir,
        AUTONOMY_AGENT_ID: agent.id,
        AUTONOMY_TASK_ID: task.id,
        AUTONOMY_BRANCH: worktreePayload.branch,
        AUTONOMY_WORKTREE: worktreePayload.worktreePath,
        AUTONOMY_ERROR_REPORT: getRunnerErrorReportPath(rootDir, agent.id),
      });
    } catch (error) {
      markImplementationDispatchFailure(rootDir, config, agent.id, task.id, extractExecError(error));
      throw error;
    }
  }

  appendAgentLog(rootDir, config, agent.id, 'worker:dispatch', {
    input: {
      taskId: task.id,
    },
    output: {
      ...leasedTask.execution,
      runner,
    },
  });

  return {
    ok: true,
    status: 'leased',
    taskId: task.id,
    branch: worktreePayload.branch,
    worktreePath: worktreePayload.worktreePath,
    runner,
  };
}

function selectImplementationTask(tasks, prds, activeLeaseTaskIds) {
  const prdById = new Map((prds || []).map((prd) => [prd.id, prd]));
  return (tasks || [])
    .filter((candidate) => implementationTaskNeedsDispatch(candidate, activeLeaseTaskIds))
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
  if (activeLeaseTaskIds.has(task.id) || task.status === 'leased') {
    return 0;
  }
  if (
    task.status === 'changes_requested'
    || task.status === 'conflicted'
    || task.type === 'review_followup'
    || task.type === 'conflict_resolution'
    || task.prId
  ) {
    return 1;
  }
  return 2;
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
  const release = acquireStateLock(rootDir);
  try {
    const queues = loadQueues(rootDir, config);
    const leases = loadLeases(rootDir);
    const queue = queues[agentId];
    const task = listTasks(queue).find((candidate) => candidate.id === taskId);
    if (!task) {
      return;
    }
    task.status = 'queued';
    task.updatedAt = new Date().toISOString();
    task.lastError = message;
    delete task.execution;
    leases.leases = (leases.leases || []).filter((lease) => lease.taskId !== taskId);
    writeQueueAndAggregate(rootDir, config, agentId, queue);
    writeJson(getPaths(rootDir).leasesState, leases);
  } finally {
    release();
  }
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
    task.status = 'queued';
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
