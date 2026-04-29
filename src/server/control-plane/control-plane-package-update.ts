import fs from 'fs';
import path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { AGENT_ROLES } from '../../agents/role-catalog.js';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { readAutonomyPackageStatus, runPackageUpdate } from '../../autonomy-v2/commands/update.js';
import { getAgent, getAutonomyPaths, readJson } from '../../autonomy-v2/commands/shared-core.js';
import { commitTrackedFilesToIntegrationBranch } from '../../sync/sync-git.js';
import { extractExecError } from '../../sync/git-shared.js';
import type { AnyRecord, ControlPlaneConfig, DeployCommandConfig } from '../../types.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import type { ControlPlaneServiceLifecycleRecord } from './control-plane-lifecycle.js';
import { loadControlPlaneLifecycle, validateControlPlaneServiceLifecycle } from './control-plane-lifecycle.js';
import { prepareManagedProcessOutput } from './control-plane-process-output.js';
import { getManagedProcesses } from './control-plane-store.js';
import type { DefaultRestartHelperPlan } from './control-plane-restart-helper.js';

type RestartTarget = 'controlBridge' | 'server';
type DeferredRestartTarget = RestartTarget | 'default';
type RestartLaunchMode = 'visible-terminal' | 'detached';

const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_COMMAND_OUTPUT_LENGTH = 4000;
const PACKAGE_UPDATE_COMMIT_MESSAGE = 'autonomy(update): refresh autonomy-v2 package';
const MANAGED_RESTART_READY_TIMEOUT_MS = 750;
const DEFAULT_VISIBLE_RESTART_PLATFORM = 'darwin';

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
  rootDir: string;
  repoId?: string;
  commandConfig: NormalizedControlPlaneCommandConfig;
  existingPid?: number | null;
}

interface DefaultDeferredRestartCommand {
  mode: 'default';
  target: 'default';
  command: string;
  cwd: string;
  helperPlan: DefaultRestartHelperPlan;
  launchMode: RestartLaunchMode;
  fallbackToDetached: boolean;
}

type DeferredRestartCommand = ConfiguredDeferredRestartCommand | DefaultDeferredRestartCommand;

interface DeferredRestartLaunchResult {
  target: DeferredRestartTarget;
  mode: 'configured' | 'default';
  command: string;
  cwd: string;
  status: 'launched' | 'failed';
  launchMode?: RestartLaunchMode;
  requestedLaunchMode?: RestartLaunchMode;
  terminalOpened?: boolean;
  terminalApp?: string;
  fallbackReason?: string;
  targets?: RestartTarget[];
  postRestartPid?: number | null;
  outputSessionId?: string;
  completedAt: string;
  error?: string;
}

async function executeControlPlanePackageUpdate(rootDir: string) {
  const commitContext = capturePackageUpdateCommitContext(rootDir);
  const config = loadControlPlaneConfig(rootDir);
  const packageUpdateCommand = normalizePackageUpdateCommandConfig(config.packageUpdateCommand, rootDir);
  if (packageUpdateCommand) {
    return executeCustomControlPlanePackageUpdate(rootDir, packageUpdateCommand, commitContext);
  }

  const update = runPackageUpdate(rootDir, {});
  const snapshot = buildStatusSnapshot(rootDir);
  const commitResult = commitPackageUpdateChanges(rootDir, commitContext);
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
      commit: commitResult,
      commitSha: commitResult.commitSha || null,
      pushMessage: commitResult.pushMessage || null,
      updateCommand,
      errors,
    },
  };
}

