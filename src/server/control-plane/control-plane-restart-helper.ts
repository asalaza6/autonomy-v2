#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { ControlPlaneServiceKind, ControlPlaneServiceLifecycleRecord } from './control-plane-lifecycle.js';
import { validateControlPlaneServiceLifecycle } from './control-plane-lifecycle.js';
import { prepareManagedProcessOutput } from './control-plane-process-output.js';
import { loadControlPlaneState, saveControlPlaneState } from './control-plane-store.js';

type RestartOutcomeStatus = 'restarted' | 'skipped' | 'missing-metadata' | 'stale-pid' | 'relaunch-failed' | 'failed';
type RestartLaunchMode = 'visible-terminal' | 'detached';

interface DefaultRestartTarget {
  target: ControlPlaneServiceKind;
  metadata: ControlPlaneServiceLifecycleRecord;
}

interface DefaultRestartHelperPlan {
  rootDir: string;
  jobId?: string;
  repoId?: string;
  requestedAt?: string;
  startDelayMs?: number;
  stopTimeoutMs?: number;
  relaunchReadyTimeoutMs?: number;
  launchMode?: RestartLaunchMode;
  fallbackToDetached?: boolean;
  targets: DefaultRestartTarget[];
}

interface DefaultRestartTargetOutcome {
  target: ControlPlaneServiceKind;
  status: RestartOutcomeStatus;
  requestedLaunchMode?: RestartLaunchMode;
  launchMode?: RestartLaunchMode;
  terminalOpened?: boolean;
  terminalApp?: string;
  fallbackReason?: string;
  pid?: number;
  preRestartPid?: number;
  postRestartPid?: number;
  command?: string;
  cwd?: string;
  reason?: string;
  error?: string;
  recordedAt?: string;
  completedAt?: string;
}

interface DefaultRestartOutcome {
  status: 'restarted' | 'skipped' | 'failed';
  completedAt: string;
  targets: DefaultRestartTargetOutcome[];
}

const DEFAULT_START_DELAY_MS = 500;
const DEFAULT_STOP_TIMEOUT_MS = 4000;
const DEFAULT_RELAUNCH_READY_TIMEOUT_MS = 750;
const PROCESS_POLL_MS = 50;
const MIN_RELAUNCH_OBSERVATION_MS = PROCESS_POLL_MS * 2;
const CONTROL_BRIDGE_START_DELAY_ENV = 'AUTONOMY_CONTROL_PLANE_BRIDGE_START_DELAY_MS';
const CONTROL_BRIDGE_START_DELAY_BUFFER_MS = PROCESS_POLL_MS * 4;
const RESTART_RUNTIME_SEGMENTS = ['.autonomy', 'control-plane', 'restart-runtime'];
const TERMINAL_APP = 'Terminal';

