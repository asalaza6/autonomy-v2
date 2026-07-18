import path from 'path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { AnyRecord, RuntimeState } from '../server-types.js';
import { acquireStateLock } from '../../lock/lock-main.js';
import { loadRuntime, writeRuntime } from './orchestrator-state.js';
import { CUSTOM_AGENT_WORKER_PATH } from './orchestrator-constants.js';
import { ensureDir, getPaths, readJson, writeJson } from './paths.js';

const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_PARALLELISM = 1;
const MAX_PARALLELISM = 32;
const DEFAULT_CONVERSATION_SCOPE = ['server.instanceId', 'agent.id', 'target.id', 'date.local'];
const DEFAULT_CUSTOM_AGENT_CONTEXT = {
  globalReadOnly: [
    'prompts/autonomous/v2/project-context.md',
    'prompts/autonomous/v2/config/agents.json',
    'prompts/autonomous/v2/config/control-plane.json',
    'prompts/autonomous/v2/config/sprint.json',
    'package.json',
  ],
  workspaceReadWrite: [
    '.autonomy/runtime/custom-lifecycle',
    '.autonomy/worktrees/shadow-architecture-agent',
    '.autonomy/worktrees/shadow-reviewer-agent',
    'prompts/autonomous/v2/specs',
  ],
  allowRuntimeStateChanges: true,
};

function loadCustomAgentConfig(rootDir: string): AnyRecord | null {
  const configs = loadCustomAgentConfigs(rootDir);
  return configs[0] || null;
}

function loadCustomAgentConfigs(rootDir: string): AnyRecord[] {
  const controlPlanePath = path.join(getPaths(rootDir).configDir, 'control-plane.json');
  const controlPlaneConfig = readJson(controlPlanePath, null);
  const customConfigPaths = normalizeCustomAgentConfigPaths(controlPlaneConfig && controlPlaneConfig.spawnCustomAgents);
  if (customConfigPaths.length === 0) {
    return [];
  }
  return customConfigPaths.map((customConfigPath, index) => {
    const resolvedPath = resolvePathInside(rootDir, customConfigPath, 'spawnCustomAgents');
    return expandCustomAgentConfig(rootDir, readJson(resolvedPath, {}), {
      controlPlaneConfig,
      configPath: resolvedPath,
      configSource: customConfigPath,
      configIndex: index,
      configCount: customConfigPaths.length,
    });
  });
}

function refreshCustomAgentRuntime(runtime: RuntimeState, nowIso = new Date().toISOString()) {
  Object.values(runtime.customAgents || {}).forEach((status) => {
    if (!status || status.running !== true) {
      return;
    }
    if (status.pid && isProcessAlive(status.pid)) {
      return;
    }
    status.running = false;
    status.status = 'idle';
    status.finishedAt = status.finishedAt || nowIso;
    status.pid = null;
    if (!status.lastError) {
      status.lastError = 'custom agent process exited before reporting result';
    }
    markCustomAgentInvocationFailed(runtime, {
      runtimeKey: status.runtimeKey,
      invocationId: status.invocationId,
    }, status.lastError, nowIso);
  });
}

