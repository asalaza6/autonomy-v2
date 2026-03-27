import { acquireStateLock } from '../../lock/index.js';
import type { AnyRecord, WorkerRuntime } from '../types.js';
import { syncPrdSpecsFromIntegrationBranch } from '../../sync/syncer.js';
import { loadQueues } from './queues.js';
import { findDueAgents, finalizePendingInlineWorkers, refreshRuntime, setWorkerState, spawnWorkerProcess, updateBacklogGrace } from './runtime.js';
import { loadBranchLocks, loadConfig, loadPrds, loadRuntime, writeRuntime } from './state.js';
import { runWorkerOnce } from './workers.js';

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

function runSchedulerTick(rootDir: string, options: AnyRecord = {}) {
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
    const prds = loadPrds(rootDir, config, { queues });
    runtime = loadRuntime(rootDir);
    emitSchedulerProgress(options, 'state:loaded', {
      agents: (config.agents || []).length,
      queues: Object.keys(queues).length,
      prds: Array.isArray(prds.prds) ? prds.prds.length : 0,
      workers: Object.keys((runtime && runtime.workers) || {}).length,
    });
    refreshRuntime(rootDir, config, queues, runtime);
    emitSchedulerProgress(options, 'runtime:refreshed', {
      workers: Object.keys((runtime && runtime.workers) || {}).length,
    });

    const { pendingPrdWork, suppressNonPmDispatch } = updateBacklogGrace(rootDir, config, queues, branchLocks, prds, runtime, options);
    dueAgents = findDueAgents(rootDir, config, queues, branchLocks, prds, runtime, {
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
      running: (Object.values((runtime && runtime.workers) || {}) as WorkerRuntime[])
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

export { runSchedulerTick };
