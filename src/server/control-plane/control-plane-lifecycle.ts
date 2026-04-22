import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type { DeployCommandConfig } from '../../types.js';
import { ensureDir, readJson, writeJson } from '../orchestrator/paths.js';

type ControlPlaneServiceKind = 'server' | 'controlBridge';

interface ControlPlaneLaunchCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

interface ControlPlaneServiceLifecycleRecord {
  kind: ControlPlaneServiceKind;
  pid: number;
  cwd: string;
  launch: ControlPlaneLaunchCommand;
  launchCommand: string;
  restartCommand?: string;
  recordedAt: string;
  matchTokens?: string[];
}

interface ControlPlaneLifecycleState {
  schemaVersion: number;
  services: Partial<Record<ControlPlaneServiceKind, ControlPlaneServiceLifecycleRecord>>;
}

interface LifecycleValidationResult {
  status: 'valid' | 'missing-metadata' | 'stale-pid';
  metadata?: ControlPlaneServiceLifecycleRecord;
  reason?: string;
  error?: string;
}

const DEFAULT_LIFECYCLE_STATE: ControlPlaneLifecycleState = {
  schemaVersion: 1,
  services: {},
};

const CONTROL_PLANE_LAUNCH_ENV_KEYS = [
  'AUTONOMY_CONTROL_PLANE_API_BASE_URL',
  'AUTONOMY_CONTROL_PLANE_DEV',
  'AUTONOMY_CONTROL_PLANE_HOST',
  'AUTONOMY_CONTROL_PLANE_PORT',
  'AUTONOMY_CONTROL_PLANE_PROXY_URL',
  'AUTONOMY_CONTROL_PLANE_REPO_MAP',
  'AUTONOMY_CONTROL_PLANE_SERVER_URL',
  'HOST',
  'NODE_ENV',
  'PORT',
];

function getControlPlaneLifecyclePath(rootDir: string) {
  return path.join(rootDir, '.autonomy', 'control-plane', 'lifecycle.json');
}

function loadControlPlaneLifecycle(rootDir: string): ControlPlaneLifecycleState {
  return normalizeControlPlaneLifecycle(readJson(getControlPlaneLifecyclePath(rootDir), DEFAULT_LIFECYCLE_STATE));
}

function saveControlPlaneLifecycle(rootDir: string, state: Partial<ControlPlaneLifecycleState>) {
  const normalized = normalizeControlPlaneLifecycle(state);
  const lifecyclePath = getControlPlaneLifecyclePath(rootDir);
  ensureDir(path.dirname(lifecyclePath));
  writeJson(lifecyclePath, normalized);
  return normalized;
}

function recordControlPlaneServiceLifecycle(
  rootDir: string,
  kind: ControlPlaneServiceKind,
  options: {
    restartCommand?: DeployCommandConfig | null;
    argv?: string[];
    cwd?: string;
    pid?: number;
    recordedAt?: string;
  } = {}
) {
  const state = loadControlPlaneLifecycle(rootDir);
  const metadata = buildControlPlaneServiceLifecycleMetadata(kind, options);
  state.services[kind] = metadata;
  saveControlPlaneLifecycle(rootDir, state);
  return metadata;
}

function writeControlPlaneServiceLifecycle(rootDir: string, metadata: ControlPlaneServiceLifecycleRecord) {
  const state = loadControlPlaneLifecycle(rootDir);
  state.services[metadata.kind] = normalizeServiceLifecycleRecord(metadata);
  saveControlPlaneLifecycle(rootDir, state);
  return state.services[metadata.kind] as ControlPlaneServiceLifecycleRecord;
}

