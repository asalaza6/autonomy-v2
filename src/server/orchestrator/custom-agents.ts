import path from 'path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { AnyRecord, RuntimeState } from '../server-types.js';
import { CUSTOM_AGENT_WORKER_PATH } from './orchestrator-constants.js';
import { ensureDir, getPaths, readJson, writeJson } from './paths.js';

const DEFAULT_INTERVAL_SECONDS = 60;

function loadCustomAgentConfig(rootDir: string): AnyRecord | null {
  const controlPlanePath = path.join(getPaths(rootDir).configDir, 'control-plane.json');
  const controlPlaneConfig = readJson(controlPlanePath, null);
  const customConfigPath = String(controlPlaneConfig && controlPlaneConfig.spawnCustomAgents || '').trim();
  if (!customConfigPath) {
    return null;
  }
  const resolvedPath = resolvePathInside(rootDir, customConfigPath, 'spawnCustomAgents');
  return {
    ...readJson(resolvedPath, {}),
    configPath: resolvedPath,
  };
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
  const config = loadCustomAgentConfig(rootDir);
  if (!config) {
    return { started: [], pendingSpawnStarts: [], config: null };
  }
  runtime.customAgents = runtime.customAgents || {};

  const enabled = config.enabled !== false;
  const agents = Array.isArray(config.agents) ? config.agents : [];
  const started = [];
  const pendingSpawnStarts = [];
  const context = normalizeContext(rootDir, config.context || {});
  const controlPanel = normalizeControlPanel(config.controlPanel || {});
  const decisionClient = options.customAgentDecisionClient || callDecisionEndpointSync;

  agents.forEach((agent) => {
    const normalizedAgent = normalizeAgent(rootDir, agent, context);
    const statusKey = getCustomAgentStatusKey(normalizedAgent);
    const status = ensureCustomAgentStatus(runtime, statusKey, normalizedAgent, enabled);
    status.enabled = enabled && normalizedAgent.enabled;
    status.target = normalizedAgent.target;
    status.workspacePath = normalizedAgent.workspacePath;
    status.singletonKey = normalizedAgent.singletonKey;
    status.singletonValue = normalizedAgent.singletonValue;

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
    if (normalizedAgent.spawnMode !== 'poll') {
      status.status = 'idle';
      status.lastDecision = 'unsupported';
      status.lastDecisionReason = `unsupported spawn mode "${normalizedAgent.spawnMode || ''}"`;
      return;
    }
    if (status.running === true) {
      return;
    }
    if (!pollIsDue(status, normalizedAgent.intervalSeconds, nowIso)) {
      return;
    }

    status.lastPollAt = nowIso;
    const envKey = normalizedAgent.authEnv;
    const authValue = envKey ? process.env[envKey] : '';
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

    let decision;
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

    const shouldRun = decision && decision.shouldRun === true;
    status.lastDecision = shouldRun ? 'run' : 'skip';
    status.lastDecisionReason = normalizeDecisionReason(decision);
    status.lastError = null;
    if (!shouldRun) {
      status.status = 'idle';
      status.running = false;
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
      controlPanel: {
        baseUrl: controlPanel.baseUrl,
        authHeader: controlPanel.authHeader,
      },
      auth: {
        envKey,
        value: authValue,
      },
      context: {
        globalReadOnly: context.globalReadOnly,
        workspaceReadWrite: context.workspaceReadWrite,
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

  return { started, pendingSpawnStarts, config };
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
  };
}

function normalizeAgent(rootDir: string, agent: AnyRecord, context: AnyRecord) {
  const agentId = String(agent && agent.id || '').trim();
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
  return {
    ...agent,
    agentId,
    enabled: agent && agent.enabled !== false,
    target,
    workspace,
    workspacePath,
    workspaceReadWrite: context.workspaceReadWrite,
    authEnv: String(agent && agent.authEnv || '').trim(),
    spawnMode: String(agent && agent.spawn && agent.spawn.mode || '').trim(),
    intervalSeconds: normalizePositiveNumber(agent && agent.spawn && agent.spawn.intervalSeconds, DEFAULT_INTERVAL_SECONDS),
    singletonKey,
    singletonValue,
    decisionEndpoint: String(agent && agent.spawn && agent.spawn.decision && agent.spawn.decision.endpoint || '').trim(),
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

function normalizePositiveNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  return `${agent.agentId}:${agent.target && agent.target.id || ''}`;
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
  markCustomAgentSpawnFailed,
  markCustomAgentSpawned,
  pollCustomAgents,
  refreshCustomAgentRuntime,
  spawnCustomAgentProcess,
};
