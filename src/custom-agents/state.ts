import type {
  CustomAgentStatus,
  NormalizedCustomAgent,
  PendingCustomAgentStart,
  RuntimeState,
} from '../types.js';
import {
  acquireStateLock,
  extractError,
  isProcessAlive,
  loadRuntime,
  writeRuntime,
} from '../runtime.js';

function ensureStatus(
  runtime: RuntimeState,
  agent: NormalizedCustomAgent,
  configEnabled: boolean
): CustomAgentStatus {
  const previous = runtime.customAgents[agent.runtimeKey] || {} as CustomAgentStatus;
  const status: CustomAgentStatus = {
    ...previous,
    agentId: agent.id,
    runtimeKey: agent.runtimeKey,
    baseRuntimeKey: agent.baseRuntimeKey,
    parallelSlot: agent.parallelSlot,
    parallelism: previous.running ? previous.parallelism : agent.parallelism,
    enabled: configEnabled && agent.enabled,
    status: previous.status || 'idle',
    running: previous.running === true,
    pid: previous.pid ?? null,
    target: previous.running ? previous.target : agent.target,
    workspacePath: previous.running
      ? previous.workspacePath || agent.workspacePath
      : agent.workspacePath,
    singletonKey: agent.singletonKey,
    singletonValue: agent.singletonValue,
    intervalSeconds: agent.intervalSeconds,
  };
  runtime.customAgents[agent.runtimeKey] = status;
  return status;
}

function refreshCustomAgentRuntime(runtime: RuntimeState, now = new Date()) {
  Object.values(runtime.customAgents).forEach((status) => {
    if (!status.running || (status.pid && isProcessAlive(status.pid))) return;
    const startedAt = Date.parse(status.startedAt || '');
    if (!status.pid && Number.isFinite(startedAt) && now.getTime() - startedAt < 60_000) return;
    status.running = false;
    status.status = 'idle';
    status.pid = null;
    status.finishedAt = status.finishedAt || now.toISOString();
    status.lastError = status.lastError || 'custom agent process exited before reporting a result';
    const invocation = status.invocationId
      ? runtime.customAgentInvocations[status.invocationId]
      : null;
    if (invocation?.status === 'running') {
      invocation.status = 'failed';
      invocation.phase = 'failed';
      invocation.updatedAt = now.toISOString();
      invocation.finishedAt = now.toISOString();
      invocation.lastError = status.lastError;
    }
  });
}

function markCustomAgentSpawned(
  rootDir: string,
  entry: PendingCustomAgentStart,
  pid: number | null
) {
  mutateRuntime(rootDir, (runtime) => {
    const status = runtime.customAgents[entry.runtimeKey];
    if (status?.invocationId === entry.invocationId && status.running) status.pid = pid;
  });
}

function markCustomAgentSpawnFailed(
  rootDir: string,
  entry: PendingCustomAgentStart,
  error: unknown
) {
  mutateRuntime(rootDir, (runtime) => {
    const message = extractError(error);
    const now = new Date().toISOString();
    const status = runtime.customAgents[entry.runtimeKey];
    if (status?.invocationId === entry.invocationId) {
      Object.assign(status, {
        status: 'idle',
        running: false,
        pid: null,
        finishedAt: now,
        lastError: message,
      });
    }
    const invocation = runtime.customAgentInvocations[entry.invocationId];
    if (invocation) {
      Object.assign(invocation, {
        status: 'failed',
        phase: 'failed',
        updatedAt: now,
        finishedAt: now,
        lastError: message,
      });
    }
  });
}

function mutateRuntime(rootDir: string, callback: (runtime: RuntimeState) => void) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    callback(runtime);
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

export {
  ensureStatus,
  markCustomAgentSpawnFailed,
  markCustomAgentSpawned,
  refreshCustomAgentRuntime,
};