function pollCustomAgents(rootDir: string, runtime: RuntimeState, options: AnyRecord = {}) {
  const nowIso = resolveNowIso(options);
  const configs = loadCustomAgentConfigs(rootDir);
  if (configs.length === 0) {
    return { started: [], pendingSpawnStarts: [], config: null, configs: [] };
  }
  runtime.customAgents = runtime.customAgents || {};

  const started = [];
  const pendingSpawnStarts = [];
  const decisionCountsByPool = new Map<string, number>();
  const decisionClient = options.customAgentDecisionClient || callDecisionEndpointSync;

  const configuredEntries = configs.flatMap((config) => {
    const enabled = config.enabled !== false;
    const agents = Array.isArray(config.agents) ? config.agents : [];
    const context = normalizeContext(rootDir, config.context || {});
    const controlPanel = normalizeControlPanel(config.controlPanel || {});
    const agentTools = normalizeAgentTools(config.agentTools || {});

    return agents.flatMap((agent) => {
      const normalizedAgent = normalizeAgent(rootDir, agent, context, {
        config,
        agentTools,
        includeConfigInStatusKey: configs.length > 1,
      });
      return expandCustomAgentParallelSlots(rootDir, normalizedAgent)
        .sort((left, right) => compareCustomAgentPollPriority(runtime, left, right))
        .map((parallelAgent) => ({
          agent,
          config,
          controlPanel,
          enabled,
          normalizedAgent: parallelAgent,
        }));
    });
  });
  applyExpandedAgentValidation(configuredEntries.map((entry) => entry.normalizedAgent));

  configuredEntries.forEach(({ agent, config, controlPanel, enabled, normalizedAgent }) => {
      const statusKey = getCustomAgentStatusKey(normalizedAgent);
      const requestedRuntimeKey = String(options.customAgentRuntimeKey || '').trim();
      if (requestedRuntimeKey && statusKey !== requestedRuntimeKey && normalizedAgent.baseRuntimeKey !== requestedRuntimeKey) {
        return;
      }
      const maxStarts = normalizeOptionalLimit(options.maxCustomAgentStarts);
      if (maxStarts !== null && pendingSpawnStarts.length >= maxStarts) {
        return;
      }
      const enabledOverride = getCustomAgentEnabledOverride(runtime, statusKey, normalizedAgent.baseRuntimeKey);
      const agentEnabled = enabledOverride ?? normalizedAgent.enabled;
      const status = ensureCustomAgentStatus(runtime, statusKey, normalizedAgent, enabled);
      const wasRunning = status.running === true;
      status.configEnabled = enabled;
      status.defaultEnabled = normalizedAgent.enabled;
      status.enabledOverride = enabledOverride;
      status.enabledSource = typeof enabledOverride === 'boolean' ? 'runtime' : 'config';
      status.enabled = enabled && agentEnabled;
      status.kind = normalizedAgent.kind;
      status.configPath = normalizedAgent.configPath;
      status.configSource = normalizedAgent.configSource;
      status.target = wasRunning && status.target ? status.target : normalizedAgent.target;
      status.workspacePath = wasRunning && status.workspacePath ? status.workspacePath : normalizedAgent.workspacePath;
      status.singletonKey = wasRunning && status.singletonKey ? status.singletonKey : normalizedAgent.singletonKey;
      status.singletonValue = wasRunning && status.singletonValue ? status.singletonValue : normalizedAgent.singletonValue;
      status.intervalSeconds = normalizedAgent.intervalSeconds;
      status.offsetSeconds = normalizedAgent.offsetSeconds;
      status.runtimeKey = statusKey;
      status.baseRuntimeKey = normalizedAgent.baseRuntimeKey;
      status.parallelSlot = wasRunning && Number.isInteger(status.parallelSlot) ? status.parallelSlot : normalizedAgent.parallelSlot;
      status.parallelism = wasRunning && Number.isInteger(status.parallelism) ? status.parallelism : normalizedAgent.parallelism;
      status.tools = buildRuntimeToolStatus(normalizedAgent.tools);

    if (options.ignoreCustomAgentEnabled !== true && (!enabled || !agentEnabled)) {
      const isRunning = status.running === true;
      status.status = isRunning ? status.status || 'running' : 'disabled';
      status.running = isRunning;
      status.lastDecision = 'disabled';
      status.lastDecisionReason = enabled
        ? typeof enabledOverride === 'boolean'
          ? 'agent disabled by control-plane override'
          : 'agent disabled by custom-agent config'
        : 'custom-agent config disabled';
      status.lastError = null;
      return;
    }
    if (status.running === true) {
      return;
    }
    const configError = normalizedAgent.expansionError || normalizedAgent.presetError || normalizedAgent.parallelError || normalizedAgent.offsetError || normalizedAgent.toolError || normalizedAgent.decisionError || normalizedAgent.lifecycleError;
    if (configError) {
      status.status = 'blocked';
      status.running = false;
      status.lastDecision = 'invalid_config';
      status.lastDecisionReason = configError;
      status.lastError = configError;
      return;
    }
    if (normalizedAgent.spawnMode !== 'poll') {
      status.status = 'idle';
      status.lastDecision = 'unsupported';
      status.lastDecisionReason = `unsupported spawn mode "${normalizedAgent.spawnMode || ''}"`;
      return;
    }
    const pollEligibility = options.forceCustomAgentPoll === true
      ? { due: true, windowStart: null }
      : getPollEligibility(status, normalizedAgent.intervalSeconds, normalizedAgent.offsetSeconds, nowIso);
    if (!pollEligibility.due) {
      return;
    }
    const maxDecisionsPerPool = normalizeOptionalLimit(options.maxCustomAgentDecisionsPerPool);
    const poolDecisionCount = decisionCountsByPool.get(normalizedAgent.baseRuntimeKey) || 0;
    if (maxDecisionsPerPool !== null && poolDecisionCount >= maxDecisionsPerPool) {
      return;
    }

    decisionCountsByPool.set(normalizedAgent.baseRuntimeKey, poolDecisionCount + 1);
    status.lastPollAt = nowIso;
    if (typeof pollEligibility.windowStart === 'number') {
      status.lastPollWindowStart = pollEligibility.windowStart;
    }
    const envKey = normalizedAgent.authEnv;
    let authValue = envKey ? process.env[envKey] : '';
    let decision;
    if (normalizedAgent.decisionSource === 'remote') {
      if (!envKey || !authValue) {
        status.status = 'blocked';
        status.running = false;
        status.lastDecision = 'blocked';
        status.lastDecisionReason = envKey
          ? `missing environment variable ${envKey}`
          : 'missing agent authEnv';
        status.lastError = status.lastDecisionReason;
        return;
      }

      try {
        decision = decisionClient({
          url: joinUrl(controlPanel.baseUrl, normalizedAgent.decisionEndpoint),
          headers: controlPanel.authHeader
            ? { [controlPanel.authHeader]: authValue }
            : {},
          agent: normalizedAgent,
          config,
        });
      } catch (error) {
        status.status = 'idle';
        status.running = false;
        status.lastDecision = 'error';
        status.lastDecisionReason = 'decision request failed';
        status.lastError = error instanceof Error ? error.message : String(error || 'decision request failed');
        return;
      }
    } else if (normalizedAgent.decisionSource === 'command') {
      authValue = '';
      try {
        decision = runLocalDecisionCommandSync(rootDir, normalizedAgent);
      } catch (error) {
        status.status = 'idle';
        status.running = false;
        status.lastDecision = 'error';
        status.lastDecisionReason = 'local decision command failed';
        status.lastError = error instanceof Error ? error.message : String(error || 'local decision command failed');
        return;
      }
    } else {
      authValue = '';
      decision = {
        shouldRun: true,
        reason: 'decision mode always',
      };
    }

    const shouldRun = decision && decision.shouldRun === true;
    status.lastDecision = shouldRun ? 'run' : 'skip';
    status.lastDecisionReason = normalizeDecisionReason(decision);
    status.lastError = null;
    if (!shouldRun) {
      status.status = 'idle';
      status.running = false;
      return;
    }
    const invocationTarget = decision && decision.target && typeof decision.target === 'object'
      ? { ...normalizedAgent.target, ...decision.target }
      : normalizedAgent.target;
    const missingTool = findMissingToolEnv(normalizedAgent.tools);
    if (missingTool) {
      status.status = 'blocked';
      status.running = false;
      status.lastDecision = 'blocked';
      status.lastDecisionReason = `missing environment variable ${missingTool.authEnv} for tool "${missingTool.name}"`;
      status.lastError = status.lastDecisionReason;
      return;
    }

    const singletonBlocker = findActiveSingleton(runtime, normalizedAgent, statusKey);
    if (singletonBlocker) {
      status.status = 'blocked';
      status.running = false;
      status.lastDecision = 'blocked';
      status.lastDecisionReason = `singleton ${normalizedAgent.singletonKey}=${normalizedAgent.singletonValue} already running`;
      status.lastError = status.lastDecisionReason;
      return;
    }

    ensureDir(normalizedAgent.workspacePath);
    const conversation = buildCustomAgentConversationContext(status, normalizedAgent, invocationTarget, decision, {
      nowIso,
      serverInstanceId: options.serverInstanceId,
    });
    status.conversationMode = conversation.mode;
    status.conversationKey = conversation.key;
    status.conversationScope = conversation.scope;
    const invocationId = buildCustomAgentInvocationId(statusKey, nowIso);
    const invocationDir = getCustomAgentInvocationDir(rootDir, statusKey, nowIso);
    const runtimeContextPath = writeCustomAgentRuntimeContext(rootDir, statusKey, nowIso, {
      schemaVersion: 1,
      invocationId,
      runtimeKey: statusKey,
      baseRuntimeKey: normalizedAgent.baseRuntimeKey,
      parallel: {
        slot: normalizedAgent.parallelSlot,
        total: normalizedAgent.parallelism,
      },
      rootDir,
      startedAt: nowIso,
      kind: String(config.kind || ''),
      configPath: config.configPath,
      configSource: config.configSource,
      promptRole: String(config.promptRole || config.agentPromptRole || '').trim(),
      promptIntro: String(config.promptIntro || config.agentPromptIntro || '').trim(),
      agent: {
        ...pickRuntimeAgentFields(agent),
        id: normalizedAgent.agentId,
        target: invocationTarget,
        workspace: normalizedAgent.workspace,
      },
      target: invocationTarget,
      workspacePath: normalizedAgent.workspacePath,
      paths: {
        invocationDir,
        contextPath: path.join(invocationDir, 'context.json'),
      },
      spawn: {
        intervalSeconds: normalizedAgent.intervalSeconds,
        offsetSeconds: normalizedAgent.offsetSeconds,
        pollWindowStart: pollEligibility.windowStart ?? null,
      },
      controlPanel: {
        baseUrl: controlPanel.baseUrl,
        authHeader: controlPanel.authHeader,
      },
      conversation,
      auth: {
        envKey,
        value: authValue,
      },
      tools: buildRuntimeTools(normalizedAgent.tools),
      lifecycle: normalizedAgent.lifecycle,
      context: {
        globalReadOnly: normalizedAgent.context.globalReadOnly,
        workspaceReadWrite: normalizedAgent.context.workspaceReadWrite,
        allowRuntimeStateChanges: normalizedAgent.context.allowRuntimeStateChanges,
      },
      decision,
    });
    status.status = 'running';
    status.running = true;
    status.startedAt = nowIso;
    status.finishedAt = null;
    status.pid = null;
    status.invocationId = invocationId;
    runtime.customAgentInvocations = runtime.customAgentInvocations || {};
    runtime.customAgentInvocations[invocationId] = {
      invocationId,
      runtimeKey: statusKey,
      baseRuntimeKey: normalizedAgent.baseRuntimeKey,
      agentId: normalizedAgent.agentId,
      parallel: {
        slot: normalizedAgent.parallelSlot,
        total: normalizedAgent.parallelism,
      },
      status: 'running',
      phase: 'scheduled',
      startedAt: nowIso,
      updatedAt: nowIso,
      target: invocationTarget,
      workspace: {
        cwd: normalizedAgent.workspacePath,
      },
      conversation,
      paths: {
        invocationDir,
        contextPath: runtimeContextPath,
      },
      lastError: null,
    };
    pendingSpawnStarts.push({
      runtimeKey: statusKey,
      baseRuntimeKey: normalizedAgent.baseRuntimeKey,
      parallelSlot: normalizedAgent.parallelSlot,
      parallelism: normalizedAgent.parallelism,
      invocationId,
      agentId: normalizedAgent.agentId,
      target: invocationTarget,
      startedAt: nowIso,
      runtimeContextPath,
      conversation,
    });
    started.push({
      runtimeKey: statusKey,
      baseRuntimeKey: normalizedAgent.baseRuntimeKey,
      parallelSlot: normalizedAgent.parallelSlot,
      parallelism: normalizedAgent.parallelism,
      agentId: normalizedAgent.agentId,
      target: invocationTarget,
      mode: 'custom-agent',
      reason: status.lastDecisionReason || 'decision shouldRun=true',
      pid: null,
      startedAt: nowIso,
    });
  });

  return { started, pendingSpawnStarts, config: configs[0] || null, configs };
}

