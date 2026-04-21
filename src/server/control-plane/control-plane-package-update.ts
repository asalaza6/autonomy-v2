import path from 'path';
import { spawnSync } from 'child_process';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { runPackageUpdate } from '../../autonomy-v2/commands/update.js';
import type { AnyRecord, ControlPlaneConfig, DeployCommandConfig } from '../../types.js';
import { loadControlPlaneConfig } from './control-plane-config.js';

const RESTART_COMMAND_TIMEOUT_MS = 30000;

function executeControlPlanePackageUpdate(rootDir: string) {
  const update = runPackageUpdate(rootDir, {});
  const snapshot = buildStatusSnapshot(rootDir);
  const restartConfig = loadControlPlaneConfig(rootDir);
  const restartStatus = runPackageUpdateRestartCommands(rootDir, restartConfig);
  const errors = [
    ...normalizeErrorList(update.errors),
    ...collectRestartErrors(restartStatus),
  ];

  return {
    snapshot,
    packageManager: update.packageManager,
    installedVersion: update.installedVersion,
    restartStatus,
    result: {
      packageName: update.packageName,
      packageManager: update.packageManager,
      dependencyType: update.dependencyType,
      previousDeclaredVersion: update.previousDeclaredVersion,
      newDeclaredVersion: update.newDeclaredVersion,
      previousVersion: update.previousVersion,
      declaredVersion: update.declaredVersion,
      installedVersion: update.installedVersion,
      refreshed: update.refreshed,
      refreshStatus: update.refreshStatus,
      refresh: update.refresh,
      restartStatus,
      errors,
    },
  };
}

function runPackageUpdateRestartCommands(rootDir: string, config: ControlPlaneConfig) {
  const server = runRestartCommand(rootDir, 'server', config.serverRestartCommand);
  const controlBridge = runRestartCommand(rootDir, 'controlBridge', config.controlBridgeRestartCommand);
  const targetStatuses = [controlBridge.status, server.status];
  const status = targetStatuses.includes('failed')
    ? 'failed'
    : targetStatuses.includes('completed')
      ? 'completed'
      : 'skipped';
  return {
    status,
    controlBridge,
    server,
  };
}

function runRestartCommand(
  rootDir: string,
  target: 'controlBridge' | 'server',
  value: DeployCommandConfig | null | undefined
) {
  let commandConfig: ReturnType<typeof normalizeRestartCommandConfig>;
  try {
    commandConfig = normalizeRestartCommandConfig(value, rootDir);
  } catch (error) {
    return {
      target,
      status: 'failed' as const,
      error: formatErrorMessage(error),
    };
  }
  if (!commandConfig) {
    return {
      target,
      status: 'skipped' as const,
      reason: 'not-configured',
    };
  }

  const result = spawnSync(commandConfig.command, commandConfig.args, {
    cwd: commandConfig.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...commandConfig.env,
    },
    shell: commandConfig.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: RESTART_COMMAND_TIMEOUT_MS,
  });
  const output = collectCommandOutput(result.stdout, result.stderr);
  const base = {
    target,
    command: commandConfig.displayCommand,
    cwd: path.relative(rootDir, commandConfig.cwd) || '.',
    exitCode: typeof result.status === 'number' ? result.status : null,
    output: output || null,
  };
  if (result.error) {
    return {
      ...base,
      status: 'failed' as const,
      error: result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      ...base,
      status: 'failed' as const,
      error: output || result.signal || `exit code ${result.status}`,
    };
  }
  return {
    ...base,
    status: 'completed' as const,
  };
}

function normalizeRestartCommandConfig(value: DeployCommandConfig | null | undefined, rootDir: string) {
  if (typeof value === 'undefined' || value === null) {
    return null;
  }

  if (typeof value === 'string') {
    const command = value.trim();
    return command
      ? {
        command,
        args: [] as string[],
        cwd: rootDir,
        displayCommand: command,
        env: {} as Record<string, string>,
        shell: true,
      }
      : null;
  }

  if (Array.isArray(value)) {
    const [rawCommand, ...rawArgs] = value;
    const command = String(rawCommand || '').trim();
    const args = rawArgs.map((arg) => String(arg));
    return command
      ? {
        command,
        args,
        cwd: rootDir,
        displayCommand: formatCommand(command, args),
        env: {} as Record<string, string>,
        shell: false,
      }
      : null;
  }

  if (typeof value !== 'object') {
    throw new Error('restart command must be a string, an array, or an object.');
  }

  const command = String((value as AnyRecord).command || '').trim();
  if (!command) {
    return null;
  }
  const args = Array.isArray((value as AnyRecord).args)
    ? (value as AnyRecord).args.map((arg: unknown) => String(arg))
    : [];
  return {
    command,
    args,
    cwd: resolveCommandCwd(rootDir, (value as AnyRecord).cwd),
    displayCommand: formatCommand(command, args),
    env: normalizeCommandEnv((value as AnyRecord).env),
    shell: (value as AnyRecord).shell === true,
  };
}

function resolveCommandCwd(rootDir: string, value: unknown) {
  const cwd = String(value || '').trim();
  if (!cwd) {
    return rootDir;
  }
  return path.isAbsolute(cwd) ? cwd : path.resolve(rootDir, cwd);
}

function normalizeCommandEnv(value: unknown) {
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

function collectCommandOutput(...parts: unknown[]) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatCommand(command: string, args: string[]) {
  return [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');
}

function normalizeErrorList(errors: unknown) {
  return Array.isArray(errors)
    ? errors.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
}

function collectRestartErrors(restartStatus: {
  controlBridge?: { error?: string };
  server?: { error?: string };
}) {
  return [restartStatus.controlBridge?.error, restartStatus.server?.error]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

export {
  executeControlPlanePackageUpdate,
};
