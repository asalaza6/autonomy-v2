import fs from 'node:fs';
import path from 'node:path';
import type {
  CommandConfig,
  CustomAgentContext,
  JsonRecord,
  LoadedCustomAgentConfig,
  NormalizedCustomAgent,
} from '../types.js';
import {
  canonicalizePath,
  isRecord,
  readJson,
  resolveInsideRoot,
} from '../runtime.js';

const DEFAULT_CONFIG_PATH = 'prompts/autonomous/v2/config/custom-agents.json';
const DEFAULT_INTERVAL_SECONDS = 60;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_PARALLELISM = 32;

function loadCustomAgentConfig(
  requestedRootDir: string,
  configOption = ''
): LoadedCustomAgentConfig | null {
  const rootDir = canonicalizePath(requestedRootDir);
  const configuredPath = String(
    configOption || process.env.AUTONOMY_CUSTOM_AGENTS_CONFIG || DEFAULT_CONFIG_PATH
  ).trim();
  const configPath = resolveInsideRoot(rootDir, configuredPath, 'custom-agent config');
  if (!fs.existsSync(configPath)) {
    if (configOption || process.env.AUTONOMY_CUSTOM_AGENTS_CONFIG) {
      throw new Error(`Custom-agent config does not exist: ${configPath}`);
    }
    return null;
  }

  const raw = readJson<JsonRecord>(configPath, {});
  if (!isRecord(raw)) {
    throw new Error(`Custom-agent config must be a JSON object: ${configPath}`);
  }
  if (raw.schemaVersion !== 1) {
    throw new Error(`Custom-agent config schemaVersion must be 1: ${configPath}`);
  }
  if (!Array.isArray(raw.agents)) {
    throw new Error(`Custom-agent config must include an agents array: ${configPath}`);
  }

  const kind = stringValue(raw.kind);
  const promptRole = stringValue(raw.promptRole);
  const promptIntro = stringValue(raw.promptIntro);
  const defaultContext = normalizeContext(rootDir, raw.context, null);
  const agents = raw.agents.flatMap((value, index) => normalizeAgent(rootDir, value, index, {
    kind,
    promptRole,
    promptIntro,
    defaultContext,
  }));
  const keys = new Set<string>();
  agents.forEach((agent) => {
    if (keys.has(agent.runtimeKey)) {
      throw new Error(`Duplicate custom-agent runtime key "${agent.runtimeKey}".`);
    }
    keys.add(agent.runtimeKey);
  });

  return {
    path: configPath,
    enabled: raw.enabled !== false,
    kind,
    promptRole,
    promptIntro,
    agents,
  };
}

function normalizeAgent(
  rootDir: string,
  value: unknown,
  index: number,
  defaults: {
    kind: string;
    promptRole: string;
    promptIntro: string;
    defaultContext: CustomAgentContext;
  }
): NormalizedCustomAgent[] {
  if (!isRecord(value)) {
    throw new Error(`Custom agent at index ${index} must be a JSON object.`);
  }
  const id = stringValue(value.id);
  if (!id) {
    throw new Error(`Custom agent at index ${index} is missing id.`);
  }
  const targetValue = isRecord(value.target) ? value.target : {};
  const target = {
    ...targetValue,
    type: stringValue(targetValue.type),
    id: stringValue(targetValue.id) || id,
  };
  const baseRuntimeKey = `${id}:${target.id}`;
  const baseWorkspace = stringValue(value.workspace)
    || path.join('.autonomy', 'runtime', 'custom-agents', id);
  const baseWorkspacePath = resolveInsideRoot(rootDir, baseWorkspace, `${id}.workspace`);
  const spawn = isRecord(value.spawn) ? value.spawn : {};
  const spawnMode = stringValue(spawn.mode) || 'poll';
  if (spawnMode !== 'poll') {
    throw new Error(`${id}.spawn.mode must be "poll".`);
  }
  const intervalSeconds = positiveNumber(
    spawn.intervalSeconds,
    DEFAULT_INTERVAL_SECONDS,
    `${id}.spawn.intervalSeconds`
  );
  const parallelism = positiveInteger(
    spawn.parallelism,
    1,
    MAX_PARALLELISM,
    `${id}.spawn.parallelism`
  );
  if (parallelism > 1 && baseWorkspacePath === path.resolve(rootDir)) {
    throw new Error(
      `${id}.spawn.parallelism cannot exceed 1 when its workspace is the repository root.`
    );
  }
  const singletonKey = stringValue(spawn.singletonKey) || 'target.id';
  const singletonValue = resolveSingletonValue(id, target, baseWorkspacePath, singletonKey);
  const decision = normalizeDecision(rootDir, spawn.decision, id);
  const context = normalizeContext(rootDir, value.context, defaults.defaultContext);
  const conversationValue = isRecord(value.conversation) ? value.conversation : {};
  const conversationMode: 'fresh' | 'scoped' = stringValue(conversationValue.mode).toLowerCase() === 'fresh'
    ? 'fresh'
    : 'scoped';
  const execution = isRecord(value.execution) ? value.execution : {};

  const normalized = {
    id,
    enabled: value.enabled !== false,
    kind: stringValue(value.kind) || defaults.kind,
    promptRole: stringValue(value.promptRole) || defaults.promptRole,
    promptIntro: stringValue(value.promptIntro) || defaults.promptIntro,
    instructions: stringValue(value.instructions),
    promptPath: normalizeOptionalPath(
      rootDir,
      stringValue(value.prompt || value.systemPrompt),
      `${id}.prompt`
    ),
    target,
    intervalSeconds,
    singletonKey,
    singletonValue,
    decisionMode: decision.mode,
    decisionCommand: decision.command,
    environmentCommand: normalizeCommand(rootDir, value.environment, `${id}.environment`),
    promptCommand: normalizeCommand(rootDir, execution.prompt, `${id}.execution.prompt`),
    finalizeCommand: normalizeCommand(rootDir, value.finalize, `${id}.finalize`),
    conversationMode,
    context,
  };
  return Array.from({ length: parallelism }, (_, index) => {
    const parallelSlot = index + 1;
    const runtimeKey = parallelSlot === 1
      ? baseRuntimeKey
      : `${baseRuntimeKey}#${parallelSlot}`;
    const workspace = parallelism === 1
      ? baseWorkspace
      : path.join(`${path.normalize(baseWorkspace)}-slots`, `slot-${parallelSlot}`);
    return {
      ...normalized,
      runtimeKey,
      baseRuntimeKey,
      parallelSlot,
      parallelism,
      workspace,
      workspacePath: resolveInsideRoot(rootDir, workspace, `${id}.workspace`),
    };
  });
}

