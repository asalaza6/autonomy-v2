import path from 'path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { AnyRecord, RuntimeState } from '../server-types.js';
import { CUSTOM_AGENT_WORKER_PATH } from './orchestrator-constants.js';
import { ensureDir, getPaths, readJson, writeJson } from './paths.js';

const DEFAULT_INTERVAL_SECONDS = 60;

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
    return {
      ...readJson(resolvedPath, {}),
      configPath: resolvedPath,
      configSource: customConfigPath,
      configIndex: index,
      configCount: customConfigPaths.length,
    };
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
  const decisionClient = options.customAgentDecisionClient || callDecisionEndpointSync;

  configs.forEach((config) => {
    const enabled = config.enabled !== false;
    const agents = Array.isArray(config.agents) ? config.agents : [];
    const context = normalizeContext(rootDir, config.context || {});
    const controlPanel = normalizeControlPanel(config.controlPanel || {});
    const agentTools = normalizeAgentTools(config.agentTools || {});

    agents.forEach((agent) => {
      const normalizedAgent = normalizeAgent(rootDir, agent, context, {
        config,
        agentTools,
        includeConfigInStatusKey: configs.length > 1,
      });
      const statusKey = getCustomAgentStatusKey(normalizedAgent);
      const status = ensureCustomAgentStatus(runtime, statusKey, normalizedAgent, enabled);
      status.enabled = enabled && normalizedAgent.enabled;
      status.kind = normalizedAgent.kind;
      status.configPath = normalizedAgent.configPath;
      status.target = normalizedAgent.target;
      status.workspacePath = normalizedAgent.workspacePath;
      status.singletonKey = normalizedAgent.singletonKey;
      status.singletonValue = normalizedAgent.singletonValue;
      status.intervalSeconds = normalizedAgent.intervalSeconds;
      status.offsetSeconds = normalizedAgent.offsetSeconds;
      status.tools = buildRuntimeToolStatus(normalizedAgent.tools);

    if (!enabled || !normalizedAgent.enabled) {
      status.status = 'disabled';
      status.running = false;
      status.lastDecision = 'disabled';
      status.lastDecisionReason = enabled
        ? 'agent disabled by custom-agent config'
        : 'custom-agent config disabled';
      status.lastError = null;
      return;
    }
    const configError = normalizedAgent.offsetError || normalizedAgent.toolError || normalizedAgent.decisionError;
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
    if (status.running === true) {
      return;
    }
    const pollEligibility = getPollEligibility(status, normalizedAgent.intervalSeconds, normalizedAgent.offsetSeconds, nowIso);
    if (!pollEligibility.due) {
      return;
    }

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
    const missingTool = findMissingToolEnv(normalizedAgent.tools);
    if (missingTool) {
      status.status = 'blocked';
      status.running = false;
      status.lastDecision = 'blocked';
      status.lastDecisionReason = `missing environment variable ${missingTool.authEnv} for tool "${missingTool.name}"`;
      status.lastError = status.lastDecisionReason;
      return;
    }

    const singletonBlocker = findActiveSingleton(runtime, normalizedAgent.singletonKey, normalizedAgent.singletonValue, statusKey);
    if (singletonBlocker) {
      status.status = 'blocked';
      status.running = false;
      status.lastDecision = 'blocked';
      status.lastDecisionReason = `singleton ${normalizedAgent.singletonKey}=${normalizedAgent.singletonValue} already running`;
      status.lastError = status.lastDecisionReason;
      return;
    }

    ensureDir(normalizedAgent.workspacePath);
    const runtimeContextPath = writeCustomAgentRuntimeContext(rootDir, statusKey, nowIso, {
      schemaVersion: 1,
      runtimeKey: statusKey,
      rootDir,
      kind: String(config.kind || ''),
      configPath: config.configPath,
      configSource: config.configSource,
      promptRole: String(config.promptRole || config.agentPromptRole || '').trim(),
      promptIntro: String(config.promptIntro || config.agentPromptIntro || '').trim(),
      agent: {
        ...pickRuntimeAgentFields(agent),
        id: normalizedAgent.agentId,
        target: normalizedAgent.target,
        workspace: normalizedAgent.workspace,
      },
      target: normalizedAgent.target,
      workspacePath: normalizedAgent.workspacePath,
      spawn: {
        intervalSeconds: normalizedAgent.intervalSeconds,
        offsetSeconds: normalizedAgent.offsetSeconds,
        pollWindowStart: pollEligibility.windowStart ?? null,
      },
      controlPanel: {
        baseUrl: controlPanel.baseUrl,
        authHeader: controlPanel.authHeader,
      },
      auth: {
        envKey,
        value: authValue,
      },
      tools: buildRuntimeTools(normalizedAgent.tools),
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
    pendingSpawnStarts.push({
      runtimeKey: statusKey,
      agentId: normalizedAgent.agentId,
      target: normalizedAgent.target,
      startedAt: nowIso,
      runtimeContextPath,
    });
    started.push({
      agentId: normalizedAgent.agentId,
      target: normalizedAgent.target,
      mode: 'custom-agent',
      reason: status.lastDecisionReason || 'decision shouldRun=true',
      pid: null,
      startedAt: nowIso,
    });
  });
  });

  return { started, pendingSpawnStarts, config: configs[0] || null, configs };
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
  const status = runtime.customAgents && runtime.customAgents[entry.runtimeKey];
  if (!status || status.startedAt !== entry.startedAt) {
    return;
  }
  status.status = 'idle';
  status.running = false;
  status.pid = null;
  status.finishedAt = new Date().toISOString();
  status.lastError = error instanceof Error ? error.message : String(error || 'custom agent spawn failed');
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
  const singletonKey = String(agent && agent.spawn && agent.spawn.singletonKey || 'target.id').trim();
  const singletonValue = resolveSingletonValue({ agentId, target, workspacePath }, singletonKey);
  const intervalSeconds = normalizePositiveNumber(agent && agent.spawn && agent.spawn.intervalSeconds, DEFAULT_INTERVAL_SECONDS);
  const offset = normalizeOffsetSeconds(agent && agent.spawn ? agent.spawn.offsetSeconds : undefined, intervalSeconds, agentId);
  const tools = normalizeGrantedTools(agent && agent.tools, options.agentTools || {});
  const decision = normalizeDecisionConfig(rootDir, agent && agent.spawn && agent.spawn.decision, agentId);
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
    context: effectiveContext,
    workspaceReadWrite: effectiveContext.workspaceReadWrite,
    authEnv: String(agent && agent.authEnv || '').trim(),
    spawnMode: String(agent && agent.spawn && agent.spawn.mode || '').trim(),
    intervalSeconds,
    offsetSeconds: offset.value,
    offsetError: offset.error,
    tools: tools.tools,
    toolError: tools.error,
    decisionSource: decision.source,
    decisionCommand: decision.command,
    decisionError: decision.error,
    singletonKey,
    singletonValue,
    decisionEndpoint: decision.endpoint,
  };
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

function findActiveSingleton(runtime: RuntimeState, singletonKey: string, singletonValue: string, currentStatusKey: string) {
  return Object.entries(runtime.customAgents || {}).find(([statusKey, status]) => {
    if (statusKey === currentStatusKey || !status || status.running !== true) {
      return false;
    }
    return status.singletonKey === singletonKey && status.singletonValue === singletonValue;
  }) || null;
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
      AUTONOMY_CUSTOM_AGENT_ID: String(agent.agentId || ''),
      AUTONOMY_CUSTOM_AGENT_KIND: String(agent.kind || ''),
      AUTONOMY_CUSTOM_AGENT_TARGET_ID: String(agent.target && agent.target.id || ''),
      AUTONOMY_CUSTOM_AGENT_TARGET_TYPE: String(agent.target && agent.target.type || ''),
      AUTONOMY_CUSTOM_AGENT_WORKSPACE: String(agent.workspacePath || ''),
      AUTONOMY_CUSTOM_AGENT_DECISION_CONTEXT: JSON.stringify(envContext),
      ...command.env,
    },
    shell: command.shell === true,
    stdio: ['ignore', 'pipe', 'pipe'],
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
  const safeStatusKey = slugify(statusKey);
  const safeStartedAt = slugify(startedAt);
  const contextDir = path.join(getPaths(rootDir).runtimeAutonomyDir, 'custom-agents', safeStatusKey, safeStartedAt);
  ensureDir(contextDir);
  const contextPath = path.join(contextDir, 'context.json');
  writeJson(contextPath, payload);
  return contextPath;
}

function normalizeCustomAgentConfigPaths(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  const normalized = String(value || '').trim();
  return normalized ? [normalized] : [];
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
    ? decision.command
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
      cwd: cwdValue ? resolvePathInside(rootDir, cwdValue, 'spawn.decision.command.cwd') : rootDir,
      env: normalizeStringMap((rawCommand as AnyRecord).env),
      shell: (rawCommand as AnyRecord).shell === true,
      timeoutMs,
      displayCommand: formatCommand(command, args),
    },
    error: null,
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

function getCustomAgentStatusKey(agent: AnyRecord) {
  const baseKey = `${agent.agentId}:${agent.target && agent.target.id || ''}`;
  return agent.statusKeyPrefix ? `${agent.statusKeyPrefix}:${baseKey}` : baseKey;
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
  markCustomAgentSpawnFailed,
  markCustomAgentSpawned,
  pollCustomAgents,
  refreshCustomAgentRuntime,
  spawnCustomAgentProcess,
};