async function runDefaultControlPlaneRestart(plan: DefaultRestartHelperPlan): Promise<DefaultRestartOutcome> {
  const normalizedPlan = normalizeDefaultRestartPlan(plan);
  await delay(normalizedPlan.startDelayMs || 0);

  const validationOutcomes: DefaultRestartTargetOutcome[] = [];
  const restartTargets: DefaultRestartTarget[] = [];
  for (const target of orderedTargets(normalizedPlan.targets)) {
    const validation = validateControlPlaneServiceLifecycle(normalizedPlan.rootDir, target.target, target.metadata);
    if (validation.status !== 'valid' || !validation.metadata) {
      const status = validation.status === 'missing-metadata' ? 'missing-metadata' : 'stale-pid';
      validationOutcomes.push({
        target: target.target,
        status,
        pid: target.metadata.pid,
        preRestartPid: target.metadata.pid,
        command: target.metadata.launchCommand,
        cwd: target.metadata.cwd,
        reason: validation.reason,
        error: validation.error,
        recordedAt: target.metadata.recordedAt,
        completedAt: new Date().toISOString(),
      });
      continue;
    }
    restartTargets.push({
      target: target.target,
      metadata: validation.metadata,
    });
  }

  const stopOutcomes: DefaultRestartTargetOutcome[] = [];
  for (const target of orderedTargets(restartTargets)) {
    const stopped = await stopRegisteredProcess(target, normalizedPlan.stopTimeoutMs || DEFAULT_STOP_TIMEOUT_MS);
    stopOutcomes.push(stopped);
  }

  const stoppedTargets = restartTargets.filter((target) => {
    return stopOutcomes.some((outcome) => (
      outcome.target === target.target
      && outcome.status === 'skipped'
      && (outcome.reason === 'stopped' || outcome.reason === 'force-stopped')
    ));
  });
  const relaunchReadyTimeoutMs = normalizedPlan.relaunchReadyTimeoutMs || DEFAULT_RELAUNCH_READY_TIMEOUT_MS;
  const launchOutcomes: DefaultRestartTargetOutcome[] = [];
  let outcome = buildDefaultRestartOutcome([
    ...validationOutcomes,
    ...stopOutcomes,
    ...launchOutcomes,
  ]);
  for (const target of orderedTargets(stoppedTargets)) {
    launchOutcomes.push(await relaunchService(
      normalizedPlan.rootDir,
      normalizedPlan.repoId,
      target,
      relaunchReadyTimeoutMs,
      normalizedPlan.launchMode,
      normalizedPlan.fallbackToDetached === true
    ));
    outcome = buildDefaultRestartOutcome([
      ...validationOutcomes,
      ...stopOutcomes,
      ...launchOutcomes,
    ]);
    recordRestartOutcome(normalizedPlan.rootDir, normalizedPlan.jobId, outcome);
  }

  if (launchOutcomes.length === 0) {
    recordRestartOutcome(normalizedPlan.rootDir, normalizedPlan.jobId, outcome);
  }
  return outcome;
}