async function executeCustomControlPlanePackageUpdate(
  rootDir: string,
  packageUpdateCommand: NormalizedControlPlaneCommandConfig,
  commitContext: PackageUpdateCommitContext
) {
  const before = readAutonomyPackageStatus(rootDir);
  const commandResult = await runConfiguredControlPlaneCommand(packageUpdateCommand, rootDir, {
    failureLabel: 'Package update command',
    env: {
      AUTONOMY_PACKAGE_UPDATE_ROOT: rootDir,
    },
  });
  const snapshot = buildStatusSnapshot(rootDir);
  const after = snapshot.autonomyPackage || readAutonomyPackageStatus(rootDir);
  const commitResult = commitPackageUpdateChanges(rootDir, commitContext);
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
      commit: commitResult,
      commitSha: commitResult.commitSha || null,
      pushMessage: commitResult.pushMessage || null,
      updateCommand: {
        status: 'completed' as const,
        mode: 'custom' as const,
        ...commandResult,
      },
      errors: [] as string[],
    },
  };
}

interface PackageUpdateCommitContext {
  enabled: boolean;
  integrationBranch: string;
  beforePaths: Set<string>;
  beforePathStates: Map<string, string>;
  gitIdentity?: AnyRecord;
  skipReason?: string;
}

function capturePackageUpdateCommitContext(rootDir: string): PackageUpdateCommitContext {
  if (!isGitRepository(rootDir)) {
    return {
      enabled: false,
      integrationBranch: 'dev',
      beforePaths: new Set<string>(),
      beforePathStates: new Map<string, string>(),
      skipReason: 'not-a-git-repo',
    };
  }
  const beforePaths = listWorkingTreePaths(rootDir);
  return {
    enabled: true,
    integrationBranch: resolveIntegrationBranch(rootDir),
    beforePaths,
    beforePathStates: captureWorkingTreePathStates(rootDir, beforePaths),
    gitIdentity: resolvePackageUpdateGitIdentity(rootDir),
  };
}

function commitPackageUpdateChanges(rootDir: string, context: PackageUpdateCommitContext) {
  if (!context.enabled) {
    return {
      committed: false,
      pushed: false,
      commitSha: null,
      pushMessage: null,
      paths: [],
      skipped: true as const,
      reason: context.skipReason || 'disabled',
    };
  }
  const afterPaths = listWorkingTreePaths(rootDir);
  const changedPaths = Array.from(afterPaths)
    .filter((relativePath) => {
      if (!context.beforePaths.has(relativePath)) {
        return true;
      }
      return readWorkingTreePathState(rootDir, relativePath) !== context.beforePathStates.get(relativePath);
    })
    .sort();
  if (changedPaths.length === 0) {
    return {
      committed: false,
      pushed: false,
      commitSha: null,
      pushMessage: null,
      paths: [],
      skipped: true as const,
      reason: 'no-package-update-changes',
    };
  }
  const updates = changedPaths.map((relativePath) => {
    const absolutePath = path.join(rootDir, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return {
        relativePath,
        delete: true,
      };
    }
    return {
      relativePath,
      content: fs.readFileSync(absolutePath, 'utf8'),
    };
  });
  const commitResult = commitTrackedFilesToIntegrationBranch(rootDir, context.integrationBranch, updates, {
    commitMessage: PACKAGE_UPDATE_COMMIT_MESSAGE,
    gitIdentity: context.gitIdentity,
  });
  return {
    committed: commitResult.committed,
    pushed: commitResult.pushed,
    commitSha: commitResult.commitSha || null,
    pushMessage: commitResult.pushMessage || null,
    paths: commitResult.paths || changedPaths,
    skipped: commitResult.committed !== true,
    reason: commitResult.committed === true ? null : 'no-staged-package-update-changes',
  };
}

function resolveIntegrationBranch(rootDir: string) {
  const paths = getAutonomyPaths(rootDir);
  if (!fs.existsSync(paths.agentsConfig)) {
    return 'dev';
  }
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  return String(config.integrationBranch || 'dev').trim() || 'dev';
}

function resolvePackageUpdateGitIdentity(rootDir: string) {
  const paths = getAutonomyPaths(rootDir);
  if (!fs.existsSync(paths.agentsConfig)) {
    return undefined;
  }
  try {
    const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
    return getAgent(config, `${AGENT_ROLES.PM}-agent`).gitIdentity;
  } catch {
    return undefined;
  }
}

