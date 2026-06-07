import path from 'path';
import { acquireStateLock } from '../../lock/lock-main.js';
import type { AnyRecord, WorkerRuntime } from '../server-types.js';
import { syncPrdSpecsFromIntegrationBranch } from '../../sync/syncer.js';
import { runApprovedPrMergeWatchdog } from '../../autonomy-v2/commands/merge-watchdog.js';
import { loadQueues } from './queues.js';
import { findDueAgents, finalizePendingInlineWorkers, refreshRuntime, setWorkerState, spawnWorkerProcess, updateBacklogGrace } from './orchestrator-runtime.js';
import { loadBranchLocks, loadConfig, loadPrds, loadRuntime, writeRuntime } from './orchestrator-state.js';
import { runWorkerOnce } from './workers.js';
import { getPaths, readJson } from './paths.js';
import {
  markCustomAgentSpawnFailed,
  markCustomAgentSpawned,
  pollCustomAgents,
  refreshCustomAgentRuntime,
  spawnCustomAgentProcess,
} from './custom-agents.js';

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

function updateRuntimePromotion(runtime: AnyRecord, sync: AnyRecord) {
  if (!runtime || !sync || !sync.queuedPromotion) {
    return;
  }
  runtime.lastPrdPromotion = {
    ...sync.queuedPromotion,
    trigger: 'automatic-queue-promotion',
  };
}