async function stopRegisteredProcess(
  target: DefaultRestartTarget,
  stopTimeoutMs: number
): Promise<DefaultRestartTargetOutcome> {
  const metadata = target.metadata;
  if (!metadata.pid) {
    return {
      target: target.target,
      status: 'missing-metadata',
      reason: 'missing-pid',
      error: `${formatTargetLabel(target.target)} lifecycle metadata does not include a PID.`,
      recordedAt: metadata.recordedAt,
      completedAt: new Date().toISOString(),
    };
  }
  if (metadata.pid === process.pid) {
    return {
      target: target.target,
      status: 'failed',
      pid: metadata.pid,
      preRestartPid: metadata.pid,
      reason: 'helper-self-protection',
      error: `Refusing to stop helper process PID ${metadata.pid}.`,
      recordedAt: metadata.recordedAt,
      completedAt: new Date().toISOString(),
    };
  }

  try {
    process.kill(metadata.pid, 'SIGTERM');
  } catch (error) {
    if (isNoSuchProcessError(error)) {
      return {
        target: target.target,
        status: 'stale-pid',
        pid: metadata.pid,
        preRestartPid: metadata.pid,
        reason: 'stale-pid',
        error: `${formatTargetLabel(target.target)} PID ${metadata.pid} exited before restart.`,
        recordedAt: metadata.recordedAt,
        completedAt: new Date().toISOString(),
      };
    }
    return {
        target: target.target,
        status: 'failed',
        pid: metadata.pid,
        preRestartPid: metadata.pid,
        reason: 'stop-failed',
        error: formatErrorMessage(error),
        recordedAt: metadata.recordedAt,
        completedAt: new Date().toISOString(),
      };
  }

  const exited = await waitForProcessExit(metadata.pid, stopTimeoutMs);
  if (exited) {
    return {
      target: target.target,
      status: 'skipped',
      pid: metadata.pid,
      preRestartPid: metadata.pid,
      reason: 'stopped',
      recordedAt: metadata.recordedAt,
      completedAt: new Date().toISOString(),
    };
  }

  try {
    process.kill(metadata.pid, 'SIGKILL');
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      return {
        target: target.target,
        status: 'failed',
        pid: metadata.pid,
        preRestartPid: metadata.pid,
        reason: 'force-stop-failed',
        error: formatErrorMessage(error),
        recordedAt: metadata.recordedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  const killed = await waitForProcessExit(metadata.pid, PROCESS_POLL_MS * 10);
  return killed
    ? {
      target: target.target,
      status: 'skipped',
      pid: metadata.pid,
      preRestartPid: metadata.pid,
      reason: 'force-stopped',
      recordedAt: metadata.recordedAt,
      completedAt: new Date().toISOString(),
    }
    : {
      target: target.target,
      status: 'failed',
      pid: metadata.pid,
      preRestartPid: metadata.pid,
      reason: 'stop-timeout',
      error: `${formatTargetLabel(target.target)} PID ${metadata.pid} did not exit.`,
      recordedAt: metadata.recordedAt,
      completedAt: new Date().toISOString(),
    };
}

function relaunchService(
  rootDir: string,
  repoId: string | undefined,
  target: DefaultRestartTarget,
  readyTimeoutMs: number,
  launchMode: RestartLaunchMode,
  fallbackToDetached: boolean
): Promise<DefaultRestartTargetOutcome> {
  if (launchMode === 'visible-terminal') {
    return relaunchInVisibleTerminal(rootDir, target, readyTimeoutMs, fallbackToDetached);
  }
  return relaunchDetachedService(rootDir, repoId, target, readyTimeoutMs);
}

function relaunchDetachedService(
  rootDir: string,
  repoId: string | undefined,
  target: DefaultRestartTarget,
  readyTimeoutMs: number,
  fallbackReason?: string
): Promise<DefaultRestartTargetOutcome> {
  const metadata = target.metadata;
  const launch = metadata.launch;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: DefaultRestartTargetOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    const outputCapture = repoId
      ? prepareManagedProcessOutput(rootDir, repoId, target.target, {
        command: metadata.launchCommand,
        cwd: launch.cwd,
      })
      : null;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd,
        detached: true,
        env: buildRelaunchEnv(target.target, launch.env || {}, readyTimeoutMs),
        stdio: outputCapture ? outputCapture.stdio : 'ignore',
      });
    } catch (error) {
      outputCapture?.close();
      settle({
        target: target.target,
        status: 'relaunch-failed',
        requestedLaunchMode: fallbackReason ? 'visible-terminal' : 'detached',
        launchMode: 'detached',
        terminalOpened: false,
        ...(fallbackReason ? { fallbackReason } : {}),
        command: metadata.launchCommand,
        cwd: launch.cwd,
        reason: 'spawn-threw',
        error: formatErrorMessage(error),
        preRestartPid: metadata.pid,
        recordedAt: metadata.recordedAt,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    child.once('spawn', () => {
      outputCapture?.close();
      void waitForRelaunchReadiness(target, child, readyTimeoutMs).then((outcome) => {
        if (outcome.status === 'restarted') {
          child.unref();
        }
        settle({
          ...outcome,
          requestedLaunchMode: fallbackReason ? 'visible-terminal' : 'detached',
          launchMode: 'detached',
          terminalOpened: false,
          ...(fallbackReason ? { fallbackReason } : {}),
        });
      });
    });
    child.once('error', (error) => {
      outputCapture?.close();
      settle({
        target: target.target,
        status: 'relaunch-failed',
        requestedLaunchMode: fallbackReason ? 'visible-terminal' : 'detached',
        launchMode: 'detached',
        terminalOpened: false,
        ...(fallbackReason ? { fallbackReason } : {}),
        command: metadata.launchCommand,
        cwd: launch.cwd,
        reason: 'spawn-error',
        error: error.message,
        preRestartPid: metadata.pid,
        recordedAt: metadata.recordedAt,
        completedAt: new Date().toISOString(),
      });
    });
  });
}