function normalizeDecision(rootDir: string, value: unknown, agentId: string) {
  const decision = isRecord(value) ? value : {};
  const mode = stringValue(decision.mode) || 'always';
  if (mode === 'always') {
    return { mode: 'always' as const, command: null };
  }
  if (mode !== 'command') {
    throw new Error(`${agentId}.spawn.decision.mode must be "always" or "command".`);
  }
  const command = normalizeCommand(rootDir, decision, `${agentId}.spawn.decision`);
  if (!command) {
    throw new Error(`${agentId}.spawn.decision.command is required.`);
  }
  return { mode: 'command' as const, command };
}

function normalizeCommand(
  rootDir: string,
  value: unknown,
  label: string
): CommandConfig | null {
  if (!isRecord(value) || !stringValue(value.command)) {
    return null;
  }
  const args = Array.isArray(value.args)
    ? value.args.map((entry) => String(entry))
    : [];
  const env = isRecord(value.env)
    ? Object.fromEntries(Object.entries(value.env).map(([key, entry]) => [key, String(entry)]))
    : {};
  const cwdValue = stringValue(value.cwd) || '.';
  return {
    command: stringValue(value.command),
    args,
    cwd: resolveInsideRoot(rootDir, cwdValue, `${label}.cwd`),
    env,
    shell: value.shell === true,
    timeoutMs: positiveNumber(
      value.timeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      `${label}.timeoutMs`
    ),
  };
}

function normalizeContext(
  rootDir: string,
  value: unknown,
  inherited: CustomAgentContext | null
): CustomAgentContext {
  const context = isRecord(value) ? value : {};
  const globalReadOnly = Object.prototype.hasOwnProperty.call(context, 'globalReadOnly')
    ? stringArray(context.globalReadOnly).map((entry) => {
        const resolved = resolveInsideRoot(rootDir, entry, 'context.globalReadOnly');
        return { path: resolved, relativePath: path.relative(rootDir, resolved) };
      })
    : inherited?.globalReadOnly || [];
  const workspaceReadWrite = Object.prototype.hasOwnProperty.call(context, 'workspaceReadWrite')
    ? stringArray(context.workspaceReadWrite)
    : inherited?.workspaceReadWrite || [];
  const allowRuntimeStateChanges = Object.prototype.hasOwnProperty.call(
    context,
    'allowRuntimeStateChanges'
  )
    ? context.allowRuntimeStateChanges === true
    : inherited?.allowRuntimeStateChanges === true;
  return { globalReadOnly, workspaceReadWrite, allowRuntimeStateChanges };
}

function resolveSingletonValue(
  agentId: string,
  target: JsonRecord,
  workspacePath: string,
  key: string
) {
  if (key === 'agent.id') return agentId;
  if (key === 'target.type') return stringValue(target.type);
  if (key === 'workspace') return workspacePath;
  return stringValue(target.id) || agentId;
}

function normalizeOptionalPath(rootDir: string, value: string, label: string) {
  return value ? resolveInsideRoot(rootDir, value, label) : '';
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
}

function stringValue(value: unknown) {
  return String(value ?? '').trim();
}

function positiveNumber(value: unknown, fallback: number, label: string) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return number;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  label: string
) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return number;
}

export { DEFAULT_CONFIG_PATH, loadCustomAgentConfig };
