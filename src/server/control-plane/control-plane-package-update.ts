import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { runPackageUpdate } from '../../autonomy-v2/commands/update.js';
import type { AnyRecord, ControlPlaneConfig, DeployCommandConfig } from '../../types.js';
import { loadControlPlaneConfig } from './control-plane-config.js';

const RESTART_COMMAND_TIMEOUT_MS = 30000;

type RestartTarget = 'controlBridge' | 'server';

interface NormalizedRestartCommandConfig {
  command: string;
  args: string[];
  cwd: string;
  displayCommand: string;
  env: Record<string, string>;
  shell: boolean;
}

interface DeferredRestartCommand {
  target: RestartTarget;
  commandConfig: NormalizedRestartCommandConfig;
}

interface DeferredRestartLaunchResult {
  target: RestartTarget;
  command: string;
  cwd: string;
  status: 'started' | 'failed';
  error?: string;
}

function executeControlPlanePackageUpdate(rootDir: string) {
  const update = runPackageUpdate(rootDir, {});
  const snapshot = buildStatusSnapshot(rootDir);
  const restartConfig = loadControlPlaneConfig(rootDir);
  const restartPlan = preparePackageUpdateRestartCommands(rootDir, restartConfig);
  const restartStatus = restartPlan.restartStatus;
  const errors = [
    ...normalizeErrorList(update.errors),
    ...collectRestartErrors(restartStatus),
  ];

  return {
    snapshot,
    packageManager: update.packageManager,
    installedVersion: update.installedVersion,
    restartStatus,
    deferredRestartCommands: restartPlan.deferredCommands,
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

function preparePackageUpdateRestartCommands(rootDir: string, config: ControlPlaneConfig) {
  const server = runRestartCommand(rootDir, 'server', config.serverRestartCommand);
  const controlBridgePlan = deferRestartCommand(rootDir, 'controlBridge', config.controlBridgeRestartCommand);
  const controlBridge = controlBridgePlan.status;
  const targetStatuses = [controlBridge.status, server.status];
  const status = targetStatuses.includes('failed')
    ? 'failed'
    : targetStatuses.includes('deferred')
      ? 'deferred'
      : targetStatuses.includes('completed')
      ? 'completed'
      : 'skipped';
  return {
    restartStatus: {
      status,
      controlBridge,
      server,
    },
    deferredCommands: controlBridgePlan.deferredCommand
      ? [controlBridgePlan.deferredCommand]
      : [],
  };
}

function runRestartCommand(
  rootDir: string,
  target: RestartTarget,
  value: DeployCommandConfig | null | undefined
) {
  let commandConfig: NormalizedRestartCommandConfig | null;
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

function deferRestartCommand(
  rootDir: string,
  target: RestartTarget,
  value: DeployCommandConfig | null | undefined
) {
  let commandConfig: NormalizedRestartCommandConfig | null;
  try {
    commandConfig = normalizeRestartCommandConfig(value, rootDir);
  } catch (error) {
    return {
      status: {
        target,
        status: 'failed' as const,
        error: formatErrorMessage(error),
      },
      deferredCommand: null,
    };
  }
  if (!commandConfig) {
    return {
      status: {
        target,
        status: 'skipped' as const,
        reason: 'not-configured',
      },
      deferredCommand: null,
    };
  }

  return {
    status: {
      target,
      status: 'deferred' as const,
      reason: 'after-job-completion',
      command: commandConfig.displayCommand,
      cwd: path.relative(rootDir, commandConfig.cwd) || '.',
    },
    deferredCommand: {
      target,
      commandConfig,
    },
  };
}

async function runDeferredPackageUpdateRestartCommands(
  deferredCommands: DeferredRestartCommand[]
): Promise<DeferredRestartLaunchResult[]> {
  const results: DeferredRestartLaunchResult[] = [];
  for (const deferredCommand of deferredCommands) {
    results.push(await startDetachedRestartCommand(deferredCommand));
  }
  return results;
}

function startDetachedRestartCommand(deferredCommand: DeferredRestartCommand): Promise<DeferredRestartLaunchResult> {
  const { target, commandConfig } = deferredCommand;
  const base = {
    target,
    command: commandConfig.displayCommand,
    cwd: commandConfig.cwd,
  };

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: DeferredRestartLaunchResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(commandConfig.command, commandConfig.args, {
        cwd: commandConfig.cwd,
        detached: true,
        env: {
          ...process.env,
          ...commandConfig.env,
        },
        shell: commandConfig.shell,
        stdio: 'ignore',
      });
    } catch (error) {
      settle({
        ...base,
        status: 'failed',
        error: formatErrorMessage(error),
      });
      return;
    }
    child.once('spawn', () => {
      child.unref();
      settle({
        ...base,
        status: 'started',
      });
    });
    child.once('error', (error) => {
      settle({
        ...base,
        status: 'failed',
        error: error.message,
      });
    });
  });
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
  runDeferredPackageUpdateRestartCommands,
};