function listConfiguredCustomAgentSlots(rootDir: string, runtime: RuntimeState | null | undefined = null) {
  const configs = loadCustomAgentConfigs(rootDir);
  const runtimeState = runtime || { workers: {} };
  const entries = configs.flatMap((config) => {
    const enabled = config.enabled !== false;
    const agents = Array.isArray(config.agents) ? config.agents : [];
    const context = normalizeContext(rootDir, config.context || {});
    const agentTools = normalizeAgentTools(config.agentTools || {});
    return agents.flatMap((agent) => {
      const normalizedAgent = normalizeAgent(rootDir, agent, context, {
        config,
        agentTools,
        includeConfigInStatusKey: configs.length > 1,
      });
      return expandCustomAgentParallelSlots(rootDir, normalizedAgent).map((normalizedAgent) => ({
        config,
        enabled,
        normalizedAgent,
      }));
    });
  });
  applyExpandedAgentValidation(entries.map((entry) => entry.normalizedAgent));

  const configuredSlots: AnyRecord[] = entries.map(({ config, enabled, normalizedAgent }) => {
      const runtimeKey = getCustomAgentStatusKey(normalizedAgent);
      const status: AnyRecord = runtimeState.customAgents && runtimeState.customAgents[runtimeKey]
        ? runtimeState.customAgents[runtimeKey]
        : {};
      const enabledOverride = getCustomAgentEnabledOverride(runtimeState, runtimeKey, normalizedAgent.baseRuntimeKey);
      const agentEnabled = enabledOverride ?? normalizedAgent.enabled;
      const configError = normalizedAgent.expansionError || normalizedAgent.presetError || normalizedAgent.parallelError || normalizedAgent.offsetError || normalizedAgent.toolError || normalizedAgent.decisionError || normalizedAgent.lifecycleError || null;
      const running = status.running === true;
      const parallelSlot = running && Number.isInteger(status.parallelSlot)
        ? status.parallelSlot
        : normalizedAgent.parallelSlot;
      const parallelism = running && Number.isInteger(status.parallelism)
        ? status.parallelism
        : normalizedAgent.parallelism;
      const workspacePath = running && status.workspacePath
        ? status.workspacePath
        : normalizedAgent.workspacePath;
      const displayAgent = {
        ...normalizedAgent,
        parallelSlot,
        parallelism,
        workspacePath,
      };
      return {
        runtimeKey,
        baseRuntimeKey: normalizedAgent.baseRuntimeKey,
        parallelSlot,
        parallelism,
        configuredParallelism: normalizedAgent.parallelism,
        agentId: normalizedAgent.agentId,
        kind: normalizedAgent.kind,
        configPath: normalizedAgent.configPath,
        configSource: normalizedAgent.configSource,
        configIndex: config.configIndex,
        configCount: config.configCount,
        configEnabled: enabled,
        defaultEnabled: normalizedAgent.enabled,
        enabledOverride,
        enabledSource: typeof enabledOverride === 'boolean' ? 'runtime' : 'config',
        enabled: enabled && agentEnabled,
        status: status.status || (enabled && agentEnabled ? 'idle' : 'disabled'),
        running,
        pid: status.pid ?? null,
        phase: status.phase || null,
        target: normalizedAgent.target,
        workspacePath,
        singletonKey: normalizedAgent.singletonKey,
        singletonValue: normalizedAgent.singletonValue,
        intervalSeconds: normalizedAgent.intervalSeconds,
        offsetSeconds: normalizedAgent.offsetSeconds,
        lastPollAt: status.lastPollAt || null,
        lastDecision: status.lastDecision || null,
        lastDecisionReason: status.lastDecisionReason || null,
        lastError: status.lastError || configError,
        conversationMode: status.conversationMode || normalizedAgent.conversation.mode || null,
        conversationKey: status.conversationKey || null,
        conversationScope: status.conversationScope || normalizedAgent.conversation.scope || null,
        conversationId: status.conversationId || status.lastConversationId || null,
        tools: status.tools || buildRuntimeToolStatus(normalizedAgent.tools),
        decisionSource: normalizedAgent.decisionSource,
        lifecycle: Object.fromEntries(Object.entries(normalizedAgent.lifecycle || {})
          .filter(([, command]) => Boolean(command))
          .map(([phase, command]) => [phase, {
            command: command && typeof command === 'object' ? (command as AnyRecord).displayCommand || (command as AnyRecord).command || true : true,
          }])),
        detail: describeConfiguredCustomAgent({
          status,
          normalizedAgent: displayAgent,
          enabled,
          agentEnabled,
          enabledOverride,
          configError,
        }),
      };
  });

  const configuredRuntimeKeys = new Set(configuredSlots.map((slot) => slot.runtimeKey));
  const configuredPools = new Map<string, AnyRecord>();
  configuredSlots.forEach((slot) => {
    if (!configuredPools.has(slot.baseRuntimeKey)) {
      configuredPools.set(slot.baseRuntimeKey, slot);
    }
  });
  Object.entries(runtimeState.customAgents || {}).forEach(([runtimeKey, status]) => {
    if (!status || status.running !== true || configuredRuntimeKeys.has(runtimeKey)) {
      return;
    }
    const baseRuntimeKey = String(status.baseRuntimeKey || '').trim();
    const configured = configuredPools.get(baseRuntimeKey);
    if (!configured) {
      return;
    }
    const parallelSlot = Number.isInteger(status.parallelSlot) ? status.parallelSlot : 1;
    configuredSlots.push({
      ...configured,
      runtimeKey,
      baseRuntimeKey,
      parallelSlot,
      parallelism: Number.isInteger(status.parallelism) ? status.parallelism : Math.max(configured.parallelism, parallelSlot),
      agentId: status.agentId || configured.agentId,
      status: status.status || 'running',
      running: true,
      pid: status.pid ?? null,
      phase: status.phase || null,
      target: status.target || configured.target,
      workspacePath: status.workspacePath || configured.workspacePath,
      lastPollAt: status.lastPollAt || null,
      lastDecision: status.lastDecision || null,
      lastDecisionReason: status.lastDecisionReason || null,
      lastError: status.lastError || null,
      conversationMode: status.conversationMode || null,
      conversationKey: status.conversationKey || null,
      conversationScope: status.conversationScope || null,
      conversationId: status.conversationId || status.lastConversationId || null,
      tools: status.tools || configured.tools,
      retired: true,
      detail: `${configured.agentId} | slot=${parallelSlot}/${status.parallelism || parallelSlot} | running | retired slot draining | workspace=${status.workspacePath || configured.workspacePath}`,
    });
  });
  return configuredSlots;
}

function listConfiguredCustomAgents(rootDir: string, runtime: RuntimeState | null | undefined = null): AnyRecord[] {
  const pools = new Map<string, AnyRecord[]>();
  listConfiguredCustomAgentSlots(rootDir, runtime).forEach((slot) => {
    const slots = pools.get(slot.baseRuntimeKey) || [];
    slots.push(slot);
    pools.set(slot.baseRuntimeKey, slots);
  });
  return [...pools.values()].map((slots) => {
    slots.sort((left, right) => left.parallelSlot - right.parallelSlot);
    const base = slots[0];
    const runningSlots = slots.filter((slot) => slot.running === true);
    const representative = runningSlots[0] || slots.reduce((latest, slot) => {
      return Date.parse(slot.lastPollAt || '') > Date.parse(latest.lastPollAt || '') ? slot : latest;
    }, base);
    const runningCount = runningSlots.length;
    const configuredParallelism = base.configuredParallelism || base.parallelism;
    return {
      ...base,
      runtimeKey: base.baseRuntimeKey,
      parallelism: configuredParallelism,
      status: runningCount > 0 ? 'running' : representative.status,
      running: runningCount > 0,
      runningCount,
      pid: representative.pid,
      phase: representative.phase,
      lastPollAt: representative.lastPollAt,
      lastDecision: representative.lastDecision,
      lastDecisionReason: representative.lastDecisionReason,
      lastError: representative.lastError,
      conversationMode: representative.conversationMode,
      conversationKey: representative.conversationKey,
      conversationId: representative.conversationId,
      slots: slots.map((slot) => ({
        runtimeKey: slot.runtimeKey,
        parallelSlot: slot.parallelSlot,
        parallelism: slot.parallelism,
        workspacePath: slot.workspacePath,
        status: slot.status,
        running: slot.running,
        pid: slot.pid,
        phase: slot.phase,
        lastDecision: slot.lastDecision,
        lastDecisionReason: slot.lastDecisionReason,
        lastError: slot.lastError,
        retired: slot.retired === true,
      })),
      detail: `${base.detail} | running=${runningCount}/${configuredParallelism}`,
    };
  });
}

