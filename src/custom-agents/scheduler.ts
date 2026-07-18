import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type {
  CustomAgentConversation,
  CustomAgentStatus,
  JsonRecord,
  LaunchedCustomAgent,
  NormalizedCustomAgent,
  PendingCustomAgentStart,
  RuntimeState,
  SchedulerTickResult,
  StartedCustomAgent,
} from '../types.js';
import {
  acquireStateLock,
  ensureDir,
  extractError,
  loadRuntime,
  signalProcessGroup,
  slugify,
  writeJson,
  writeRuntime,
} from '../runtime.js';
import { loadCustomAgentConfig } from './config.js';
import { runBufferedCommand } from './command.js';
import {
  ensureStatus,
  markCustomAgentSpawnFailed,
  markCustomAgentSpawned,
  refreshCustomAgentRuntime,
} from './state.js';

type PollOptions = {
  configPath?: string;
  runtimeKey?: string;
  maxStarts?: number;
  force?: boolean;
  ignoreEnabled?: boolean;
  now?: Date;
  serverInstanceId?: string;
};

type TickOptions = PollOptions & {
  detached?: boolean;
  streamOutput?: boolean;
  spawner?: (rootDir: string, entry: PendingCustomAgentStart) => ChildProcess;
  onSpawn?: (entry: StartedCustomAgent, child: ChildProcess) => void;
  shouldStop?: () => boolean;
};

type DecisionReservation = {
  agent: NormalizedCustomAgent;
  token: string;
  reservedAt: string;
};

function listConfiguredCustomAgents(
  rootDir: string,
  options: { configPath?: string; runtime?: RuntimeState } = {}
) {
  const config = loadCustomAgentConfig(rootDir, options.configPath);
  if (!config) {
    return [];
  }
  const runtime = options.runtime || loadRuntime(rootDir);
  const pools = new Map<string, NormalizedCustomAgent[]>();
  config.agents.forEach((agent) => {
    const slots = pools.get(agent.baseRuntimeKey) || [];
    slots.push(agent);
    pools.set(agent.baseRuntimeKey, slots);
  });
  return [...pools.values()].map((slots) => {
    const agent = slots[0];
    const configuredRuntimeKeys = new Set(slots.map((slot) => slot.runtimeKey));
    const slotStatuses: Array<{
      slot: NormalizedCustomAgent | null;
      status: CustomAgentStatus | null;
      configured: boolean;
    }> = slots.map((slot) => ({
      slot,
      status: runtime.customAgents[slot.runtimeKey] || null,
      configured: true,
    }));
    Object.values(runtime.customAgents)
      .filter((status) => (
        status.running
        && status.baseRuntimeKey === agent.baseRuntimeKey
        && !configuredRuntimeKeys.has(status.runtimeKey)
      ))
      .forEach((status) => slotStatuses.push({ slot: null, status, configured: false }));
    slotStatuses.sort((left, right) => (
      (left.slot?.parallelSlot || left.status?.parallelSlot || 1)
      - (right.slot?.parallelSlot || right.status?.parallelSlot || 1)
    ));
    const runningCount = slotStatuses.filter(({ status }) => status?.running === true).length;
    const representative = slotStatuses.find(({ status }) => status?.running)?.status
      || slotStatuses
        .map(({ status }) => status)
        .filter((status): status is CustomAgentStatus => Boolean(status))
        .sort((left, right) => Date.parse(right.lastPollAt || '') - Date.parse(left.lastPollAt || ''))[0]
      || null;
    return {
      runtimeKey: agent.baseRuntimeKey,
      agentId: agent.id,
      enabled: config.enabled && agent.enabled,
      kind: agent.kind,
      target: agent.target,
      workspacePath: agent.workspacePath,
      intervalSeconds: agent.intervalSeconds,
      parallelism: agent.parallelism,
      runningCount,
      status: runningCount > 0
        ? 'running'
        : representative?.status || (config.enabled && agent.enabled ? 'idle' : 'disabled'),
      running: runningCount > 0,
      pid: representative?.pid ?? null,
      invocationId: representative?.invocationId || '',
      lastDecision: representative?.lastDecision || '',
      lastDecisionReason: representative?.lastDecisionReason || '',
      lastError: representative?.lastError || null,
      slots: slotStatuses.map(({ slot, status, configured }) => ({
        runtimeKey: slot?.runtimeKey || status?.runtimeKey || '',
        slot: slot?.parallelSlot || status?.parallelSlot || 1,
        configured,
        parallelism: status?.running
          ? status.parallelism
          : slot?.parallelism || status?.parallelism || 1,
        workspacePath: status?.running
          ? status.workspacePath
          : slot?.workspacePath || status?.workspacePath || '',
        status: status?.status || (config.enabled && slot?.enabled ? 'idle' : 'disabled'),
        running: status?.running === true,
        pid: status?.pid ?? null,
        invocationId: status?.invocationId || '',
        lastDecision: status?.lastDecision || '',
        lastDecisionReason: status?.lastDecisionReason || '',
        lastError: status?.lastError || null,
      })),
    };
  });
}

