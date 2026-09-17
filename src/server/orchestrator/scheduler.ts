import { acquireStateLock } from '../../lock/lock-main.js';
import type { AnyRecord, WorkerRuntime } from '../server-types.js';
import { loadConfig, loadRuntime, writeRuntime } from './orchestrator-state.js';
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

function runSchedulerTick(rootDir: string, options: AnyRecord = {}) {
  const { config: syncConfig } = loadConfig(rootDir);
  const syncStartedAt = Date.now();
  emitSchedulerProgress(options, 'sync:start', {
    integrationBranch: syncConfig.integrationBranch,
    skipped: 'yes',
    legacyRosterEnabled: 'no',
  });
  const sync = buildSkippedSyncResult(syncConfig.integrationBranch);
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
  const dueAgents = [];
  let runtime = null;
  const started = [];
  const customAgentStarted = [];
  const pendingCustomAgentStarts = [];

  try {
    emitSchedulerProgress(options, 'state-lock:acquired', { lock: 'state-lock' });
    runtime = loadRuntime(rootDir);
    refreshCustomAgentRuntime(runtime);
    emitSchedulerProgress(options, 'runtime:refreshed', {
      workers: Object.keys((runtime && runtime.workers) || {}).length,
      customAgents: Object.keys((runtime && runtime.customAgents) || {}).length,
    });

    if (options.inline !== true) {
      const customAgentPoll = pollCustomAgents(rootDir, runtime, {
        ...options,
        maxCustomAgentDecisionsPerPool: options.maxCustomAgentDecisionsPerPool ?? 1,
      });
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
    for (let index = 0; index < pendingCustomAgentStarts.length; index += 1) {
      const entry = pendingCustomAgentStarts[index];
      try {
        const child = spawnCustomAgentProcess(rootDir, entry, {
          streamOutput: options.streamWorkerOutput === true,
          customAgentSpawner: options.customAgentSpawner,
        });
        const pid = child && typeof child === 'object' ? child.pid : null;
        const startedEntry = customAgentStarted.find((candidate) => candidate.runtimeKey === entry.runtimeKey);
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
            runtimeKey: entry.runtimeKey,
            baseRuntimeKey: entry.baseRuntimeKey,
            parallelSlot: entry.parallelSlot,
            parallelism: entry.parallelism,
            mode: 'custom-agent',
            reason: 'custom-agent',
            pid,
            child,
            conversation: entry.conversation || null,
          });
        }
      } catch (error) {
        updateCustomAgentSpawnFailed(rootDir, entry, error);
        pendingCustomAgentStarts.slice(index + 1).forEach((pending) => {
          updateCustomAgentSpawnFailed(rootDir, pending, new Error('custom agent dispatch aborted before spawn'));
        });
        throw error;
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

export { runSchedulerTick };