async function relaunchInVisibleTerminal(
  rootDir: string,
  target: DefaultRestartTarget,
  readyTimeoutMs: number,
  fallbackToDetached: boolean
): Promise<DefaultRestartTargetOutcome> {
  const metadata = target.metadata;
  const launch = metadata.launch;
  if (process.platform !== 'darwin') {
    if (fallbackToDetached) {
      return relaunchDetachedService(rootDir, undefined, target, readyTimeoutMs, 'unsupported-platform');
    }
    return {
      target: target.target,
      status: 'failed',
      requestedLaunchMode: 'visible-terminal',
      launchMode: 'visible-terminal',
      terminalOpened: false,
      terminalApp: TERMINAL_APP,
      command: metadata.launchCommand,
      cwd: launch.cwd,
      reason: 'unsupported-platform',
      error: `Visible terminal restart is only supported on macOS. Current platform: ${process.platform}.`,
      preRestartPid: metadata.pid,
      recordedAt: metadata.recordedAt,
      completedAt: new Date().toISOString(),
    };
  }

  const pidFilePath = getVisibleLaunchPidFilePath(rootDir, target.target);
  const scriptPath = getVisibleLaunchScriptPath(rootDir, target.target);
  fs.mkdirSync(path.dirname(pidFilePath), { recursive: true });
  fs.rmSync(pidFilePath, { force: true });
  writeVisibleLaunchScript(scriptPath, launch.cwd, buildRelaunchEnv(target.target, launch.env || {}, readyTimeoutMs), metadata.launchCommand, launch.command, launch.args, pidFilePath);

  try {
    openTerminalWindow(buildVisibleTerminalCommand(target.target, scriptPath, pidFilePath, metadata.launchCommand));
  } catch (error) {
    if (fallbackToDetached) {
      return relaunchDetachedService(rootDir, undefined, target, readyTimeoutMs, 'terminal-open-failed');
    }
    return {
      target: target.target,
      status: 'relaunch-failed',
      requestedLaunchMode: 'visible-terminal',
      launchMode: 'visible-terminal',
      terminalOpened: false,
      terminalApp: TERMINAL_APP,
      command: metadata.launchCommand,
      cwd: launch.cwd,
      reason: 'terminal-open-failed',
      error: formatErrorMessage(error),
      preRestartPid: metadata.pid,
      recordedAt: metadata.recordedAt,
      completedAt: new Date().toISOString(),
    };
  }

  return waitForVisibleTerminalRelaunchReadiness(target, pidFilePath, readyTimeoutMs);
}

function waitForRelaunchReadiness(
  target: DefaultRestartTarget,
  child: ReturnType<typeof spawn>,
  readyTimeoutMs: number
): Promise<DefaultRestartTargetOutcome> {
  const metadata = target.metadata;
  const launch = metadata.launch;
  const observedReadyTimeoutMs = normalizeRelaunchReadyTimeoutMs(readyTimeoutMs);
  return new Promise((resolve) => {
    let settled = false;
    let readinessTimer: NodeJS.Timeout | undefined;
    let onExit: (code: number | null, signal: NodeJS.Signals | null) => void = () => {};
    const finish = (outcome: DefaultRestartTargetOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      if (readinessTimer) {
        clearTimeout(readinessTimer);
      }
      child.off('exit', onExit);
      resolve(outcome);
    };
    onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish({
        target: target.target,
        status: 'relaunch-failed',
        pid: child.pid || undefined,
        preRestartPid: metadata.pid,
        postRestartPid: child.pid || undefined,
        command: metadata.launchCommand,
        cwd: launch.cwd,
        reason: 'early-exit',
        error: `${formatTargetLabel(target.target)} relaunched${child.pid ? ` as PID ${child.pid}` : ''} but exited with ${formatExitStatus(code, signal)} before readiness.`,
        recordedAt: metadata.recordedAt,
        completedAt: new Date().toISOString(),
      });
    };

    child.once('exit', onExit);
    readinessTimer = setTimeout(() => {
      if (child.pid && !isProcessAlive(child.pid)) {
        finish({
          target: target.target,
          status: 'relaunch-failed',
          pid: child.pid,
          preRestartPid: metadata.pid,
          postRestartPid: child.pid,
          command: metadata.launchCommand,
          cwd: launch.cwd,
          reason: 'early-exit',
          error: `${formatTargetLabel(target.target)} relaunched as PID ${child.pid} but exited before readiness.`,
          recordedAt: metadata.recordedAt,
          completedAt: new Date().toISOString(),
        });
        return;
      }
      finish({
        target: target.target,
        status: 'restarted',
        pid: child.pid || undefined,
        preRestartPid: metadata.pid,
        postRestartPid: child.pid || undefined,
        command: metadata.launchCommand,
        cwd: launch.cwd,
        recordedAt: metadata.recordedAt,
        completedAt: new Date().toISOString(),
      });
    }, observedReadyTimeoutMs);
  });
}