function buildControlPlaneServiceLifecycleMetadata(
  kind: ControlPlaneServiceKind,
  options: {
    restartCommand?: DeployCommandConfig | null;
    argv?: string[];
    cwd?: string;
    pid?: number;
    recordedAt?: string;
    launch?: Partial<ControlPlaneLaunchCommand>;
    matchTokens?: string[];
  } = {}
): ControlPlaneServiceLifecycleRecord {
  const cwd = path.resolve(String(options.cwd || process.cwd()));
  const launchArgs = Array.isArray(options.argv)
    ? options.argv.map((entry) => String(entry))
    : [...process.execArgv, ...process.argv.slice(1)];
  const launch = normalizeLaunchCommand({
    command: options.launch?.command || process.execPath,
    args: options.launch?.args || launchArgs,
    cwd: options.launch?.cwd || cwd,
    env: options.launch?.env || collectControlPlaneLaunchEnv(process.env),
  });
  const restartCommand = formatDeployCommandConfig(options.restartCommand || null);
  return {
    kind,
    pid: normalizePid(options.pid || process.pid),
    cwd,
    launch,
    launchCommand: formatCommand(launch.command, launch.args),
    ...(restartCommand ? { restartCommand } : {}),
    recordedAt: String(options.recordedAt || new Date().toISOString()),
    matchTokens: normalizeMatchTokens(options.matchTokens || buildDefaultMatchTokens(kind, launch.args)),
  };
}

function validateControlPlaneServiceLifecycle(
  rootDir: string,
  kind: ControlPlaneServiceKind,
  expected?: ControlPlaneServiceLifecycleRecord
): LifecycleValidationResult {
  const state = loadControlPlaneLifecycle(rootDir);
  const metadata = state.services[kind];
  if (!metadata) {
    return {
      status: 'missing-metadata',
      reason: 'missing-metadata',
      error: `${formatServiceLabel(kind)} lifecycle metadata is missing.`,
    };
  }

  const normalized = normalizeServiceLifecycleRecord(metadata);
  if (expected && !lifecycleRecordsMatch(normalized, expected)) {
    return {
      status: 'stale-pid',
      metadata: normalized,
      reason: 'metadata-changed',
      error: `${formatServiceLabel(kind)} lifecycle metadata changed before restart.`,
    };
  }

  if (!isProcessAlive(normalized.pid)) {
    return {
      status: 'stale-pid',
      metadata: normalized,
      reason: 'stale-pid',
      error: `${formatServiceLabel(kind)} PID ${normalized.pid} is not running.`,
    };
  }

  const commandCheck = verifyProcessCommand(normalized);
  if (!commandCheck.valid) {
    return {
      status: 'stale-pid',
      metadata: normalized,
      reason: 'pid-command-mismatch',
      error: commandCheck.error || `${formatServiceLabel(kind)} PID ${normalized.pid} no longer matches lifecycle metadata.`,
    };
  }

  return {
    status: 'valid',
    metadata: normalized,
  };
}

function normalizeControlPlaneLifecycle(state: Partial<ControlPlaneLifecycleState> = {}): ControlPlaneLifecycleState {
  const services: Partial<Record<ControlPlaneServiceKind, ControlPlaneServiceLifecycleRecord>> = {};
  const rawServices = state && typeof state.services === 'object' ? state.services : {};
  (['server', 'controlBridge'] as ControlPlaneServiceKind[]).forEach((kind) => {
    const metadata = rawServices && (rawServices as Partial<Record<ControlPlaneServiceKind, ControlPlaneServiceLifecycleRecord>>)[kind];
    if (metadata) {
      services[kind] = normalizeServiceLifecycleRecord({
        ...metadata,
        kind,
      });
    }
  });
  return {
    schemaVersion: 1,
    services,
  };
}

function normalizeServiceLifecycleRecord(value: Partial<ControlPlaneServiceLifecycleRecord>): ControlPlaneServiceLifecycleRecord {
  const kind = value.kind === 'controlBridge' ? 'controlBridge' : 'server';
  const launch = normalizeLaunchCommand(value.launch || {});
  const launchCommand = String(value.launchCommand || formatCommand(launch.command, launch.args)).trim();
  const restartCommand = String(value.restartCommand || '').trim();
  return {
    kind,
    pid: normalizePid(value.pid),
    cwd: path.resolve(String(value.cwd || launch.cwd || process.cwd())),
    launch,
    launchCommand,
    ...(restartCommand ? { restartCommand } : {}),
    recordedAt: String(value.recordedAt || new Date().toISOString()),
    matchTokens: normalizeMatchTokens(value.matchTokens || buildDefaultMatchTokens(kind, launch.args)),
  };
}