function setCustomAgentEnabledOverride(rootDir: string, runtimeKey: string, enabled: boolean) {
  const normalizedRuntimeKey = String(runtimeKey || '').trim();
  if (!normalizedRuntimeKey) {
    throw new Error('Missing custom agent runtimeKey.');
  }
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    const knownAgents = listConfiguredCustomAgents(rootDir, runtime);
    const knownAgent = knownAgents.find((agent) => agent.runtimeKey === normalizedRuntimeKey);
    if (!knownAgent) {
      throw new Error(`Unknown custom agent runtimeKey "${normalizedRuntimeKey}".`);
    }
    runtime.customAgentEnabledOverrides = {
      ...(runtime.customAgentEnabledOverrides || {}),
      [normalizedRuntimeKey]: enabled === true,
    };
    runtime.customAgents = runtime.customAgents || {};
    const previousStatus: AnyRecord = runtime.customAgents[normalizedRuntimeKey] || {};
    const isRunning = previousStatus.running === true;
    runtime.customAgents[normalizedRuntimeKey] = {
      agentId: knownAgent.agentId,
      ...previousStatus,
      enabledOverride: enabled === true,
      enabledSource: 'runtime',
      enabled: knownAgent.configEnabled !== false && enabled === true,
      status: enabled === true && knownAgent.configEnabled !== false
        ? isRunning ? previousStatus.status || 'running' : 'idle'
        : isRunning ? previousStatus.status || 'running' : 'disabled',
      running: isRunning,
      updatedAt: new Date().toISOString(),
      lastDecision: enabled === true ? previousStatus.lastDecision || null : 'disabled',
      lastDecisionReason: enabled === true
        ? previousStatus.lastDecisionReason || null
        : 'agent disabled by control-plane override',
    };
    writeRuntime(rootDir, runtime);
    return listConfiguredCustomAgents(rootDir, runtime).find((agent) => agent.runtimeKey === normalizedRuntimeKey) || null;
  } finally {
    release();
  }
}

function getCustomAgentEnabledOverride(runtime: AnyRecord | null | undefined, runtimeKey: string, baseRuntimeKey = runtimeKey) {
  const overrides = runtime && runtime.customAgentEnabledOverrides && typeof runtime.customAgentEnabledOverrides === 'object'
    ? runtime.customAgentEnabledOverrides
    : {};
  if (typeof overrides[runtimeKey] === 'boolean') {
    return overrides[runtimeKey];
  }
  return baseRuntimeKey !== runtimeKey && typeof overrides[baseRuntimeKey] === 'boolean'
    ? overrides[baseRuntimeKey]
    : undefined;
}

function describeConfiguredCustomAgent(input: AnyRecord) {
  const parts = [];
  const status = input.status || {};
  const agent = input.normalizedAgent || {};
  if (input.configError) {
    parts.push(input.configError);
  }
  if (input.enabled === false) {
    parts.push('custom-agent config disabled');
  } else if (input.agentEnabled === false) {
    parts.push(typeof input.enabledOverride === 'boolean'
      ? 'disabled by control-plane override'
      : 'disabled by custom-agent config');
  }
  if (agent.target && agent.target.id) {
    parts.push(`target=${agent.target.id}`);
  }
  if (agent.parallelism > 1) {
    parts.push(`slot=${agent.parallelSlot}/${agent.parallelism}`);
  }
  if (status.lastDecision) {
    parts.push(`decision=${status.lastDecision}`);
  }
  if (status.lastDecisionReason) {
    parts.push(String(status.lastDecisionReason).split('\n')[0]);
  }
  if (status.workspacePath || agent.workspacePath) {
    parts.push(`workspace=${status.workspacePath || agent.workspacePath}`);
  }
  return parts.join(' | ') || 'custom agent configured';
}

function spawnCustomAgentProcess(rootDir: string, entry: AnyRecord, options: AnyRecord = {}) {
  if (typeof options.customAgentSpawner === 'function') {
    return options.customAgentSpawner(rootDir, entry);
  }
  const streamOutput = options.streamOutput === true;
  const child = spawn(process.execPath, [CUSTOM_AGENT_WORKER_PATH, 'run', '--context', entry.runtimeContextPath], {
    cwd: rootDir,
    stdio: streamOutput ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    detached: !streamOutput,
    env: {
      ...process.env,
      AUTONOMY_CUSTOM_AGENT_CONTEXT: entry.runtimeContextPath,
      AUTONOMY_STREAM_WORKER_OUTPUT: streamOutput ? '1' : (process.env.AUTONOMY_STREAM_WORKER_OUTPUT || ''),
    },
  });
  if (!streamOutput) {
    child.unref();
  }
  return child;
}

function markCustomAgentSpawned(runtime: RuntimeState, entry: AnyRecord, pid: number | null | undefined) {
  const status = runtime.customAgents && runtime.customAgents[entry.runtimeKey];
  if (!status || status.startedAt !== entry.startedAt || status.status !== 'running') {
    return;
  }
  status.pid = pid ?? null;
}

function markCustomAgentSpawnFailed(runtime: RuntimeState, entry: AnyRecord, error: unknown) {
  const finishedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error || 'custom agent spawn failed');
  const status = runtime.customAgents && runtime.customAgents[entry.runtimeKey];
  if (status && status.startedAt === entry.startedAt && status.invocationId === entry.invocationId) {
    status.status = 'idle';
    status.running = false;
    status.pid = null;
    status.finishedAt = finishedAt;
    status.lastError = message;
  }
  markCustomAgentInvocationFailed(runtime, entry, message, finishedAt);
}

function markCustomAgentInvocationFailed(runtime: RuntimeState, entry: AnyRecord, error: unknown, finishedAt: string) {
  const invocationId = String(entry.invocationId || '').trim();
  if (!invocationId) {
    return;
  }
  const invocation = runtime.customAgentInvocations && runtime.customAgentInvocations[invocationId];
  if (!invocation || (entry.runtimeKey && invocation.runtimeKey !== entry.runtimeKey)) {
    return;
  }
  invocation.status = 'failed';
  invocation.phase = invocation.phase === 'scheduled' ? 'spawn' : invocation.phase || 'failed';
  invocation.finishedAt = finishedAt;
  invocation.updatedAt = finishedAt;
  invocation.lastError = error instanceof Error ? error.message : String(error || 'custom agent process failed');
}

function normalizeControlPanel(controlPanel: AnyRecord) {
  return {
    baseUrl: String(controlPanel.baseUrl || '').trim(),
    authHeader: String(controlPanel.authHeader || '').trim(),
  };
}

function normalizeContext(rootDir: string, context: AnyRecord) {
  return {
    globalReadOnly: normalizeStringArray(context.globalReadOnly)
      .map((entry) => {
        const resolvedPath = resolvePathInside(rootDir, entry, 'context.globalReadOnly');
        return {
          name: path.basename(resolvedPath),
          relativePath: path.relative(rootDir, resolvedPath),
          path: resolvedPath,
        };
      }),
    workspaceReadWrite: normalizeStringArray(context.workspaceReadWrite)
      .map((entry) => normalizeWorkspaceFileName(entry)),
    allowRuntimeStateChanges: context.allowRuntimeStateChanges === true,
  };
}

function normalizeAgent(rootDir: string, agent: AnyRecord, context: AnyRecord, options: AnyRecord = {}) {
  const agentId = String(agent && agent.id || '').trim();
  const effectiveContext = mergeAgentContext(rootDir, context, agent && agent.context);
  const target = {
    ...(agent && agent.target && typeof agent.target === 'object' ? agent.target : {}),
    type: String(agent && agent.target && agent.target.type || agent && agent.targetType || '').trim(),
    id: String(agent && agent.target && agent.target.id || agent && agent.targetId || agentId).trim(),
  };
  const workspace = String(agent && agent.workspace || '').trim()
    || path.join('.autonomy', 'runtime', 'custom-agent-workspaces', slugify(agentId), slugify(target.id));
  const workspacePath = resolvePathInside(rootDir, workspace, `${agentId}.workspace`);
  const parallel = normalizeParallelism(agent && agent.spawn && agent.spawn.parallelism, agentId);
  const parallelError = parallel.error || (parallel.value > 1 && workspacePath === path.resolve(rootDir)
    ? `invalid spawn.parallelism for "${agentId}": repository-root workspaces cannot run in parallel`
    : null);
  const singletonKey = String(agent && agent.spawn && agent.spawn.singletonKey || 'target.id').trim();
  const singletonValue = resolveSingletonValue({ agentId, target, workspacePath }, singletonKey);
  const intervalSeconds = normalizePositiveNumber(agent && agent.spawn && agent.spawn.intervalSeconds, DEFAULT_INTERVAL_SECONDS);
  const offset = normalizeOffsetSeconds(agent && agent.spawn ? agent.spawn.offsetSeconds : undefined, intervalSeconds, agentId);
  const tools = normalizeGrantedTools(agent && agent.tools, options.agentTools || {});
  const decision = normalizeDecisionConfig(rootDir, agent && agent.spawn && agent.spawn.decision, agentId);
  const lifecycle = normalizeLifecycleConfig(rootDir, agent, agentId);
  const conversation = normalizeConversationConfig(agent && agent.conversation);
  return {
    ...agent,
    agentId,
    kind: String(options.config && options.config.kind || '').trim(),
    configPath: String(options.config && options.config.configPath || '').trim(),
    configSource: String(options.config && options.config.configSource || '').trim(),
    statusKeyPrefix: options.includeConfigInStatusKey ? slugify(String(options.config && (options.config.configSource || options.config.configPath) || 'custom-agents')) : '',
    enabled: agent && agent.enabled !== false,
    target,
    workspace,
    workspacePath,
    parallelSlot: 1,
    parallelism: parallel.value,
    parallelError,
    context: effectiveContext,
    workspaceReadWrite: effectiveContext.workspaceReadWrite,
    authEnv: String(agent && agent.authEnv || '').trim(),
    spawnMode: String(agent && agent.spawn && agent.spawn.mode || '').trim(),
    intervalSeconds,
    offsetSeconds: offset.value,
    offsetError: offset.error,
    presetError: String(agent && agent.presetError || '').trim(),
    tools: tools.tools,
    toolError: tools.error,
    decisionSource: decision.source,
    decisionCommand: decision.command,
    decisionError: decision.error,
    lifecycle: lifecycle.config,
    lifecycleError: lifecycle.error,
    conversation,
    singletonKey,
    singletonValue,
    decisionEndpoint: decision.endpoint,
  };
}