function isGitRepository(rootDir: string) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function listWorkingTreePaths(rootDir: string) {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return new Set(
      output
        .split('\n')
        .map((line) => String(line || '').trimEnd())
        .filter(Boolean)
        .map((line) => normalizePorcelainPath(line))
        .filter(Boolean)
    );
  } catch (error) {
    throw new Error(`Failed to inspect package update git changes: ${extractExecError(error)}`);
  }
}

function captureWorkingTreePathStates(rootDir: string, paths: Iterable<string>) {
  const states = new Map<string, string>();
  for (const relativePath of paths) {
    states.set(relativePath, readWorkingTreePathState(rootDir, relativePath));
  }
  return states;
}

function readWorkingTreePathState(rootDir: string, relativePath: string) {
  const absolutePath = path.join(rootDir, relativePath);
  if (!fs.existsSync(absolutePath)) {
    return 'missing';
  }
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    return `non-file:${stat.size}:${stat.mtimeMs}`;
  }
  return `file:${fs.readFileSync(absolutePath, 'utf8')}`;
}

function normalizePorcelainPath(line: string) {
  const payload = String(line || '').slice(3).trim();
  if (!payload) {
    return '';
  }
  if (payload.includes(' -> ')) {
    return payload.split(' -> ').pop() || '';
  }
  return payload;
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
  const restartLaunch = resolveRestartLaunchSettings(config);
  const managedProcesses = (String(context.repoId || '').trim()
    ? getManagedProcesses(rootDir, context.repoId)
    : {}) as Partial<Record<RestartTarget, { pid?: number | null; running?: boolean }>>;
  const controlBridgePlan = prepareRestartTarget(
    rootDir,
    'controlBridge',
    config.controlBridgeRestartCommand,
    managedProcesses.controlBridge || null,
    context,
  );
  const controlBridge = controlBridgePlan.status;
  const serverPlan = prepareRestartTarget(
    rootDir,
    'server',
    config.serverRestartCommand,
    managedProcesses.server || null,
    context,
  );
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
    deferredCommands: buildDeferredRestartCommands(rootDir, serverPlan, controlBridgePlan, context, restartLaunch),
  };
}

function resolveRestartLaunchSettings(config: ControlPlaneConfig) {
  const configuredMode = config.restartLaunchMode === 'detached'
    ? 'detached'
    : config.restartLaunchMode === 'visible-terminal'
      ? 'visible-terminal'
      : null;
  const defaultMode: RestartLaunchMode = process.platform === DEFAULT_VISIBLE_RESTART_PLATFORM
    ? 'visible-terminal'
    : 'detached';
  return {
    mode: configuredMode || defaultMode,
    fallbackToDetached: config.restartLaunchFallbackToDetached === true,
  };
}

