import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { readAutonomyPackageStatus, runPackageUpdate } from '../../autonomy-v2/commands/update.js';
import type { AnyRecord, ControlPlaneConfig, DeployCommandConfig } from '../../types.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import type { ControlPlaneServiceLifecycleRecord } from './control-plane-lifecycle.js';
import { validateControlPlaneServiceLifecycle } from './control-plane-lifecycle.js';
import type { DefaultRestartHelperPlan } from './control-plane-restart-helper.js';

type RestartTarget = 'controlBridge' | 'server';
type DeferredRestartTarget = RestartTarget | 'default';

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_OUTPUT_LENGTH = 4000;

interface NormalizedControlPlaneCommandConfig {
  command: string;
  args: string[];
  cwd: string;
  displayCommand: string;
  env: Record<string, string>;
  shell: boolean;
}

interface ConfiguredDeferredRestartCommand {
  mode: 'configured';
  target: RestartTarget;
  commandConfig: NormalizedControlPlaneCommandConfig;
}

interface DefaultDeferredRestartCommand {
  mode: 'default';
  target: 'default';
  command: string;
  cwd: string;
  helperPlan: DefaultRestartHelperPlan;
}

type DeferredRestartCommand = ConfiguredDeferredRestartCommand | DefaultDeferredRestartCommand;

interface DeferredRestartLaunchResult {
  target: DeferredRestartTarget;
  mode: 'configured' | 'default';
  command: string;
  cwd: string;
  status: 'launched' | 'failed';
  targets?: RestartTarget[];
  error?: string;
}

function executeControlPlanePackageUpdate(rootDir: string) {
  const config = loadControlPlaneConfig(rootDir);
  const packageUpdateCommand = normalizePackageUpdateCommandConfig(config.packageUpdateCommand, rootDir);
  if (packageUpdateCommand) {
    return executeCustomControlPlanePackageUpdate(rootDir, packageUpdateCommand);
  }

  const update = runPackageUpdate(rootDir, {});
  const snapshot = buildStatusSnapshot(rootDir);
  const updateCommand = {
    status: 'defaulted' as const,
    reason: 'packageUpdateCommand-not-configured',
    mode: 'default-package-install' as const,
    packageSpec: `${update.packageName}@latest`,
  };
  const errors = normalizeErrorList(update.errors);

  return {
    snapshot,
    packageManager: update.packageManager,
    installedVersion: update.installedVersion,
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
      updateCommand,
      errors,
    },
  };
}

function executeCustomControlPlanePackageUpdate(
  rootDir: string,
  packageUpdateCommand: NormalizedControlPlaneCommandConfig
) {
  const before = readAutonomyPackageStatus(rootDir);
  const commandResult = runConfiguredControlPlaneCommand(packageUpdateCommand, rootDir, {
    failureLabel: 'Package update command',
    env: {
      AUTONOMY_PACKAGE_UPDATE_ROOT: rootDir,
    },
  });
  const snapshot = buildStatusSnapshot(rootDir);
  const after = snapshot.autonomyPackage || readAutonomyPackageStatus(rootDir);
  const refresh = {
    skipped: true as const,
    reason: 'custom-update-command',
  };

  return {
    snapshot,
    packageManager: after.packageManager || before.packageManager || null,
    installedVersion: after.installedVersion || '',
    result: {
      packageName: after.packageName || before.packageName,
      packageManager: after.packageManager || before.packageManager || null,
      dependencyType: null,
      previousDeclaredVersion: before.declaredVersion || '',
      newDeclaredVersion: after.declaredVersion || '',
      previousVersion: before.declaredVersion || '',
      declaredVersion: after.declaredVersion || '',
      installedVersion: after.installedVersion || '',
      refreshed: false,
      refreshStatus: 'skipped',
      refresh,
      updateCommand: {
        status: 'completed' as const,
        mode: 'custom' as const,
        ...commandResult,
      },
      errors: [] as string[],
    },
  };
}

function executeControlPlaneRestart(rootDir: string, context: {
  jobId?: string;
  repoId?: string;
} = {}) {
  const restartConfig = loadControlPlaneConfig(rootDir);
  const restartPlan = prepareControlPlaneRestartCommands(rootDir, restartConfig, context);
  const restartStatus = restartPlan.restartStatus;
  const errors = collectRestartErrors(restartStatus);

  return {
    snapshot: buildStatusSnapshot(rootDir),
    restartStatus,
    deferredRestartCommands: restartPlan.deferredCommands,
    result: {
      restartStatus,
      errors,
    },
  };
}