function runSchedulerTick(rootDir: string, options: AnyRecord = {}) {
  const { config: syncConfig } = loadConfig(rootDir);
  const legacyRosterEnabled = isLegacyRosterEnabled(rootDir);
  const skipLegacySync = options.skipSync === true || !legacyRosterEnabled;
  const syncStartedAt = Date.now();
  emitSchedulerProgress(options, 'sync:start', {
    integrationBranch: syncConfig.integrationBranch,
    skipped: skipLegacySync ? 'yes' : 'no',
    legacyRosterEnabled: legacyRosterEnabled ? 'yes' : 'no',
  });
  const sync = skipLegacySync
    ? buildSkippedSyncResult(syncConfig.integrationBranch)
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
  const customAgentStarted = [];
  const pendingSpawnStarts = [];
  const pendingCustomAgentStarts = [];

  try {
    emitSchedulerProgress(options, 'state-lock:acquired', { lock: 'state-lock' });
    if (legacyRosterEnabled) {
      const watchdogStartedAt = Date.now();
      const mergeWatchdog = runApprovedPrMergeWatchdog(rootDir, {
        onProgress: options.onProgress,
        stateLockHeld: true,
      });
      emitSchedulerProgress(options, 'merge-watchdog:done', {
        durationMs: Date.now() - watchdogStartedAt,
        checked: mergeWatchdog.checked || 0,
        changed: mergeWatchdog.changed ? 'yes' : 'no',
        merged: mergeWatchdog.merged ? 'yes' : 'no',
        prId: mergeWatchdog.prId || '-',
        reason: mergeWatchdog.reason || mergeWatchdog.diagnosis && mergeWatchdog.diagnosis.code || '-',
        legacyRosterEnabled: 'yes',
      });
    } else {
      emitSchedulerProgress(options, 'merge-watchdog:done', {
        skipped: 'yes',
        legacyRosterEnabled: 'no',
      });
    }
    const { config } = loadConfig(rootDir);
    const queues = loadQueues(rootDir, config);
    const branchLocks = loadBranchLocks(rootDir);
    const prds = loadPrds(rootDir, config, { queues });
    runtime = loadRuntime(rootDir);
    updateRuntimePromotion(runtime, sync);
    emitSchedulerProgress(options, 'state:loaded', {
      agents: (config.agents || []).length,
      queues: Object.keys(queues).length,
      prds: Array.isArray(prds.prds) ? prds.prds.length : 0,
      workers: Object.keys((runtime && runtime.workers) || {}).length,
    });
    refreshRuntime(rootDir, config, queues, runtime);
    refreshCustomAgentRuntime(runtime);
    emitSchedulerProgress(options, 'runtime:refreshed', {
      workers: Object.keys((runtime && runtime.workers) || {}).length,
      customAgents: Object.keys((runtime && runtime.customAgents) || {}).length,
    });

    const { pendingPrdWork, suppressNonPmDispatch } = legacyRosterEnabled
      ? updateBacklogGrace(rootDir, config, queues, branchLocks, prds, runtime, options)
      : { pendingPrdWork: false, suppressNonPmDispatch: false };
    dueAgents = legacyRosterEnabled
      ? findDueAgents(rootDir, config, queues, branchLocks, prds, runtime, {
          suppressNonPmDispatch,
        })
      : [];
    emitSchedulerProgress(options, 'due:computed', {
      due: dueAgents.length,
      pendingPrdWork: pendingPrdWork ? 'yes' : 'no',
      suppressNonPmDispatch: suppressNonPmDispatch ? 'yes' : 'no',
      legacyRosterEnabled: legacyRosterEnabled ? 'yes' : 'no',
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

      setWorkerState(runtime, due.agentId, {
        status: 'running',
        mode: 'spawn',
        startedAt: now,
        pid: null,
        reason: due.reason,
      });
      started.push({ agentId: due.agentId, mode: 'spawn', reason: due.reason, pid: null, startedAt: now });
      pendingSpawnStarts.push({ agentId: due.agentId, reason: due.reason, startedAt: now });
    }

    if (options.inline !== true) {
      const customAgentPoll = pollCustomAgents(rootDir, runtime, options);
      customAgentStarted.push(...customAgentPoll.started);
      pendingCustomAgentStarts.push(...customAgentPoll.pendingSpawnStarts);
      emitSchedulerProgress(options, 'custom-agents:computed', {
        configured: customAgentPoll.config ? 'yes' : 'no',
        started: customAgentPoll.started.length,
        pendingSpawnStarts: customAgentPoll.pendingSpawnStarts.length,
      });
    }

    emitSchedulerProgress(options, 'runtime:write:start', {
      started: started.length,
      customAgentStarted: customAgentStarted.length,
    });
    writeRuntime(rootDir, runtime);
    emitSchedulerProgress(options, 'runtime:write:done', {
      started: started.length,
      customAgentStarted: customAgentStarted.length,
      running: (Object.values((runtime && runtime.workers) || {}) as WorkerRuntime[])
        .filter((worker) => worker && worker.status === 'running').length,
    });
  } finally {
    emitSchedulerProgress(options, 'state-lock:release', { lock: 'state-lock' });
    release();
  }

  if (options.inline !== true) {
    for (let index = 0; index < pendingSpawnStarts.length; index += 1) {
      const entry = pendingSpawnStarts[index];
      try {
        const child = spawnWorkerProcess(rootDir, entry.agentId, {
          streamOutput: options.streamWorkerOutput === true,
        });
        const pid = child.pid;
        const startedEntry = started.find((candidate) => candidate.agentId === entry.agentId && candidate.mode === 'spawn');
        if (startedEntry) {
          startedEntry.pid = pid;
        }
        updateSpawnedWorkerPid(rootDir, entry.agentId, entry.startedAt, pid);
        emitSchedulerProgress(options, 'worker:dispatch:done', {
          agentId: entry.agentId,
          mode: 'spawn',
          reason: entry.reason,
          pid,
        });
        if (typeof options.onWorkerSpawn === 'function') {
          options.onWorkerSpawn({
            agentId: entry.agentId,
            mode: 'spawn',
            reason: entry.reason,
            pid,
            child,
          });
        }
      } catch (error) {
        markSpawnDispatchFailed(rootDir, entry.agentId, entry.startedAt, error);
        pendingSpawnStarts.slice(index + 1).forEach((pending) => {
          markSpawnDispatchSkipped(rootDir, pending.agentId, pending.startedAt, 'worker dispatch aborted before spawn');
        });
        throw error;
      }
    }

    for (const entry of pendingCustomAgentStarts) {
      try {
        const child = spawnCustomAgentProcess(rootDir, entry, {
          streamOutput: options.streamWorkerOutput === true,
          customAgentSpawner: options.customAgentSpawner,
        });
        const pid = child && typeof child === 'object' ? child.pid : null;
        const startedEntry = customAgentStarted.find((candidate) => candidate.agentId === entry.agentId && candidate.startedAt === entry.startedAt);
        if (startedEntry) {
          startedEntry.pid = pid;
        }
        updateCustomAgentSpawnedPid(rootDir, entry, pid);
        emitSchedulerProgress(options, 'custom-agent:dispatch:done', {
          agentId: entry.agentId,
          targetId: entry.target && entry.target.id || '',
          pid,
        });
        if (typeof options.onWorkerSpawn === 'function') {
          options.onWorkerSpawn({
            agentId: entry.agentId,
            mode: 'custom-agent',
            reason: 'custom-agent',
            pid,
            child,
            conversation: entry.conversation || null,
          });
        }
      } catch (error) {
        updateCustomAgentSpawnFailed(rootDir, entry, error);
        throw error;
      }
    }
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
    customAgentStarted,
    runtime,
  };
}

function buildSkippedSyncResult(integrationBranch: string) {
  return {
    integrationBranch,
    ref: null,
    fetchedRef: null,
    imported: [],
    updated: [],
    skipped: [],
    invalid: [],
    fetchMessage: '',
    queuedPromotion: null,
  };
}

function isLegacyRosterEnabled(rootDir: string) {
  const controlPlanePath = path.join(getPaths(rootDir).configDir, 'control-plane.json');
  const controlPlaneConfig = readJson(controlPlanePath, {}) as AnyRecord;
  return controlPlaneConfig.legacyRosterEnabled !== false;
}

function updateCustomAgentSpawnedPid(rootDir: string, entry: AnyRecord, pid: number | null | undefined) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    markCustomAgentSpawned(runtime, entry, pid);
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function updateCustomAgentSpawnFailed(rootDir: string, entry: AnyRecord, error: unknown) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    markCustomAgentSpawnFailed(runtime, entry, error);
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function updateSpawnedWorkerPid(rootDir: string, agentId: string, startedAt: string, pid: number | null | undefined) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    const worker = runtime.workers[agentId];
    if (!worker || worker.status !== 'running' || worker.mode !== 'spawn' || worker.startedAt !== startedAt) {
      return;
    }
    worker.pid = pid ?? null;
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function markSpawnDispatchFailed(rootDir: string, agentId: string, startedAt: string, error: unknown) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    const worker = runtime.workers[agentId];
    if (!worker || worker.mode !== 'spawn' || worker.startedAt !== startedAt) {
      return;
    }
    setWorkerState(runtime, agentId, {
      status: 'idle',
      pid: null,
      finishedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error || 'worker spawn failed'),
    });
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function markSpawnDispatchSkipped(rootDir: string, agentId: string, startedAt: string, message: string) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    const worker = runtime.workers[agentId];
    if (!worker || worker.mode !== 'spawn' || worker.startedAt !== startedAt) {
      return;
    }
    setWorkerState(runtime, agentId, {
      status: 'idle',
      pid: null,
      finishedAt: new Date().toISOString(),
      lastError: message,
    });
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

export { isLegacyRosterEnabled, runSchedulerTick };