function prepareRestartTarget(
  rootDir: string,
  target: RestartTarget,
  value: DeployCommandConfig | null | undefined,
  managedProcess: { pid?: number | null; running?: boolean } | null = null,
  context: {
    repoId?: string;
  } = {},
) {
  const lifecycleMetadata = readLifecycleMetadata(rootDir, target);
  const managedPid = normalizeManagedPid(managedProcess?.pid);
  const activeManagedPid = managedProcess?.running !== false && managedPid && isProcessAlive(managedPid)
    ? managedPid
    : null;
  const preRestartPid = activeManagedPid ?? lifecycleMetadata?.pid;
  let commandConfig: NormalizedControlPlaneCommandConfig | null;
  try {
    commandConfig = normalizeRestartCommandConfig(value, rootDir);
  } catch (error) {
    return {
      status: {
        target,
        status: 'failed' as const,
        error: formatErrorMessage(error),
        mode: 'configured' as const,
        preRestartPid,
        recordedAt: lifecycleMetadata?.recordedAt,
        completedAt: new Date().toISOString(),
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
        preRestartPid,
        recordedAt: lifecycleMetadata?.recordedAt,
      },
      configuredCommand: {
        mode: 'configured' as const,
        target,
        rootDir,
        repoId: String(context.repoId || '').trim() || undefined,
        commandConfig,
        existingPid: activeManagedPid,
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
        mode: 'default' as const,
        completedAt: new Date().toISOString(),
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
        preRestartPid: validation.metadata?.pid,
        recordedAt: validation.metadata?.recordedAt,
        completedAt: new Date().toISOString(),
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
        preRestartPid: validation.metadata.pid,
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

function readLifecycleMetadata(rootDir: string, target: RestartTarget) {
  const lifecycle = loadControlPlaneLifecycle(rootDir);
  return lifecycle.services[target] || null;
}

function buildDeferredRestartCommands(
  rootDir: string,
  serverPlan: ReturnType<typeof prepareRestartTarget>,
  controlBridgePlan: ReturnType<typeof prepareRestartTarget>,
  context: {
    jobId?: string;
    repoId?: string;
  },
  restartLaunch: ReturnType<typeof resolveRestartLaunchSettings>
) {
  const deferredCommands: DeferredRestartCommand[] = [];
  if (serverPlan.configuredCommand) {
    deferredCommands.push(serverPlan.configuredCommand);
  }

  const defaultTargets = [serverPlan.defaultTarget, controlBridgePlan.defaultTarget]
    .filter((target): target is { target: RestartTarget; metadata: ControlPlaneServiceLifecycleRecord } => Boolean(target));
  if (defaultTargets.length > 0) {
    deferredCommands.push(createDefaultRestartCommand(rootDir, defaultTargets, context, restartLaunch));
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
  },
  restartLaunch: ReturnType<typeof resolveRestartLaunchSettings>
): DefaultDeferredRestartCommand {
  const helperPlan: DefaultRestartHelperPlan = {
    rootDir,
    jobId: String(context.jobId || '').trim() || undefined,
    repoId: String(context.repoId || '').trim() || undefined,
    requestedAt: new Date().toISOString(),
    launchMode: restartLaunch.mode,
    fallbackToDetached: restartLaunch.fallbackToDetached,
    targets,
  };
  return {
    mode: 'default',
    target: 'default',
    command: 'default lifecycle restart helper',
    cwd: rootDir,
    helperPlan,
    launchMode: restartLaunch.mode,
    fallbackToDetached: restartLaunch.fallbackToDetached,
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

  const { target, commandConfig, existingPid } = deferredCommand;
  const repoId = String(deferredCommand.repoId || '').trim();
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

    void stopExistingManagedProcess(existingPid).then((stopError) => {
      if (stopError) {
        settle({
          ...base,
          status: 'failed',
          completedAt: new Date().toISOString(),
          postRestartPid: existingPid ?? null,
          error: stopError,
        });
        return;
      }

      let child: ReturnType<typeof spawn>;
      const outputCapture = repoId
        ? prepareManagedProcessOutput(deferredCommand.rootDir, repoId, target, {
          command: commandConfig.displayCommand,
          cwd: commandConfig.cwd,
        })
        : null;
      try {
        child = spawn(commandConfig.command, commandConfig.args, {
          cwd: commandConfig.cwd,
          detached: true,
          env: {
            ...process.env,
            ...commandConfig.env,
          },
          shell: commandConfig.shell,
          stdio: outputCapture ? outputCapture.stdio : 'ignore',
        });
      } catch (error) {
        outputCapture?.close();
        settle({
          ...base,
          status: 'failed',
          completedAt: new Date().toISOString(),
          postRestartPid: null,
          error: formatErrorMessage(error),
        });
        return;
      }
      child.once('spawn', () => {
        outputCapture?.close();
        void waitForManagedRestartReadiness(child, MANAGED_RESTART_READY_TIMEOUT_MS).then((outcome) => {
          if (outcome.status === 'launched') {
            child.unref();
          }
          settle({
            ...base,
            ...outcome,
            outputSessionId: outputCapture?.outputSessionId,
          });
        });
      });
      child.once('error', (error) => {
        outputCapture?.close();
        settle({
          ...base,
          status: 'failed',
          postRestartPid: child.pid || null,
          completedAt: new Date().toISOString(),
          error: error.message,
          outputSessionId: outputCapture?.outputSessionId,
        });
      });
    });
  });
}

function startDetachedDefaultRestartHelper(deferredCommand: DefaultDeferredRestartCommand): Promise<DeferredRestartLaunchResult> {
  const base = {
    target: 'default' as const,
    mode: 'default' as const,
    command: deferredCommand.command,
    cwd: deferredCommand.cwd,
    launchMode: deferredCommand.launchMode,
    requestedLaunchMode: deferredCommand.helperPlan.launchMode,
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

    const helperCommand = buildDefaultRestartHelperCommand(deferredCommand.helperPlan);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(helperCommand.command, helperCommand.args, {
        cwd: helperCommand.cwd,
        detached: true,
        env: helperCommand.env,
        stdio: 'ignore',
      });
    } catch (error) {
      settle({
        ...base,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: formatErrorMessage(error),
      });
      return;
    }

    child.once('spawn', () => {
      child.unref();
      settle({
        ...base,
        status: 'launched',
        completedAt: new Date().toISOString(),
      });
    });
    child.once('error', (error) => {
      settle({
        ...base,
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: error.message,
      });
    });
  });
}

function buildDefaultRestartHelperCommand(helperPlan: DefaultRestartHelperPlan) {
  const helperPath = fileURLToPath(new URL('./control-plane-restart-helper.js', import.meta.url));
  return {
    command: process.execPath,
    args: [
      ...process.execArgv,
      helperPath,
      '--payload',
      Buffer.from(JSON.stringify(helperPlan), 'utf8').toString('base64url'),
    ],
    cwd: helperPlan.rootDir,
    env: {
      ...process.env,
    },
  };
}

async function stopExistingManagedProcess(pid: number | null | undefined) {
  const normalizedPid = normalizeManagedPid(pid);
  if (!normalizedPid || !isProcessAlive(normalizedPid)) {
    return null;
  }
  if (normalizedPid === process.pid) {
    return `Refusing to stop restart helper PID ${normalizedPid}.`;
  }
  try {
    process.kill(normalizedPid, 'SIGTERM');
  } catch (error) {
    return isNoSuchProcessError(error) ? null : formatErrorMessage(error);
  }
  const exited = await waitForManagedProcessExit(normalizedPid, 4000);
  if (exited) {
    return null;
  }
  try {
    process.kill(normalizedPid, 'SIGKILL');
  } catch (error) {
    return isNoSuchProcessError(error) ? null : formatErrorMessage(error);
  }
  return await waitForManagedProcessExit(normalizedPid, 500)
    ? null
    : `Managed process PID ${normalizedPid} did not exit before replacement.`;
}

async function waitForManagedProcessExit(pid: number, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function waitForManagedRestartReadiness(
  child: ReturnType<typeof spawn>,
  readyTimeoutMs: number
): Promise<Pick<DeferredRestartLaunchResult, 'status' | 'postRestartPid' | 'completedAt' | 'error'>> {
  const observedReadyTimeoutMs = Number.isFinite(readyTimeoutMs)
    ? Math.max(100, readyTimeoutMs)
    : MANAGED_RESTART_READY_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let readinessTimer: NodeJS.Timeout | undefined;
    let onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
    const settle = (result: Pick<DeferredRestartLaunchResult, 'status' | 'postRestartPid' | 'completedAt' | 'error'>) => {
      if (settled) {
        return;
      }
      settled = true;
      if (readinessTimer) {
        clearTimeout(readinessTimer);
      }
      child.off('exit', onExit);
      resolve(result);
    };

    onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0 && signal === null) {
        settle({
          status: 'launched',
          postRestartPid: child.pid || null,
          completedAt: new Date().toISOString(),
        });
        return;
      }
      settle({
        status: 'failed',
        postRestartPid: child.pid || null,
        completedAt: new Date().toISOString(),
        error: `Restarted process exited with ${formatExitStatus(code, signal)} before readiness.`,
      });
    };

    child.once('exit', onExit);
    readinessTimer = setTimeout(() => {
      if (child.pid && !isProcessAlive(child.pid)) {
        settle({
          status: 'failed',
          postRestartPid: child.pid,
          completedAt: new Date().toISOString(),
          error: `Restarted process PID ${child.pid} exited before readiness.`,
        });
        return;
      }
      settle({
        status: 'launched',
        postRestartPid: child.pid || null,
        completedAt: new Date().toISOString(),
      });
    }, observedReadyTimeoutMs);
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

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return !isZombieProcess(pid);
  } catch (error) {
    return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'EPERM');
  }
}