async function runSchedulerTick(
  rootDir: string,
  options: TickOptions = {}
): Promise<SchedulerTickResult> {
  let release = acquireStateLock(rootDir);
  let reservations: DecisionReservation[];
  try {
    const runtime = loadRuntime(rootDir);
    refreshCustomAgentRuntime(runtime, options.now);
    reservations = reserveCustomAgentDecisions(rootDir, runtime, options);
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }

  const outcomes = await Promise.all(reservations.map(async (reservation) => {
    try {
      return { reservation, decision: await decide(rootDir, reservation.agent) };
    } catch (error) {
      return {
        reservation,
        decision: decisionError(`decision command failed: ${extractError(error)}`),
      };
    }
  }));
  if (options.shouldStop?.()) {
    release = acquireStateLock(rootDir);
    try {
      const runtime = loadRuntime(rootDir);
      cancelDecisionReservations(runtime, reservations);
      writeRuntime(rootDir, runtime);
    } finally {
      release();
    }
    return { rootDir, started: [], launched: [], runtime: loadRuntime(rootDir) };
  }
  let pollResult: { started: StartedCustomAgent[]; pending: PendingCustomAgentStart[] } = {
    started: [],
    pending: [],
  };
  if (outcomes.length > 0) {
    release = acquireStateLock(rootDir);
    try {
      const runtime = loadRuntime(rootDir);
      pollResult = commitCustomAgentDecisions(rootDir, runtime, outcomes, options);
      writeRuntime(rootDir, runtime);
    } finally {
      release();
    }
  }

  const launched: LaunchedCustomAgent[] = [];
  const launchErrors: Error[] = [];
  for (const pending of pollResult.pending) {
    let child: ChildProcess;
    try {
      child = options.spawner
        ? options.spawner(rootDir, pending)
        : spawnCustomAgentProcess(rootDir, pending, options);
    } catch (error) {
      recordSpawnFailure(rootDir, pending, error, launchErrors);
      continue;
    }
    try {
      child.once('error', (error) => {
        try {
          markCustomAgentSpawnFailed(rootDir, pending, error);
        } catch (stateError) {
          console.error(`Failed to record custom-agent spawn error: ${extractError(stateError)}`);
        }
      });
      markCustomAgentSpawned(rootDir, pending, child.pid ?? null);
      const start = pollResult.started.find((entry) => (
        entry.runtimeKey === pending.runtimeKey
        && entry.invocationId === pending.invocationId
      ));
      if (!start) {
        throw new Error(`Missing committed start for custom-agent ${pending.runtimeKey}.`);
      }
      start.pid = child.pid ?? null;
      launched.push({ start, child });
      try {
        options.onSpawn?.(start, child);
      } catch (error) {
        launchErrors.push(new Error(
          `Custom-agent ${pending.runtimeKey} spawn observer failed: ${extractError(error)}`,
          { cause: error }
        ));
      }
    } catch (error) {
      signalProcessGroup(child.pid, 'SIGTERM');
      recordSpawnFailure(rootDir, pending, error, launchErrors);
    }
  }
  if (launchErrors.length > 0) {
    throw new AggregateError(launchErrors, 'One or more custom-agent launches failed.');
  }

  return {
    rootDir,
    started: pollResult.started,
    launched,
    runtime: loadRuntime(rootDir),
  };
}