function prepareControlPlaneRestartCommands(rootDir: string, config: ControlPlaneConfig, context: {
  jobId?: string;
  repoId?: string;
} = {}) {
  const controlBridgePlan = prepareRestartTarget(rootDir, 'controlBridge', config.controlBridgeRestartCommand);
  const controlBridge = controlBridgePlan.status;
  const serverPlan = prepareRestartTarget(rootDir, 'server', config.serverRestartCommand);
  const server = serverPlan.status;
  const targetStatuses = [controlBridge.status, server.status];
  const status = targetStatuses.includes('failed')
    ? 'failed'
    : targetStatuses.includes('deferred')
      ? 'deferred'
      : 'skipped';
  return {
    restartStatus: {
      status,
      controlBridge,
      server,
    },
    deferredCommands: buildDeferredRestartCommands(rootDir, serverPlan, controlBridgePlan, context),
  };
}

function prepareRestartTarget(
  rootDir: string,
  target: RestartTarget,
  value: DeployCommandConfig | null | undefined
) {
  let commandConfig: NormalizedControlPlaneCommandConfig | null;
  try {
    commandConfig = normalizeRestartCommandConfig(value, rootDir);
  } catch (error) {
    return {
      status: {
        target,
        status: 'failed' as const,
        error: formatErrorMessage(error),
      },
      configuredCommand: null,
      defaultTarget: null,
    };
  }
  if (!commandConfig) {
    return prepareDefaultRestartTarget(rootDir, target);
  }

  return {
    status: {
      target,
      status: 'deferred' as const,
      reason: 'after-job-completion',
      mode: 'configured' as const,
      command: commandConfig.displayCommand,
      cwd: path.relative(rootDir, commandConfig.cwd) || '.',
    },
    configuredCommand: {
      mode: 'configured' as const,
      target,
      commandConfig,
    },
    defaultTarget: null,
  };
}

function prepareDefaultRestartTarget(rootDir: string, target: RestartTarget) {
  const validation = validateControlPlaneServiceLifecycle(rootDir, target);
  if (validation.status === 'missing-metadata') {
    return {
      status: {
        target,
        status: 'skipped' as const,
        reason: 'missing-metadata',
      },
      configuredCommand: null,
      defaultTarget: null,
    };
  }
  if (validation.status === 'stale-pid' || !validation.metadata) {
    return {
      status: {
        target,
        status: 'failed' as const,
        mode: 'default' as const,
        reason: validation.reason || 'stale-pid',
        error: validation.error || `${target} lifecycle PID is stale.`,
      },
      configuredCommand: null,
      defaultTarget: null,
    };
  }

  return {
    status: {
      target,
      status: 'deferred' as const,
      mode: 'default' as const,
      reason: 'default-lifecycle-metadata',
      pid: validation.metadata.pid,
      command: validation.metadata.launchCommand,
      cwd: path.relative(rootDir, validation.metadata.launch.cwd) || '.',
      recordedAt: validation.metadata.recordedAt,
    },
    configuredCommand: null,
    defaultTarget: {
      target,
      metadata: validation.metadata,
    },
  };
}

function buildDeferredRestartCommands(
  rootDir: string,
  serverPlan: ReturnType<typeof prepareRestartTarget>,
  controlBridgePlan: ReturnType<typeof prepareRestartTarget>,
  context: {
    jobId?: string;
    repoId?: string;
  }
) {
  const deferredCommands: DeferredRestartCommand[] = [];
  if (serverPlan.configuredCommand) {
    deferredCommands.push(serverPlan.configuredCommand);
  }

  const defaultTargets = [serverPlan.defaultTarget, controlBridgePlan.defaultTarget]
    .filter((target): target is { target: RestartTarget; metadata: ControlPlaneServiceLifecycleRecord } => Boolean(target));
  if (defaultTargets.length > 0) {
    deferredCommands.push(createDefaultRestartCommand(rootDir, defaultTargets, context));
  }

  if (controlBridgePlan.configuredCommand) {
    deferredCommands.push(controlBridgePlan.configuredCommand);
  }
  return deferredCommands;
}