function normalizeManagedPid(value: unknown) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isZombieProcess(pid: number) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 && /\bZ/.test(String(result.stdout || '').trim());
}

function isNoSuchProcessError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ESRCH');
}

function formatExitStatus(code: number | null, signal: NodeJS.Signals | null) {
  if (code !== null) {
    return `exit code ${code}`;
  }
  if (signal) {
    return `signal ${signal}`;
  }
  return 'an unknown status';
}

async function runConfiguredControlPlaneCommand(
  commandConfig: NormalizedControlPlaneCommandConfig,
  rootDir: string,
  options: {
    failureLabel: string;
    env?: Record<string, string>;
  }
) {
  if (shouldStreamDebugChildLogs()) {
    return runConfiguredControlPlaneCommandWithStreaming(commandConfig, rootDir, options);
  }
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

async function runConfiguredControlPlaneCommandWithStreaming(
  commandConfig: NormalizedControlPlaneCommandConfig,
  rootDir: string,
  options: {
    failureLabel: string;
    env?: Record<string, string>;
  }
) {
  return await new Promise<{
    command: string;
    cwd: string;
    exitCode: number;
    output: string | null;
  }>((resolve, reject) => {
    const child = spawn(commandConfig.command, commandConfig.args, {
      cwd: commandConfig.cwd,
      env: {
        ...process.env,
        ...(options.env || {}),
        ...commandConfig.env,
      },
      shell: commandConfig.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, DEFAULT_COMMAND_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      const text = String(chunk || '');
      stdoutChunks.push(text);
      process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '');
      stderrChunks.push(text);
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`${options.failureLabel} "${commandConfig.displayCommand}" failed: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      const output = truncateCommandOutput(collectCommandOutput(stdoutChunks.join(''), stderrChunks.join('')));
      if (timedOut) {
        reject(new Error(`${options.failureLabel} "${commandConfig.displayCommand}" timed out after ${DEFAULT_COMMAND_TIMEOUT_MS}ms: ${output || 'no output'}`));
        return;
      }
      if (code !== 0) {
        const detail = output || signal || 'no output';
        reject(new Error(`${options.failureLabel} "${commandConfig.displayCommand}" failed with exit code ${code}: ${detail}`));
        return;
      }
      resolve({
        command: commandConfig.displayCommand,
        cwd: path.relative(rootDir, commandConfig.cwd) || '.',
        exitCode: code || 0,
        output: output || null,
      });
    });
  });
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

function shouldStreamDebugChildLogs() {
  return String(process.env.DEBUG || '').trim().toLowerCase() === 'true';
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
  buildDefaultRestartHelperCommand,
  executeControlPlaneRestart,
  executeControlPlanePackageUpdate,
  prepareControlPlaneRestartCommands,
  resolveRestartLaunchSettings,
  runDeferredControlPlaneRestartCommands,
  runDeferredPackageUpdateRestartCommands,
};