function recordSpawnFailure(
  rootDir: string,
  pending: PendingCustomAgentStart,
  error: unknown,
  errors: Error[]
) {
  try {
    markCustomAgentSpawnFailed(rootDir, pending, error);
  } catch (stateError) {
    errors.push(new Error(
      `Custom-agent ${pending.runtimeKey} launch failed and its state could not be updated: ${extractError(stateError)}`,
      { cause: stateError }
    ));
  }
  errors.push(new Error(
    `Custom-agent ${pending.runtimeKey} launch failed: ${extractError(error)}`,
    { cause: error }
  ));
}

function reserveCustomAgentDecisions(
  rootDir: string,
  runtime: RuntimeState,
  options: PollOptions = {}
) {
  const config = loadCustomAgentConfig(rootDir, options.configPath);
  if (!config) return [];
  const nowIso = (options.now || new Date()).toISOString();
  const nowMs = Date.parse(nowIso);
  const reservations: DecisionReservation[] = [];

  config.agents.forEach((agent) => {
    if (options.maxStarts !== undefined && reservations.length >= options.maxStarts) {
      return;
    }
    if (
      options.runtimeKey
      && agent.runtimeKey !== options.runtimeKey
      && agent.baseRuntimeKey !== options.runtimeKey
    ) {
      return;
    }
    const status = ensureStatus(runtime, agent, config.enabled);
    if (status.running) {
      return;
    }
    let reservationExpired = false;
    if (status.phase === 'deciding') {
      const expiresAt = Date.parse(status.decisionExpiresAt || '');
      if (Number.isFinite(expiresAt) && expiresAt > nowMs) return;
      reservationExpired = true;
      status.phase = 'idle';
      status.decisionToken = undefined;
      status.decisionExpiresAt = undefined;
    }
    if (!options.ignoreEnabled && (!config.enabled || !agent.enabled)) {
      status.status = 'disabled';
      status.phase = 'idle';
      status.lastDecision = 'disabled';
      status.lastDecisionReason = !config.enabled
        ? 'custom-agent config disabled'
        : 'custom agent disabled';
      status.lastError = null;
      return;
    }
    if (!options.force && !reservationExpired && !pollIsDue(status, agent.intervalSeconds, nowIso)) {
      return;
    }

    const singleton = findSingletonConflict(runtime, agent, nowMs);
    if (singleton) {
      status.status = 'blocked';
      status.phase = 'idle';
      status.lastDecision = 'blocked';
      status.lastDecisionReason = `singleton ${agent.singletonKey}=${agent.singletonValue} is already ${singleton.running ? 'running' : 'deciding'}`;
      status.lastError = status.lastDecisionReason;
      return;
    }

    const token = randomUUID();
    const decisionTimeoutMs = agent.decisionCommand?.timeoutMs || 0;
    status.lastPollAt = nowIso;
    status.phase = 'deciding';
    status.lastDecision = 'pending';
    status.lastDecisionReason = 'decision command running';
    status.lastError = null;
    status.decisionToken = token;
    status.decisionExpiresAt = new Date(nowMs + decisionTimeoutMs + 5_000).toISOString();
    reservations.push({ agent, token, reservedAt: nowIso });
  });
  return reservations;
}