function normalizeLaunchCommand(value: Partial<ControlPlaneLaunchCommand>): ControlPlaneLaunchCommand {
  const command = String(value.command || process.execPath).trim();
  const args = Array.isArray(value.args) ? value.args.map((entry) => String(entry)) : [];
  const cwd = path.resolve(String(value.cwd || process.cwd()));
  return {
    command,
    args,
    cwd,
    env: normalizeEnv(value.env),
  };
}

function normalizePid(value: unknown) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function normalizeEnv(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce((env, [key, entry]) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || typeof entry === 'undefined' || entry === null) {
      return env;
    }
    env[normalizedKey] = String(entry);
    return env;
  }, {} as Record<string, string>);
}

function normalizeMatchTokens(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function collectControlPlaneLaunchEnv(env: NodeJS.ProcessEnv) {
  return CONTROL_PLANE_LAUNCH_ENV_KEYS.reduce((selected, key) => {
    if (typeof env[key] !== 'undefined') {
      selected[key] = String(env[key]);
    }
    return selected;
  }, {} as Record<string, string>);
}

function buildDefaultMatchTokens(kind: ControlPlaneServiceKind, args: string[]) {
  const scriptArg = args.find((arg) => !arg.startsWith('-') && /\.(cjs|js|mjs|ts)$/.test(arg));
  const serviceCommand = kind === 'server' ? 'serve' : 'bridge';
  return [
    scriptArg ? path.basename(scriptArg) : '',
    serviceCommand,
  ].filter(Boolean);
}

function lifecycleRecordsMatch(
  left: ControlPlaneServiceLifecycleRecord,
  right: ControlPlaneServiceLifecycleRecord
) {
  return (
    left.kind === right.kind
    && left.pid === right.pid
    && left.recordedAt === right.recordedAt
    && left.launchCommand === right.launchCommand
  );
}

function isProcessAlive(pid: number) {
  if (!pid || pid === process.pid) {
    return pid === process.pid;
  }
  try {
    process.kill(pid, 0);
    return !isZombieProcess(pid);
  } catch (error) {
    return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EPERM');
  }
}

function isZombieProcess(pid: number) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && /\bZ/.test(String(result.stdout || '').trim());
}

function verifyProcessCommand(metadata: ControlPlaneServiceLifecycleRecord) {
  const tokens = normalizeMatchTokens(metadata.matchTokens);
  if (tokens.length === 0) {
    return { valid: true };
  }
  const result = spawnSync('ps', ['-p', String(metadata.pid), '-o', 'command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const commandLine = String(result.stdout || '').trim();
  if (result.error || result.status !== 0 || !commandLine) {
    return { valid: true };
  }
  const missingToken = tokens.find((token) => !commandLine.includes(token));
  if (missingToken) {
    return {
      valid: false,
      error: `${formatServiceLabel(metadata.kind)} PID ${metadata.pid} command does not include "${missingToken}".`,
    };
  }
  return { valid: true };
}

function formatDeployCommandConfig(value: DeployCommandConfig | null | undefined) {
  if (typeof value === 'undefined' || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const [command, ...args] = value.map((entry) => String(entry));
    return String(command || '').trim() ? formatCommand(String(command), args) : '';
  }
  const command = String(value.command || '').trim();
  if (!command) {
    return '';
  }
  const args = Array.isArray(value.args) ? value.args.map((entry) => String(entry)) : [];
  return formatCommand(command, args);
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
}

function formatServiceLabel(kind: ControlPlaneServiceKind) {
  return kind === 'controlBridge' ? 'Control bridge' : 'Control panel server';
}

function removeControlPlaneLifecycle(rootDir: string) {
  fs.rmSync(getControlPlaneLifecyclePath(rootDir), { force: true });
}

export type {
  ControlPlaneLifecycleState,
  ControlPlaneLaunchCommand,
  ControlPlaneServiceKind,
  ControlPlaneServiceLifecycleRecord,
  LifecycleValidationResult,
};

export {
  buildControlPlaneServiceLifecycleMetadata,
  getControlPlaneLifecyclePath,
  loadControlPlaneLifecycle,
  recordControlPlaneServiceLifecycle,
  removeControlPlaneLifecycle,
  saveControlPlaneLifecycle,
  validateControlPlaneServiceLifecycle,
  writeControlPlaneServiceLifecycle,
};