async function waitForVisibleTerminalRelaunchReadiness(
  target: DefaultRestartTarget,
  pidFilePath: string,
  readyTimeoutMs: number
): Promise<DefaultRestartTargetOutcome> {
  const metadata = target.metadata;
  const launch = metadata.launch;
  const observedReadyTimeoutMs = normalizeRelaunchReadyTimeoutMs(readyTimeoutMs);
  const deadline = Date.now() + observedReadyTimeoutMs;
  let observedPid: number | null = null;

  while (Date.now() <= deadline) {
    observedPid = readObservedPidFile(pidFilePath);
    if (observedPid && isProcessAlive(observedPid)) {
      break;
    }
    await delay(PROCESS_POLL_MS);
  }

  if (!observedPid) {
    return {
      target: target.target,
      status: 'relaunch-failed',
      requestedLaunchMode: 'visible-terminal',
      launchMode: 'visible-terminal',
      terminalOpened: true,
      terminalApp: TERMINAL_APP,
      command: metadata.launchCommand,
      cwd: launch.cwd,
      reason: 'pid-observation-timeout',
      error: `${formatTargetLabel(target.target)} visible terminal opened but no relaunched PID was observed before readiness timeout.`,
      preRestartPid: metadata.pid,
      recordedAt: metadata.recordedAt,
      completedAt: new Date().toISOString(),
    };
  }

  while (Date.now() <= deadline) {
    if (!isProcessAlive(observedPid)) {
      return {
        target: target.target,
        status: 'relaunch-failed',
        requestedLaunchMode: 'visible-terminal',
        launchMode: 'visible-terminal',
        terminalOpened: true,
        terminalApp: TERMINAL_APP,
        pid: observedPid,
        preRestartPid: metadata.pid,
        postRestartPid: observedPid,
        command: metadata.launchCommand,
        cwd: launch.cwd,
        reason: 'early-exit',
        error: `${formatTargetLabel(target.target)} relaunched as PID ${observedPid} but exited before readiness.`,
        recordedAt: metadata.recordedAt,
        completedAt: new Date().toISOString(),
      };
    }
    await delay(PROCESS_POLL_MS);
  }

  return {
    target: target.target,
    status: 'restarted',
    requestedLaunchMode: 'visible-terminal',
    launchMode: 'visible-terminal',
    terminalOpened: true,
    terminalApp: TERMINAL_APP,
    pid: observedPid,
    preRestartPid: metadata.pid,
    postRestartPid: observedPid,
    command: metadata.launchCommand,
    cwd: launch.cwd,
    recordedAt: metadata.recordedAt,
    completedAt: new Date().toISOString(),
  };
}

function buildDefaultRestartOutcome(outcomes: DefaultRestartTargetOutcome[]): DefaultRestartOutcome {
  return {
    status: aggregateRestartOutcome(outcomes),
    completedAt: new Date().toISOString(),
    targets: compactOutcomes(outcomes),
  };
}

function buildRelaunchEnv(
  target: ControlPlaneServiceKind,
  launchEnv: Record<string, string>,
  readyTimeoutMs: number
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...launchEnv,
  };
  if (target === 'controlBridge') {
    const existingDelayMs = normalizeNonNegativeNumber(env[CONTROL_BRIDGE_START_DELAY_ENV]);
    const requiredDelayMs = normalizeRelaunchReadyTimeoutMs(readyTimeoutMs) + CONTROL_BRIDGE_START_DELAY_BUFFER_MS;
    env[CONTROL_BRIDGE_START_DELAY_ENV] = String(Math.max(existingDelayMs, requiredDelayMs));
  }
  return env;
}

function normalizeRelaunchReadyTimeoutMs(readyTimeoutMs: number) {
  return Number.isFinite(readyTimeoutMs)
    ? Math.max(MIN_RELAUNCH_OBSERVATION_MS, readyTimeoutMs)
    : DEFAULT_RELAUNCH_READY_TIMEOUT_MS;
}