function cancelDecisionReservations(
  runtime: RuntimeState,
  reservations: DecisionReservation[]
) {
  reservations.forEach(({ agent, token }) => {
    const status = runtime.customAgents[agent.runtimeKey];
    if (!status || status.decisionToken !== token) return;
    status.status = 'idle';
    status.phase = 'idle';
    status.lastPollAt = undefined;
    status.lastDecision = 'cancelled';
    status.lastDecisionReason = 'server stopped before custom-agent launch';
    status.lastError = null;
    status.decisionToken = undefined;
    status.decisionExpiresAt = undefined;
  });
}

function commitCustomAgentDecisions(
  rootDir: string,
  runtime: RuntimeState,
  outcomes: Array<{
    reservation: DecisionReservation;
    decision: Awaited<ReturnType<typeof decide>>;
  }>,
  options: PollOptions
) {
  const started: StartedCustomAgent[] = [];
  const pending: PendingCustomAgentStart[] = [];

  outcomes.forEach(({ reservation, decision }) => {
    const { agent, token, reservedAt: nowIso } = reservation;
    const status = runtime.customAgents[agent.runtimeKey];
    if (!status || status.running || status.decisionToken !== token) return;
    status.decisionToken = undefined;
    status.decisionExpiresAt = undefined;
    if (decision.error) {
      status.status = 'idle';
      status.phase = 'idle';
      status.lastDecision = 'error';
      status.lastDecisionReason = decision.error;
      status.lastError = decision.error;
      return;
    }
    if (!decision.shouldRun) {
      status.status = 'idle';
      status.phase = 'idle';
      status.lastDecision = 'skip';
      status.lastDecisionReason = decision.reason;
      status.lastError = null;
      return;
    }

    const singleton = findSingletonConflict(runtime, agent, Date.parse(nowIso));
    if (singleton) {
      status.status = 'blocked';
      status.phase = 'idle';
      status.lastDecision = 'blocked';
      status.lastDecisionReason = `singleton ${agent.singletonKey}=${agent.singletonValue} is already running`;
      status.lastError = status.lastDecisionReason;
      return;
    }

    const target = decision.target
      ? { ...agent.target, ...decision.target }
      : agent.target;
    const reservationId = token.replaceAll('-', '').slice(0, 12);
    const invocationId = `${slugify(agent.runtimeKey)}-${reservationId}-${slugify(nowIso)}`;
    const invocationDir = path.join(
      rootDir,
      '.autonomy',
      'runtime',
      'custom-agents',
      slugify(agent.runtimeKey),
      invocationId
    );
    const contextPath = path.join(invocationDir, 'context.json');
    const conversation = buildConversation(status, agent, options.serverInstanceId);
    ensureDir(invocationDir);
    writeJson(contextPath, buildRuntimeContext({
      rootDir,
      agent,
      target,
      decision: decision.payload,
      invocationId,
      invocationDir,
      contextPath,
      nowIso,
      conversation,
    }));

    Object.assign(status, {
      enabled: true,
      status: 'running',
      running: true,
      pid: null,
      target,
      startedAt: nowIso,
      finishedAt: null,
      invocationId,
      phase: 'scheduled',
      lastDecision: 'run',
      lastDecisionReason: decision.reason,
      lastError: null,
    });
    runtime.customAgentInvocations[invocationId] = {
      invocationId,
      runtimeKey: agent.runtimeKey,
      baseRuntimeKey: agent.baseRuntimeKey,
      agentId: agent.id,
      parallel: { slot: agent.parallelSlot, total: agent.parallelism },
      status: 'running',
      phase: 'scheduled',
      startedAt: nowIso,
      updatedAt: nowIso,
      target,
      workspace: { cwd: agent.workspacePath },
      paths: { invocationDir, contextPath },
      lastError: null,
    };
    const start: StartedCustomAgent = {
      runtimeKey: agent.runtimeKey,
      baseRuntimeKey: agent.baseRuntimeKey,
      parallelSlot: agent.parallelSlot,
      parallelism: agent.parallelism,
      invocationId,
      agentId: agent.id,
      target,
      reason: decision.reason,
      startedAt: nowIso,
      pid: null,
    };
    started.push(start);
    pending.push({
      runtimeKey: agent.runtimeKey,
      baseRuntimeKey: agent.baseRuntimeKey,
      parallelSlot: agent.parallelSlot,
      parallelism: agent.parallelism,
      invocationId,
      agentId: agent.id,
      target,
      startedAt: nowIso,
      runtimeContextPath: contextPath,
      conversation,
    });
  });

  return { started, pending };
}