function createDefaultRestartCommand(
  rootDir: string,
  targets: Array<{ target: RestartTarget; metadata: ControlPlaneServiceLifecycleRecord }>,
  context: {
    jobId?: string;
    repoId?: string;
  }
): DefaultDeferredRestartCommand {
  const helperPlan: DefaultRestartHelperPlan = {
    rootDir,
    jobId: String(context.jobId || '').trim() || undefined,
    repoId: String(context.repoId || '').trim() || undefined,
    requestedAt: new Date().toISOString(),
    targets,
  };
  return {
    mode: 'default',
    target: 'default',
    command: 'default lifecycle restart helper',
    cwd: rootDir,
    helperPlan,
  };
}

async function runDeferredPackageUpdateRestartCommands(
  deferredCommands: DeferredRestartCommand[]
): Promise<DeferredRestartLaunchResult[]> {
  return runDeferredControlPlaneRestartCommands(deferredCommands);
}

async function runDeferredControlPlaneRestartCommands(
  deferredCommands: DeferredRestartCommand[]
): Promise<DeferredRestartLaunchResult[]> {
  const results: DeferredRestartLaunchResult[] = [];
  for (const deferredCommand of deferredCommands) {
    results.push(await startDetachedRestartCommand(deferredCommand));
  }
  return results;
}

function startDetachedRestartCommand(deferredCommand: DeferredRestartCommand): Promise<DeferredRestartLaunchResult> {
  if (deferredCommand.mode === 'default') {
    return startDetachedDefaultRestartHelper(deferredCommand);
  }

  const { target, commandConfig } = deferredCommand;
  const base = {
    target,
    mode: 'configured' as const,
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
        status: 'launched',
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

function startDetachedDefaultRestartHelper(deferredCommand: DefaultDeferredRestartCommand): Promise<DeferredRestartLaunchResult> {
  const helperPath = fileURLToPath(new URL('./control-plane-restart-helper.js', import.meta.url));
  const payload = Buffer.from(JSON.stringify(deferredCommand.helperPlan)).toString('base64url');
  const base = {
    target: 'default' as const,
    mode: 'default' as const,
    command: deferredCommand.command,
    cwd: deferredCommand.cwd,
    targets: deferredCommand.helperPlan.targets.map((target) => target.target),
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
      child = spawn(process.execPath, [helperPath, '--payload', payload], {
        cwd: deferredCommand.cwd,
        detached: true,
        env: process.env,
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
        status: 'launched',
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

function normalizePackageUpdateCommandConfig(value: DeployCommandConfig | null | undefined, rootDir: string) {
  return normalizeControlPlaneCommandConfig(value, rootDir, 'packageUpdateCommand');
}

function normalizeRestartCommandConfig(value: DeployCommandConfig | null | undefined, rootDir: string) {
  return normalizeControlPlaneCommandConfig(value, rootDir, 'restart command');
}

function normalizeControlPlaneCommandConfig(
  value: DeployCommandConfig | null | undefined,
  rootDir: string,
  label: string
) {
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
    throw new Error(`${label} must be a string, an array, or an object.`);
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

function runConfiguredControlPlaneCommand(
  commandConfig: NormalizedControlPlaneCommandConfig,
  rootDir: string,
  options: {
    failureLabel: string;
    env?: Record<string, string>;
  }
) {
  const result = spawnSync(commandConfig.command, commandConfig.args, {
    cwd: commandConfig.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env || {}),
      ...commandConfig.env,
    },
    shell: commandConfig.shell,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  const output = truncateCommandOutput(collectCommandOutput(result.stdout, result.stderr));
  if (result.error) {
    throw new Error(`${options.failureLabel} "${commandConfig.displayCommand}" failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = output || result.signal || 'no output';
    throw new Error(`${options.failureLabel} "${commandConfig.displayCommand}" failed with exit code ${result.status}: ${detail}`);
  }
  return {
    command: commandConfig.displayCommand,
    cwd: path.relative(rootDir, commandConfig.cwd) || '.',
    exitCode: result.status || 0,
    output: output || null,
  };
}

function collectCommandOutput(...parts: unknown[]) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

function truncateCommandOutput(value: string) {
  if (value.length <= MAX_COMMAND_OUTPUT_LENGTH) {
    return value;
  }
  return `${value.slice(0, MAX_COMMAND_OUTPUT_LENGTH)}\n[command output truncated]`;
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
  executeControlPlaneRestart,
  executeControlPlanePackageUpdate,
  prepareControlPlaneRestartCommands,
  runDeferredControlPlaneRestartCommands,
  runDeferredPackageUpdateRestartCommands,
};