function getVisibleLaunchPidFilePath(rootDir: string, target: ControlPlaneServiceKind) {
  return path.join(rootDir, ...RESTART_RUNTIME_SEGMENTS, `${target}.pid`);
}

function getVisibleLaunchScriptPath(rootDir: string, target: ControlPlaneServiceKind) {
  return path.join(rootDir, ...RESTART_RUNTIME_SEGMENTS, `${target}.sh`);
}

function writeVisibleLaunchScript(
  scriptPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  displayCommand: string,
  command: string,
  args: string[],
  pidFilePath: string
) {
  const envLines = Object.entries(env)
    .filter(([key, value]) => key && typeof value !== 'undefined')
    .map(([key, value]) => `export ${key}=${shellQuote(String(value))}`);
  const lines = [
    '#!/bin/sh',
    'set -eu',
    `cd ${shellQuote(cwd)}`,
    ...envLines,
    `mkdir -p ${shellQuote(path.dirname(pidFilePath))}`,
    `echo $$ > ${shellQuote(pidFilePath)}`,
    `echo ${shellQuote(`Launching: ${displayCommand}`)}`,
    `exec ${formatExecCommand(command, args)}`,
    '',
  ];
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, lines.join('\n'), 'utf8');
  fs.chmodSync(scriptPath, 0o755);
}

function buildVisibleTerminalCommand(target: ControlPlaneServiceKind, scriptPath: string, pidFilePath: string, displayCommand: string) {
  const label = target === 'controlBridge' ? 'Control bridge' : 'Control plane server';
  return [
    `printf '\\033]0;%s\\007' ${shellQuote(`Autonomy restart: ${label}`)}`,
    'clear',
    `echo ${shellQuote(`Autonomy v2 visible restart: ${label}`)}`,
    `echo ${shellQuote(`PID file: ${pidFilePath}`)}`,
    `echo ${shellQuote(`Command: ${displayCommand}`)}`,
    `exec /bin/sh ${shellQuote(scriptPath)}`,
  ].join('; ');
}