async function decide(rootDir: string, agent: NormalizedCustomAgent) {
  if (agent.decisionMode === 'always') {
    return {
      shouldRun: true,
      reason: 'decision mode always',
      target: null,
      payload: { shouldRun: true, reason: 'decision mode always' },
      error: '',
    };
  }
  const command = agent.decisionCommand;
  if (!command) {
    return decisionError('decision command is not configured');
  }
  const envelope = {
    invocationId: '',
    runtimeKey: agent.runtimeKey,
    baseRuntimeKey: agent.baseRuntimeKey,
    parallel: { slot: agent.parallelSlot, total: agent.parallelism },
    agentId: agent.id,
    agentType: agent.kind,
    repoRoot: rootDir,
    phase: 'shouldRun',
    target: agent.target,
    workspace: { cwd: agent.workspacePath },
    paths: {},
    decision: {},
    previous: {},
    run: null,
  };
  const result = await runBufferedCommand({
    binary: command.command,
    args: command.args,
    cwd: command.cwd,
    env: {
      ...process.env,
      ...command.env,
      AUTONOMY_CUSTOM_AGENT_ID: agent.id,
      AUTONOMY_CUSTOM_AGENT_KIND: agent.kind,
      AUTONOMY_CUSTOM_AGENT_RUNTIME_KEY: agent.runtimeKey,
      AUTONOMY_CUSTOM_AGENT_BASE_RUNTIME_KEY: agent.baseRuntimeKey,
      AUTONOMY_CUSTOM_AGENT_SLOT: String(agent.parallelSlot),
      AUTONOMY_CUSTOM_AGENT_PARALLELISM: String(agent.parallelism),
      AUTONOMY_CUSTOM_AGENT_TARGET_ID: String(agent.target.id || ''),
      AUTONOMY_CUSTOM_AGENT_TARGET_TYPE: String(agent.target.type || ''),
      AUTONOMY_CUSTOM_AGENT_WORKSPACE: agent.workspacePath,
    },
    input: `${JSON.stringify(envelope)}\n`,
    shell: command.shell,
    timeoutMs: command.timeoutMs,
    captureFullStdout: true,
  });
  if (result.timedOut) {
    return decisionError(`decision command exceeded timeout of ${command.timeoutMs}ms`);
  }
  if (result.status !== 0) {
    return decisionError(
      `decision command exited ${result.status}: ${commandOutput(result.stderr, result.stdout)}`
    );
  }
  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    return {
      shouldRun: true,
      reason: 'decision command exited 0',
      target: null,
      payload: { shouldRun: true, reason: 'decision command exited 0' },
      error: '',
    };
  }
  try {
    const payload = JSON.parse(stdout);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return decisionError('decision command JSON must be an object');
    }
    return {
      shouldRun: payload.shouldRun === true,
      reason: String(payload.reason || (payload.shouldRun ? 'decision shouldRun=true' : 'decision shouldRun=false')),
      target: payload.target && typeof payload.target === 'object' ? payload.target : null,
      payload,
      error: '',
    };
  } catch (error) {
    return decisionError(`decision command must print JSON: ${extractError(error)}`);
  }
}

function decisionError(error: string) {
  return { shouldRun: false, reason: error, target: null, payload: {}, error };
}