function expandCustomAgentParallelSlots(rootDir: string, agent: AnyRecord): AnyRecord[] {
  const baseRuntimeKey = getCustomAgentBaseStatusKey(agent);
  return Array.from({ length: agent.parallelism || DEFAULT_PARALLELISM }, (_, index) => {
    const parallelSlot = index + 1;
    const workspace = agent.parallelism === DEFAULT_PARALLELISM
      ? agent.workspace
      : path.join(`${path.normalize(agent.workspace)}-slots`, `slot-${parallelSlot}`);
    return {
      ...agent,
      baseRuntimeKey,
      parallelSlot,
      workspace,
      workspacePath: resolvePathInside(rootDir, workspace, `${agent.agentId}.workspace`),
    };
  });
}

function compareCustomAgentPollPriority(runtime: RuntimeState, left: AnyRecord, right: AnyRecord) {
  const leftStatus = runtime.customAgents && runtime.customAgents[getCustomAgentStatusKey(left)];
  const rightStatus = runtime.customAgents && runtime.customAgents[getCustomAgentStatusKey(right)];
  const leftPollAt = Date.parse(String(leftStatus && leftStatus.lastPollAt || ''));
  const rightPollAt = Date.parse(String(rightStatus && rightStatus.lastPollAt || ''));
  const leftPriority = Number.isFinite(leftPollAt) ? leftPollAt : Number.NEGATIVE_INFINITY;
  const rightPriority = Number.isFinite(rightPollAt) ? rightPollAt : Number.NEGATIVE_INFINITY;
  return leftPriority - rightPriority || left.parallelSlot - right.parallelSlot;
}

function applyExpandedAgentValidation(agents: AnyRecord[]) {
  const runtimeKeys = new Map<string, AnyRecord[]>();
  const workspaces = new Map<string, AnyRecord[]>();
  agents.forEach((agent) => {
    const runtimeKey = getCustomAgentStatusKey(agent);
    runtimeKeys.set(runtimeKey, [...(runtimeKeys.get(runtimeKey) || []), agent]);
    workspaces.set(agent.workspacePath, [...(workspaces.get(agent.workspacePath) || []), agent]);
  });

  runtimeKeys.forEach((colliding, runtimeKey) => {
    if (colliding.length < 2) {
      return;
    }
    const poolKeys = new Set(colliding.map((agent) => agent.baseRuntimeKey));
    agents.filter((agent) => poolKeys.has(agent.baseRuntimeKey)).forEach((agent) => {
      appendExpandedAgentError(agent, `expanded runtime key "${runtimeKey}" is not unique`);
    });
  });

  workspaces.forEach((colliding, workspacePath) => {
    const poolKeys = new Set(colliding.map((agent) => agent.baseRuntimeKey));
    if (colliding.length < 2 || poolKeys.size < 2 || !colliding.some((agent) => agent.parallelism > 1)) {
      return;
    }
    agents.filter((agent) => poolKeys.has(agent.baseRuntimeKey)).forEach((agent) => {
      appendExpandedAgentError(agent, `parallel workspace "${workspacePath}" is shared by multiple custom agents`);
    });
  });
}

function appendExpandedAgentError(agent: AnyRecord, message: string) {
  const existing = String(agent.expansionError || '').trim();
  agent.expansionError = existing ? `${existing}; ${message}` : message;
}

function ensureCustomAgentStatus(runtime: RuntimeState, statusKey: string, agent: AnyRecord, configEnabled: boolean) {
  runtime.customAgents = runtime.customAgents || {};
  runtime.customAgents[statusKey] = {
    agentId: agent.agentId,
    enabled: configEnabled && agent.enabled,
    target: agent.target,
    status: 'idle',
    running: false,
    pid: null,
    workspacePath: agent.workspacePath,
    ...(runtime.customAgents[statusKey] || {}),
  };
  return runtime.customAgents[statusKey];
}

function buildCustomAgentConversationContext(
  status: AnyRecord,
  agent: AnyRecord,
  target: AnyRecord,
  decision: AnyRecord,
  options: AnyRecord = {}
) {
  const nowIso = String(options.nowIso || '').trim();
  const config = agent.conversation || {};
  if (config.mode === 'fresh' || config.mode === 'none' || config.reuse === false) {
    return {
      mode: config.mode || 'fresh',
      key: '',
      scope: config.scope || [],
      resumeSessionId: '',
      persist: false,
    };
  }

  const scope = Array.isArray(config.scope) && config.scope.length > 0
    ? config.scope
    : DEFAULT_CONVERSATION_SCOPE;
  const key = buildConversationKey(scope, {
    agent,
    target,
    decision,
    kind: agent.kind,
    workspace: agent.workspacePath,
    server: {
      instanceId: String(options.serverInstanceId || 'standalone').trim() || 'standalone',
    },
    nowIso,
    timeZone: config.timeZone || config.timezone,
  });
  return {
    mode: config.mode || 'scoped',
    key,
    scope,
    resumeSessionId: getCustomAgentConversationId(status, key),
    persist: true,
  };
}

function getCustomAgentConversationId(status: AnyRecord, conversationKey = '') {
  const scopedId = conversationKey && status.conversations && status.conversations[conversationKey]
    ? status.conversations[conversationKey].conversationId || status.conversations[conversationKey]
    : '';
  const sameConversationKey = status.conversationKey && status.conversationKey === conversationKey;
  const currentConversationId = sameConversationKey
    ? status.conversationId
    : '';
  const currentLastConversationId = sameConversationKey
    ? status.lastConversationId || status.lastResult && status.lastResult.conversationId
    : '';
  return String(
    scopedId
      || currentConversationId
      || currentLastConversationId
      || ''
  ).trim();
}

function buildConversationKey(scope: unknown[], context: AnyRecord) {
  return scope
    .map((entry) => resolveConversationScopeValue(String(entry || '').trim(), context))
    .map((entry) => slugify(String(entry || 'missing')))
    .join(':') || 'custom';
}

function resolveConversationScopeValue(token: string, context: AnyRecord) {
  if (!token) {
    return '';
  }
  if (token.startsWith('literal:')) {
    return token.slice('literal:'.length);
  }
  if (token === 'date' || token === 'date.utc') {
    return formatConversationDate(context.nowIso, 'UTC');
  }
  if (token === 'date.local') {
    return formatConversationDate(context.nowIso, String(context.timeZone || process.env.TZ || 'UTC'));
  }
  if (token === 'workspace') {
    return context.workspace;
  }
  return readPath(context, token);
}

function formatConversationDate(nowIso: string, timeZone: string) {
  const date = new Date(nowIso);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function readPath(value: AnyRecord, dottedPath: string) {
  return dottedPath.split('.').reduce((current, segment) => {
    if (!current || typeof current !== 'object') {
      return '';
    }
    return current[segment];
  }, value);
}

function findActiveSingleton(runtime: RuntimeState, agent: AnyRecord, currentStatusKey: string) {
  const active = Object.entries(runtime.customAgents || {}).filter(([statusKey, status]) => {
    if (statusKey === currentStatusKey || !status || status.running !== true) {
      return false;
    }
    return status.singletonKey === agent.singletonKey && status.singletonValue === agent.singletonValue;
  });
  const foreignPool = active.find(([statusKey, status]) => {
    return String(status.baseRuntimeKey || statusKey) !== agent.baseRuntimeKey;
  });
  if (foreignPool) {
    return foreignPool;
  }
  return active.length >= agent.parallelism ? active[0] : null;
}

function getPollEligibility(status: AnyRecord, intervalSeconds: number, offsetSeconds: number | null, nowIso: string) {
  if (typeof offsetSeconds === 'number') {
    return getOffsetPollEligibility(status, intervalSeconds, offsetSeconds, nowIso);
  }
  return {
    due: pollIsDue(status, intervalSeconds, nowIso),
    windowStart: null,
  };
}

function getOffsetPollEligibility(status: AnyRecord, intervalSeconds: number, offsetSeconds: number, nowIso: string) {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return { due: false, windowStart: null };
  }
  const nowSeconds = Math.floor(nowMs / 1000);
  const windowStart = Math.floor(nowSeconds / intervalSeconds) * intervalSeconds;
  const eligibleAt = windowStart + offsetSeconds;
  if (nowSeconds < eligibleAt) {
    return { due: false, windowStart };
  }
  if (Number(status.lastPollWindowStart) === windowStart) {
    return { due: false, windowStart };
  }
  return { due: true, windowStart };
}