function openTerminalWindow(command: string) {
  execFileSync('osascript', ['-e', buildTerminalOpenScript(command)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildTerminalOpenScript(command: string) {
  return [
    'tell application "Terminal"',
    'activate',
    `do script ${toAppleScriptString(command)}`,
    'end tell',
  ].join('\n');
}

function toAppleScriptString(value: string) {
  return `"${String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')}"`;
}

function readObservedPidFile(filePath: string) {
  try {
    const pid = Number(String(fs.readFileSync(filePath, 'utf8') || '').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function normalizeNonNegativeNumber(value: unknown) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.max(0, numberValue) : 0;
}

function recordRestartOutcome(rootDir: string, jobId: string | undefined, outcome: DefaultRestartOutcome) {
  const normalizedJobId = String(jobId || '').trim();
  if (!normalizedJobId) {
    return;
  }
  try {
    const state = loadControlPlaneState(rootDir);
    const job = state.jobs.find((entry) => entry.id === normalizedJobId);
    if (!job) {
      return;
    }
    const result = job.result && typeof job.result === 'object' ? job.result : {};
    const restartStatus = result.restartStatus && typeof result.restartStatus === 'object'
      ? result.restartStatus
      : {};
    const targetUpdates = outcome.targets.reduce((updates, target) => {
      updates[target.target] = {
        ...(restartStatus[target.target] || {}),
        ...target,
        ...(target.launchMode ? { restartLaunchMode: target.launchMode } : {}),
      };
      return updates;
    }, {} as Record<string, DefaultRestartTargetOutcome>);
    job.result = {
      ...result,
      restartStatus: {
        ...restartStatus,
        ...targetUpdates,
        status: outcome.status,
        completedAt: outcome.completedAt,
        helperStatus: outcome.status,
        helperResults: outcome.targets,
      },
      errors: outcome.targets
        .map((target) => target.error || '')
        .filter(Boolean),
    };
    job.updatedAt = outcome.completedAt;
    saveControlPlaneState(rootDir, state);
  } catch (_) {
    // The helper is best-effort after the job has already reached a terminal state.
  }
}

function normalizeDefaultRestartPlan(plan: DefaultRestartHelperPlan): DefaultRestartHelperPlan {
  return {
    rootDir: String(plan.rootDir || '').trim(),
    jobId: String(plan.jobId || '').trim() || undefined,
    repoId: String(plan.repoId || '').trim() || undefined,
    requestedAt: String(plan.requestedAt || new Date().toISOString()),
    startDelayMs: Number.isFinite(Number(plan.startDelayMs)) ? Math.max(0, Number(plan.startDelayMs)) : DEFAULT_START_DELAY_MS,
    stopTimeoutMs: Number.isFinite(Number(plan.stopTimeoutMs)) ? Math.max(0, Number(plan.stopTimeoutMs)) : DEFAULT_STOP_TIMEOUT_MS,
    relaunchReadyTimeoutMs: Number.isFinite(Number(plan.relaunchReadyTimeoutMs)) ? Math.max(0, Number(plan.relaunchReadyTimeoutMs)) : DEFAULT_RELAUNCH_READY_TIMEOUT_MS,
    launchMode: plan.launchMode === 'detached' ? 'detached' : 'visible-terminal',
    fallbackToDetached: plan.fallbackToDetached === true,
    targets: Array.isArray(plan.targets) ? plan.targets : [],
  };
}

function orderedTargets<T extends { target: ControlPlaneServiceKind }>(targets: T[]) {
  const rank: Record<ControlPlaneServiceKind, number> = {
    server: 0,
    controlBridge: 1,
  };
  return targets.slice().sort((left, right) => rank[left.target] - rank[right.target]);
}

function compactOutcomes(outcomes: DefaultRestartTargetOutcome[]) {
  const byTarget = new Map<ControlPlaneServiceKind, DefaultRestartTargetOutcome>();
  outcomes.forEach((outcome) => {
    if (outcome.status === 'skipped' && (outcome.reason === 'stopped' || outcome.reason === 'force-stopped')) {
      return;
    }
    byTarget.set(outcome.target, outcome);
  });
  return orderedTargets(Array.from(byTarget.values()));
}

function aggregateRestartOutcome(outcomes: DefaultRestartTargetOutcome[]): DefaultRestartOutcome['status'] {
  const visibleOutcomes = compactOutcomes(outcomes);
  if (visibleOutcomes.some((outcome) => (
    outcome.status === 'failed'
    || outcome.status === 'relaunch-failed'
    || outcome.status === 'stale-pid'
  ))) {
    return 'failed';
  }
  if (visibleOutcomes.some((outcome) => outcome.status === 'restarted')) {
    return 'restarted';
  }
  return 'skipped';
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(PROCESS_POLL_MS);
  }
  return false;
}

function isProcessAlive(pid: number) {
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

function isNoSuchProcessError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ESRCH');
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatTargetLabel(target: ControlPlaneServiceKind) {
  return target === 'controlBridge' ? 'Control bridge' : 'Control panel server';
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

function formatExecCommand(command: string, args: string[]) {
  return [command, ...args].map((entry) => shellQuote(entry)).join(' ');
}

function shellQuote(value: string) {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;
}

function parseHelperPlanArg(argv: string[]) {
  const payloadIndex = argv.indexOf('--payload');
  if (payloadIndex < 0 || !argv[payloadIndex + 1]) {
    throw new Error('Missing --payload.');
  }
  return JSON.parse(Buffer.from(argv[payloadIndex + 1], 'base64url').toString('utf8')) as DefaultRestartHelperPlan;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runDefaultControlPlaneRestart(parseHelperPlanArg(process.argv.slice(2))).catch((error) => {
    console.error(`ERROR: ${formatErrorMessage(error)}`);
    process.exit(1);
  });
}

export type {
  DefaultRestartHelperPlan,
  DefaultRestartOutcome,
  DefaultRestartTarget,
  DefaultRestartTargetOutcome,
  RestartOutcomeStatus,
};

export {
  runDefaultControlPlaneRestart,
};