function buildRuntimeContext(input: JsonRecord) {
  const agent = input.agent as NormalizedCustomAgent;
  return {
    schemaVersion: 1,
    invocationId: input.invocationId,
    runtimeKey: agent.runtimeKey,
    baseRuntimeKey: agent.baseRuntimeKey,
    parallel: { slot: agent.parallelSlot, total: agent.parallelism },
    rootDir: input.rootDir,
    startedAt: input.nowIso,
    kind: agent.kind,
    promptRole: agent.promptRole,
    promptIntro: agent.promptIntro,
    agent: {
      id: agent.id,
      target: input.target,
      workspace: agent.workspace,
      instructions: agent.instructions,
      promptPath: agent.promptPath,
    },
    target: input.target,
    workspacePath: agent.workspacePath,
    paths: {
      invocationDir: input.invocationDir,
      contextPath: input.contextPath,
    },
    spawn: {
      intervalSeconds: agent.intervalSeconds,
      parallelism: agent.parallelism,
    },
    conversation: input.conversation,
    context: agent.context,
    decision: input.decision,
    lifecycle: {
      environment: agent.environmentCommand,
      prompt: agent.promptCommand,
      finalize: agent.finalizeCommand,
    },
  };
}

function buildConversation(
  status: CustomAgentStatus,
  agent: NormalizedCustomAgent,
  serverInstanceId = ''
): CustomAgentConversation {
  if (agent.conversationMode === 'fresh') {
    return { mode: 'fresh', persist: false, key: '', resumeSessionId: '' };
  }
  const key = `${serverInstanceId || 'standalone'}:${agent.runtimeKey}`;
  return {
    mode: 'scoped',
    persist: true,
    key,
    resumeSessionId: status.conversationId || status.lastConversationId || '',
  };
}

function findSingletonConflict(
  runtime: RuntimeState,
  agent: NormalizedCustomAgent,
  nowMs: number
) {
  const active = Object.values(runtime.customAgents).filter((status) => {
    const decisionExpiresAt = Date.parse(status.decisionExpiresAt || '');
    const decisionActive = status.phase === 'deciding'
      && Number.isFinite(decisionExpiresAt)
      && decisionExpiresAt > nowMs;
    return status.runtimeKey !== agent.runtimeKey
      && (status.running || decisionActive)
      && status.singletonKey === agent.singletonKey
      && status.singletonValue === agent.singletonValue;
  });
  const foreignPool = active.find((status) => (
    (status.baseRuntimeKey || status.runtimeKey) !== agent.baseRuntimeKey
  ));
  if (foreignPool) return foreignPool;
  return active.length >= agent.parallelism ? active[0] : undefined;
}

function pollIsDue(status: CustomAgentStatus, intervalSeconds: number, nowIso: string) {
  const previous = Date.parse(status.lastPollAt || '');
  return !Number.isFinite(previous) || Date.parse(nowIso) - previous >= intervalSeconds * 1000;
}

function spawnCustomAgentProcess(
  rootDir: string,
  entry: PendingCustomAgentStart,
  options: TickOptions
) {
  const workerPath = fileURLToPath(new URL('./worker.js', import.meta.url));
  const detached = options.detached === true;
  const streamOutput = options.streamOutput === true;
  const child = spawn(process.execPath, [workerPath, 'run', '--context', entry.runtimeContextPath], {
    cwd: rootDir,
    detached: true,
    stdio: streamOutput ? 'inherit' : 'ignore',
    env: {
      ...process.env,
      AUTONOMY_CUSTOM_AGENT_CONTEXT: entry.runtimeContextPath,
      AUTONOMY_STREAM_WORKER_OUTPUT: streamOutput ? '1' : '',
    },
  });
  if (detached) {
    child.unref();
  }
  return child;
}

function commandOutput(...values: unknown[]) {
  return values.map((value) => String(value || '').trim()).filter(Boolean).join('\n') || 'no output';
}

export {
  listConfiguredCustomAgents,
  runSchedulerTick,
  spawnCustomAgentProcess,
};