function pollIsDue(status: AnyRecord, intervalSeconds: number, nowIso: string) {
  const lastPollMs = Date.parse(status.lastPollAt || '');
  if (!Number.isFinite(lastPollMs)) {
    return true;
  }
  const nowMs = Date.parse(nowIso);
  return nowMs - lastPollMs >= intervalSeconds * 1000;
}

function callDecisionEndpointSync(request: { url: string; headers: Record<string, string> }) {
  const script = `
const [url, headersJson] = process.argv.slice(1);
const headers = JSON.parse(headersJson || '{}');
fetch(url, { method: 'GET', headers }).then(async (response) => {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(response.status + ' ' + text);
  }
  process.stdout.write(text);
}).catch((error) => {
  console.error(error && error.message ? error.message : String(error));
  process.exit(1);
});
`;
  const result = spawnSync(process.execPath, ['-e', script, request.url, JSON.stringify(request.headers || {})], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(sanitizeDecisionRequestError(result.stderr || result.stdout || 'decision request failed'));
  }
  return JSON.parse(result.stdout || '{}');
}

function runLocalDecisionCommandSync(rootDir: string, agent: AnyRecord) {
  const command = agent.decisionCommand;
  if (!command || !command.command) {
    throw new Error('local decision command is not configured');
  }
  const envContext = {
    runtimeKey: getCustomAgentStatusKey(agent),
    baseRuntimeKey: agent.baseRuntimeKey || getCustomAgentBaseStatusKey(agent),
    parallel: {
      slot: agent.parallelSlot || DEFAULT_PARALLELISM,
      total: agent.parallelism || DEFAULT_PARALLELISM,
    },
    agentId: agent.agentId,
    kind: agent.kind || '',
    target: agent.target || {},
    workspacePath: agent.workspacePath || '',
    intervalSeconds: agent.intervalSeconds,
    offsetSeconds: agent.offsetSeconds,
  };
  const result = spawnSync(command.command, command.args || [], {
    cwd: command.cwd || rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...command.env,
      AUTONOMY_CUSTOM_AGENT_ID: String(agent.agentId || ''),
      AUTONOMY_CUSTOM_AGENT_KIND: String(agent.kind || ''),
      AUTONOMY_CUSTOM_AGENT_RUNTIME_KEY: String(getCustomAgentStatusKey(agent)),
      AUTONOMY_CUSTOM_AGENT_BASE_RUNTIME_KEY: String(agent.baseRuntimeKey || getCustomAgentBaseStatusKey(agent)),
      AUTONOMY_CUSTOM_AGENT_SLOT: String(agent.parallelSlot || DEFAULT_PARALLELISM),
      AUTONOMY_CUSTOM_AGENT_PARALLELISM: String(agent.parallelism || DEFAULT_PARALLELISM),
      AUTONOMY_CUSTOM_AGENT_TARGET_ID: String(agent.target && agent.target.id || ''),
      AUTONOMY_CUSTOM_AGENT_TARGET_TYPE: String(agent.target && agent.target.type || ''),
      AUTONOMY_CUSTOM_AGENT_WORKSPACE: String(agent.workspacePath || ''),
      AUTONOMY_CUSTOM_AGENT_DECISION_CONTEXT: JSON.stringify(envContext),
    },
    input: `${JSON.stringify({
      invocationId: '',
      runtimeKey: getCustomAgentStatusKey(agent),
      baseRuntimeKey: agent.baseRuntimeKey || getCustomAgentBaseStatusKey(agent),
      parallel: {
        slot: agent.parallelSlot || DEFAULT_PARALLELISM,
        total: agent.parallelism || DEFAULT_PARALLELISM,
      },
      agentId: String(agent.agentId || ''),
      agentType: String(agent.kind || ''),
      repoRoot: rootDir,
      phase: 'shouldRun',
      target: agent.target || {},
      workspace: {
        cwd: String(agent.workspacePath || ''),
      },
      paths: {},
      decision: {},
      previous: {},
      run: null,
    })}\n`,
    shell: command.shell === true,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: Number(command.timeoutMs || 30_000),
  });
  const output = collectCommandOutput(result.stdout, result.stderr);
  if (result.error) {
    throw new Error(`${command.displayCommand || command.command} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = output || result.signal || 'no output';
    throw new Error(`${command.displayCommand || command.command} exited ${result.status}: ${detail}`);
  }
  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    return {
      shouldRun: true,
      reason: 'local decision command exited 0',
    };
  }
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object') {
      return parsed;
    }
    if (parsed === true || parsed === false) {
      return {
        shouldRun: parsed,
        reason: `local decision command returned ${parsed}`,
      };
    }
  } catch (error) {
    throw new Error(`local decision command must print JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error('local decision command JSON must be an object or boolean');
}

function sanitizeDecisionRequestError(value: string) {
  const text = String(value || '').trim();
  return text || 'decision request failed';
}

function writeCustomAgentRuntimeContext(rootDir: string, statusKey: string, startedAt: string, payload: AnyRecord) {
  const contextDir = getCustomAgentInvocationDir(rootDir, statusKey, startedAt);
  ensureDir(contextDir);
  const contextPath = path.join(contextDir, 'context.json');
  writeJson(contextPath, payload);
  return contextPath;
}

function getCustomAgentInvocationDir(rootDir: string, statusKey: string, startedAt: string) {
  return path.join(getPaths(rootDir).runtimeAutonomyDir, 'custom-agents', slugify(statusKey), slugify(startedAt));
}

function buildCustomAgentInvocationId(statusKey: string, startedAt: string) {
  return `${slugify(statusKey)}-${slugify(startedAt)}`;
}

function normalizeCustomAgentConfigPaths(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  const normalized = String(value || '').trim();
  return normalized ? [normalized] : [];
}

function expandCustomAgentConfig(rootDir: string, config: AnyRecord, metadata: AnyRecord) {
  const rawConfig = config && typeof config === 'object' ? config : {};
  const rawAgents = Array.isArray(rawConfig.agents) ? rawConfig.agents : [];
  const hasPresetAgents = rawAgents.some((agent) => getPresetAgentId(agent));
  const defaultConfig = hasPresetAgents
    ? buildDefaultCustomLifecycleConfig(metadata.controlPlaneConfig || {})
    : {};
  const expandedConfig = mergePlainRecords(defaultConfig, rawConfig);
  const agents = rawAgents.map((agent) => expandCustomAgentPreset(agent, {
    controlPlaneConfig: metadata.controlPlaneConfig || {},
    configContext: rawConfig.context,
  }));
  return {
    ...expandedConfig,
    agents,
    configPath: metadata.configPath,
    configSource: metadata.configSource,
    configIndex: metadata.configIndex,
    configCount: metadata.configCount,
  };
}

function buildDefaultCustomLifecycleConfig(controlPlaneConfig: AnyRecord) {
  const label = String(controlPlaneConfig && (controlPlaneConfig.label || controlPlaneConfig.repoId) || 'Autonomy').trim();
  const repoId = String(controlPlaneConfig && controlPlaneConfig.repoId || '').trim();
  return {
    kind: repoId ? `${repoId}-lifecycle-agents` : 'custom-lifecycle-agents',
    enabled: true,
    promptRole: `${label} command-driven autonomy agent`,
  };
}

function expandCustomAgentPreset(agent: unknown, options: AnyRecord) {
  const override = agent && typeof agent === 'object' ? agent as AnyRecord : {};
  const presetAgentId = getPresetAgentId(override);
  if (!presetAgentId) {
    return override;
  }
  const preset = getDefaultCustomAgentPreset(presetAgentId, options.controlPlaneConfig || {});
  if (!preset) {
    return {
      ...override,
      id: String(override.id || presetAgentId).trim(),
      presetAgentId,
      presetError: `unknown custom-agent presetAgentId "${presetAgentId}"`,
    };
  }
  const presetWithContext = {
    ...preset,
    context: mergePlainRecords(DEFAULT_CUSTOM_AGENT_CONTEXT, options.configContext || {}),
  };
  return mergePlainRecords(presetWithContext, override);
}

function getPresetAgentId(agent: unknown) {
  if (!agent || typeof agent !== 'object') {
    return '';
  }
  const record = agent as AnyRecord;
  return String(record.presetAgentId || record.presetId || '').trim();
}

function getDefaultCustomAgentPreset(presetAgentId: string, controlPlaneConfig: AnyRecord) {
  const repoId = String(controlPlaneConfig && controlPlaneConfig.repoId || '').trim() || 'repo';
  const presets = {
    'shadow-pm-agent': {
      presetAgentId: 'shadow-pm-agent',
      id: 'shadow-pm-agent',
      type: 'pm',
      enabled: true,
      target: {
        type: 'prd-backlog',
        id: repoId,
      },
      context: DEFAULT_CUSTOM_AGENT_CONTEXT,
      workspace: '.',
      spawn: {
        mode: 'poll',
        intervalSeconds: 60,
        offsetSeconds: 10,
        singletonKey: 'agent.id',
        decision: {
          command: [
            'node',
            'agents/pm/should-run.mjs',
          ],
        },
      },
      environment: {
        command: [
          'node',
          'agents/pm/prepare-env.mjs',
        ],
      },
      execution: {
        prompt: {
          command: [
            'node',
            'agents/pm/build-prompt.mjs',
          ],
        },
      },
      finalize: {
        command: [
          'node',
          'agents/pm/finalize.mjs',
        ],
      },
    },
    'shadow-architecture-agent': {
      presetAgentId: 'shadow-architecture-agent',
      id: 'shadow-architecture-agent',
      type: 'implementation',
      enabled: true,
      target: {
        type: 'task-queue',
        id: 'shadow-architecture-agent',
      },
      context: DEFAULT_CUSTOM_AGENT_CONTEXT,
      workspace: '.',
      spawn: {
        mode: 'poll',
        intervalSeconds: 60,
        offsetSeconds: 20,
        singletonKey: 'target.id',
        decision: {
          command: [
            'node',
            'agents/architecture/should-run.mjs',
          ],
        },
      },
      environment: {
        command: [
          'node',
          'agents/architecture/prepare-env.mjs',
        ],
      },
      execution: {
        prompt: {
          command: [
            'node',
            'agents/architecture/build-prompt.mjs',
          ],
        },
      },
      finalize: {
        command: [
          'node',
          'agents/architecture/finalize.mjs',
        ],
      },
    },
    'shadow-reviewer-agent': {
      presetAgentId: 'shadow-reviewer-agent',
      id: 'shadow-reviewer-agent',
      type: 'review',
      enabled: true,
      target: {
        type: 'review-queue',
        id: 'shadow-reviewer-agent',
      },
      context: DEFAULT_CUSTOM_AGENT_CONTEXT,
      workspace: '.',
      spawn: {
        mode: 'poll',
        intervalSeconds: 60,
        offsetSeconds: 30,
        singletonKey: 'target.id',
        decision: {
          command: [
            'node',
            'agents/reviewer/should-run.mjs',
          ],
        },
      },
      environment: {
        command: [
          'node',
          'agents/reviewer/prepare-env.mjs',
        ],
      },
      execution: {
        prompt: {
          command: [
            'node',
            'agents/reviewer/build-prompt.mjs',
          ],
        },
      },
      finalize: {
        command: [
          'node',
          'agents/reviewer/finalize.mjs',
        ],
      },
    },
  };
  return presets[presetAgentId] || null;
}

function mergePlainRecords(base: unknown, override: unknown) {
  const baseRecord = isPlainRecord(base) ? base as AnyRecord : {};
  const overrideRecord = isPlainRecord(override) ? override as AnyRecord : {};
  const merged: AnyRecord = { ...baseRecord };
  for (const [key, value] of Object.entries(overrideRecord)) {
    const baseValue = merged[key];
    merged[key] = key === 'decision'
      ? value
      : isPlainRecord(baseValue) && isPlainRecord(value)
      ? mergePlainRecords(baseValue, value)
      : value;
  }
  return merged;
}

function isPlainRecord(value: unknown) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function mergeAgentContext(rootDir: string, defaultContext: AnyRecord, agentContext: AnyRecord | null | undefined) {
  const context = agentContext && typeof agentContext === 'object' ? agentContext : {};
  return {
    globalReadOnly: Object.prototype.hasOwnProperty.call(context, 'globalReadOnly')
      ? normalizeContext(rootDir, { globalReadOnly: context.globalReadOnly }).globalReadOnly
      : defaultContext.globalReadOnly,
    workspaceReadWrite: Object.prototype.hasOwnProperty.call(context, 'workspaceReadWrite')
      ? normalizeContext(rootDir, { workspaceReadWrite: context.workspaceReadWrite }).workspaceReadWrite
      : defaultContext.workspaceReadWrite,
    allowRuntimeStateChanges: Object.prototype.hasOwnProperty.call(context, 'allowRuntimeStateChanges')
      ? context.allowRuntimeStateChanges === true
      : defaultContext.allowRuntimeStateChanges === true,
  };
}

function normalizeAgentTools(agentTools: AnyRecord) {
  return Object.fromEntries(Object.entries(agentTools || {}).map(([name, value]) => {
    const tool = value && typeof value === 'object' ? value as AnyRecord : {};
    return [name, {
      name,
      baseUrl: String(tool.baseUrl || '').trim(),
      authHeader: String(tool.authHeader || '').trim(),
    }];
  }));
}

function normalizeConversationConfig(value: unknown) {
  const raw = value && typeof value === 'object' ? value as AnyRecord : {};
  const mode = String(raw.mode || '').trim().toLowerCase();
  const scope = normalizeStringArray(raw.scope || raw.key);
  return {
    mode: ['fresh', 'none', 'scoped'].includes(mode) ? mode : 'scoped',
    scope,
    timeZone: String(raw.timeZone || raw.timezone || '').trim(),
    reuse: raw.reuse !== false,
  };
}

function normalizeGrantedTools(agentToolGrants: AnyRecord, configuredTools: AnyRecord) {
  const grants = agentToolGrants && typeof agentToolGrants === 'object' ? agentToolGrants : {};
  const tools = {};
  for (const [name, grantValue] of Object.entries(grants)) {
    const configuredTool = configuredTools[name];
    if (!configuredTool) {
      return {
        tools,
        error: `agent tool "${name}" is not defined in agentTools`,
      };
    }
    const grant = grantValue && typeof grantValue === 'object' ? grantValue as AnyRecord : {};
    const authEnv = String(grant.authEnv || '').trim();
    if (!authEnv) {
      return {
        tools,
        error: `agent tool "${name}" is missing authEnv`,
      };
    }
    tools[name] = {
      name,
      baseUrl: configuredTool.baseUrl,
      authHeader: configuredTool.authHeader,
      authEnv,
    };
  }
  return { tools, error: null };
}

function findMissingToolEnv(tools: AnyRecord) {
  return Object.values(tools || {}).find((tool: AnyRecord) => {
    const authEnv = String(tool && tool.authEnv || '').trim();
    return !authEnv || !process.env[authEnv];
  }) as AnyRecord | undefined;
}

function buildRuntimeTools(tools: AnyRecord) {
  return Object.fromEntries(Object.entries(tools || {}).map(([name, toolValue]) => {
    const tool = toolValue as AnyRecord;
    const authEnv = String(tool.authEnv || '').trim();
    return [name, {
      baseUrl: String(tool.baseUrl || '').trim(),
      authHeader: String(tool.authHeader || '').trim(),
      authEnv,
      value: authEnv ? String(process.env[authEnv] || '') : '',
    }];
  }));
}

function buildRuntimeToolStatus(tools: AnyRecord) {
  return Object.fromEntries(Object.entries(tools || {}).map(([name, toolValue]) => {
    const tool = toolValue as AnyRecord;
    const authEnv = String(tool.authEnv || '').trim();
    return [name, {
      baseUrl: String(tool.baseUrl || '').trim(),
      authHeader: String(tool.authHeader || '').trim(),
      authEnv,
      envPresent: Boolean(authEnv && process.env[authEnv]),
    }];
  }));
}

function resolvePathInside(rootDir: string, relativePath: string, label: string) {
  const resolved = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve inside the repository root.`);
  }
  return resolved;
}

function normalizeWorkspaceFileName(value: string) {
  const normalized = path.normalize(String(value || '').trim());
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`context.workspaceReadWrite entry "${value}" must be relative to the custom workspace.`);
  }
  return normalized;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
}

function normalizeStringMap(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [String(key || '').trim(), String(entry ?? '')])
    .filter(([key]) => Boolean(key)));
}

function normalizePositiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeParallelism(value: unknown, agentId: string) {
  if (typeof value === 'undefined' || value === null || value === '') {
    return { value: DEFAULT_PARALLELISM, error: null };
  }
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= DEFAULT_PARALLELISM && parsed <= MAX_PARALLELISM) {
    return { value: parsed, error: null };
  }
  return {
    value: DEFAULT_PARALLELISM,
    error: `invalid spawn.parallelism for "${agentId}": expected an integer between ${DEFAULT_PARALLELISM} and ${MAX_PARALLELISM}`,
  };
}

function normalizeOptionalLimit(value: unknown) {
  if (typeof value === 'undefined' || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeDecisionConfig(rootDir: string, value: unknown, agentId: string) {
  const decision = value && typeof value === 'object' ? value as AnyRecord : {};
  const mode = String(decision.mode || '').trim().toLowerCase();
  if (mode && !['remote', 'command', 'always'].includes(mode)) {
    return {
      source: 'remote',
      endpoint: '',
      command: null,
      error: `invalid spawn.decision.mode for "${agentId}": expected remote, command, or always`,
    };
  }
  if (mode === 'always' || decision.always === true) {
    return {
      source: 'always',
      endpoint: '',
      command: null,
      error: null,
    };
  }
  if (mode === 'command' || Object.prototype.hasOwnProperty.call(decision, 'command')) {
    const command = normalizeDecisionCommandConfig(rootDir, decision);
    return {
      source: 'command',
      endpoint: '',
      command: command.config,
      error: command.error
        ? `invalid spawn.decision.command for "${agentId}": ${command.error}`
        : null,
    };
  }
  return {
    source: 'remote',
    endpoint: String(decision.endpoint || '').trim(),
    command: null,
    error: null,
  };
}

function normalizeDecisionCommandConfig(rootDir: string, decision: AnyRecord) {
  const rawCommand = Object.prototype.hasOwnProperty.call(decision, 'command')
    ? (hasCommandObjectOptions(decision) ? decision : decision.command)
    : decision;
  if (typeof rawCommand === 'string') {
    const command = rawCommand.trim();
    return command
      ? {
        config: {
          command,
          args: [] as string[],
          cwd: rootDir,
          env: {} as Record<string, string>,
          shell: true,
          timeoutMs: 30_000,
          displayCommand: command,
        },
        error: null,
      }
      : { config: null, error: 'command is empty' };
  }
  if (Array.isArray(rawCommand)) {
    const [commandValue, ...argValues] = rawCommand;
    const command = String(commandValue || '').trim();
    const args = argValues.map((arg) => String(arg));
    return command
      ? {
        config: {
          command,
          args,
          cwd: rootDir,
          env: {} as Record<string, string>,
          shell: false,
          timeoutMs: 30_000,
          displayCommand: formatCommand(command, args),
        },
        error: null,
      }
      : { config: null, error: 'command array is empty' };
  }
  if (!rawCommand || typeof rawCommand !== 'object') {
    return { config: null, error: 'command must be a string, array, or object' };
  }
  const command = String((rawCommand as AnyRecord).command || '').trim();
  if (!command) {
    return { config: null, error: 'command is empty' };
  }
  const args = Array.isArray((rawCommand as AnyRecord).args)
    ? (rawCommand as AnyRecord).args.map((arg) => String(arg))
    : [];
  const cwdValue = String((rawCommand as AnyRecord).cwd || '').trim();
  const timeoutMs = normalizePositiveNumber((rawCommand as AnyRecord).timeoutMs, 30_000);
  return {
    config: {
      command,
      args,
      cwd: cwdValue ? resolvePathInside(rootDir, cwdValue, 'command.cwd') : rootDir,
      env: normalizeStringMap((rawCommand as AnyRecord).env),
      shell: (rawCommand as AnyRecord).shell === true,
      timeoutMs,
      displayCommand: formatCommand(command, args),
    },
    error: null,
  };
}

function hasCommandObjectOptions(value: AnyRecord) {
  return ['args', 'cwd', 'env', 'shell', 'timeoutMs'].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function normalizeLifecycleConfig(rootDir: string, agent: AnyRecord, agentId: string) {
  const phases = {
    environment: normalizeOptionalCommandConfig(rootDir, agent && agent.environment, `${agentId}.environment`),
    prompt: normalizeOptionalCommandConfig(rootDir, agent && agent.execution && agent.execution.prompt, `${agentId}.execution.prompt`),
    finalize: normalizeOptionalCommandConfig(rootDir, agent && agent.finalize, `${agentId}.finalize`),
  };
  const error = Object.entries(phases)
    .map(([phase, result]) => result.error ? `${phase}: ${result.error}` : '')
    .filter(Boolean)
    .join('; ');
  return {
    config: Object.fromEntries(Object.entries(phases).map(([phase, result]) => [phase, result.config])),
    error: error || null,
  };
}

function normalizeOptionalCommandConfig(rootDir: string, value: unknown, label: string) {
  if (!value || typeof value !== 'object') {
    return { config: null, error: null };
  }
  const record = value as AnyRecord;
  if (!Object.prototype.hasOwnProperty.call(record, 'command')) {
    return { config: null, error: null };
  }
  const command = normalizeDecisionCommandConfig(rootDir, record);
  return {
    config: command.config,
    error: command.error ? `invalid ${label}.command: ${command.error}` : null,
  };
}

function normalizeOffsetSeconds(value: unknown, intervalSeconds: number, agentId: string) {
  if (typeof value === 'undefined' || value === null || value === '') {
    return { value: null, error: null };
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0 && parsed < intervalSeconds) {
    return { value: parsed, error: null };
  }
  return {
    value: null,
    error: `invalid spawn.offsetSeconds for "${agentId}": expected >= 0 and < intervalSeconds (${intervalSeconds})`,
  };
}

function normalizeDecisionReason(decision: AnyRecord) {
  return String(
    decision && (
      decision.reason
      || decision.decisionReason
      || decision.message
      || (decision.shouldRun === true ? 'decision shouldRun=true' : 'decision shouldRun=false')
    ) || ''
  ).trim();
}

function getCustomAgentBaseStatusKey(agent: AnyRecord) {
  const baseKey = `${agent.agentId}:${agent.target && agent.target.id || ''}`;
  return agent.statusKeyPrefix ? `${agent.statusKeyPrefix}:${baseKey}` : baseKey;
}

function getCustomAgentStatusKey(agent: AnyRecord) {
  const baseRuntimeKey = agent.baseRuntimeKey || getCustomAgentBaseStatusKey(agent);
  return Number(agent.parallelSlot || DEFAULT_PARALLELISM) > DEFAULT_PARALLELISM
    ? `${baseRuntimeKey}#${agent.parallelSlot}`
    : baseRuntimeKey;
}

function resolveSingletonValue(input: AnyRecord, singletonKey: string) {
  if (singletonKey === 'target.id') {
    return String(input.target && input.target.id || '').trim();
  }
  if (singletonKey === 'target.type') {
    return String(input.target && input.target.type || '').trim();
  }
  if (singletonKey === 'agent.id') {
    return String(input.agentId || '').trim();
  }
  if (singletonKey === 'workspace') {
    return String(input.workspacePath || '').trim();
  }
  return String(input.target && input.target.id || input.agentId || '').trim();
}

function pickRuntimeAgentFields(agent: AnyRecord) {
  const picked = { ...agent };
  delete picked.authEnv;
  return picked;
}

function collectCommandOutput(...parts: unknown[]) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args].map((part) => {
    return /\s/.test(part) ? JSON.stringify(part) : part;
  }).join(' ');
}

function joinUrl(baseUrl: string, endpoint: string) {
  if (!baseUrl) {
    return endpoint;
  }
  if (!endpoint) {
    return baseUrl;
  }
  return `${baseUrl.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
}

function slugify(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'custom';
}

function resolveNowIso(options: AnyRecord) {
  return String(options.nowIso || '').trim() || new Date().toISOString();
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
    return stat ? !stat.includes('Z') : true;
  } catch (_) {
    return false;
  }
}

export {
  loadCustomAgentConfig,
  loadCustomAgentConfigs,
  listConfiguredCustomAgents,
  markCustomAgentSpawnFailed,
  markCustomAgentSpawned,
  pollCustomAgents,
  refreshCustomAgentRuntime,
  setCustomAgentEnabledOverride,
  spawnCustomAgentProcess,
};
