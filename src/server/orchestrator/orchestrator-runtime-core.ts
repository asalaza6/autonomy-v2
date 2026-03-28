import { execFileSync, spawn } from 'node:child_process';
import { getAgentDefinition } from '../../agents/AgentDefinitionRegistry.js';
import {
  AGENT_ROLES,
  TASK_TYPES,
  getRoleLabel,
  isImplementationRole,
  isReviewRole,
} from '../../agents/role-catalog.js';
import type {
  AnyRecord,
  AutonomyConfig,
  BranchLocksState,
  QueueMap,
  RuntimeState,
  TrackedPrdRecord,
} from '../server-types.js';
import { acquireStateLock } from '../../lock/lock-main.js';
import { createScheduleAgentExecutionContext } from './orchestrator-agent-context.js';
import { BACKLOG_GRACE_MS, WORKER_PATH } from './orchestrator-constants.js';
import { getAgent, implementationTaskNeedsDispatch, listPrds, listTasks } from './helpers.js';
import { resolveImplementationQueueContext, writeQueueAndAggregate } from './queues.js';
import { loadRuntime, writeRuntime } from './orchestrator-state.js';

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
    return stat ? !stat.includes('Z') : true;
  } catch (_) {
    return false;
  }
}

function refreshRuntime(rootDir: string, config: AutonomyConfig, queues: QueueMap, runtime: RuntimeState) {
  const now = new Date().toISOString();
  const recoveredAgents = new Set<string>();
  Object.values(runtime.workers || {}).forEach((worker) => {
    if (worker.status !== 'running' || !worker.pid || isProcessAlive(worker.pid)) {
      return;
    }

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

    if (isReviewRole(agent.role)) {
      let queueChanged = false;
      listTasks(queue).forEach((task) => {
        if (task.status !== 'assigned') {
          return;
        }
        task.status = 'failed';
        task.updatedAt = now;
        task.lastError = `${getRoleLabel(AGENT_ROLES.REVIEW)} worker exited before completion`;
        delete task.dispatchedAt;
        delete task.dispatcher;
        queueChanged = true;
      });
      if (queueChanged) {
        recoveredAgents.add(agent.id);
      }
    }
  });

  if (recoveredAgents.size > 0) {
    recoveredAgents.forEach((agentId) => {
      writeQueueAndAggregate(rootDir, config, agentId, queues[agentId], {
        commitMessage: `autonomy(queue): recover ${agentId}`,
      });
    });
  }
}

function workerIsRunning(runtime, agentId) {
  const worker = runtime.workers[agentId];
  return Boolean(worker && worker.status === 'running' && (!worker.pid || isProcessAlive(worker.pid)));
}

function findDueAgents(rootDir: string, config: AutonomyConfig, queues: QueueMap, branchLocks: BranchLocksState, prds: { prds: TrackedPrdRecord[] }, runtime: RuntimeState, options: AnyRecord = {}) {
  const due = [];
  const knownPrds = listPrds(prds);
  const hasPlanningPrd = knownPrds.some((prd) => prd.status === 'planning');

  (config.agents || []).forEach((agent) => {
    if (workerIsRunning(runtime, agent.id)) {
      return;
    }
    const definition = getAgentDefinition(agent);
    const context = createScheduleAgentExecutionContext(rootDir, config, agent, {
      queues,
      branchLocks,
      prds,
      runtime,
    }, {
      suppressNonPmDispatch: options.suppressNonPmDispatch === true,
      hasPlanningPrd,
    });
    if (!definition.canRun(context)) {
      return;
    }
    due.push({ agentId: agent.id, reason: getDueReason(agent.role) });
  });

  return due;
}

function getDueReason(role) {
  if (role === AGENT_ROLES.PM) {
    return 'queued_prd';
  }
  if (role === AGENT_ROLES.REVIEW) {
    return `${TASK_TYPES.REVIEW}_queue`;
  }
  if (role === AGENT_ROLES.IMPLEMENTATION) {
    return 'queued_task';
  }
  return 'scheduled';
}

function setWorkerState(runtime: RuntimeState, agentId: string, patch: AnyRecord) {
  runtime.workers[agentId] = {
    agentId,
    ...(runtime.workers[agentId] || {}),
    ...patch,
  };
}

function spawnWorkerProcess(rootDir: string, agentId: string, options: AnyRecord = {}) {
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

function hasPendingBacklogWork(rootDir, config, queues, branchLocks) {
  return (config.agents || []).some((agent) => {
    const queue = queues[agent.id];
    if (!queue) {
      return false;
    }
    if (isReviewRole(agent.role)) {
      return listTasks(queue).some((task) => task.status === 'queued');
    }
    if (isImplementationRole(agent.role)) {
      const queueContext = resolveImplementationQueueContext(rootDir, config, branchLocks, agent, queue);
      return listTasks(queueContext.queue).some((task) => implementationTaskNeedsDispatch(task));
    }
    return false;
  });
}

function updateBacklogGrace(rootDir, config, queues, branchLocks, prds, runtime, options) {
  const pendingPrdWork = (prds.prds || []).some((prd) => prd.status === 'queued' || prd.status === 'planning');
  let suppressNonPmDispatch = false;
  if (options.inline !== true) {
    if (pendingPrdWork) {
      runtime.backlogGraceConsumed = false;
      delete runtime.backlogGraceUntil;
    } else if (runtime.backlogGraceConsumed !== true && hasPendingBacklogWork(rootDir, config, queues, branchLocks)) {
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
  return { pendingPrdWork, suppressNonPmDispatch };
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

export {
  finalizePendingInlineWorkers,
  findDueAgents,
  refreshRuntime,
  setWorkerState,
  spawnWorkerProcess,
  updateBacklogGrace,
};
