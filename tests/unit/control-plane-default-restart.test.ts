import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildControlPlaneServiceLifecycleMetadata,
  writeControlPlaneServiceLifecycle,
} from '../../src/server/control-plane/control-plane-lifecycle.js';
import {
  createControlPlaneRestartJob,
  enqueueJob,
  loadControlPlaneState,
} from '../../src/server/control-plane/control-plane-store.js';
import {
  prepareControlPlaneRestartCommands,
  runDeferredControlPlaneRestartCommands,
} from '../../src/server/control-plane/control-plane-package-update.js';
import { runDefaultControlPlaneRestart } from '../../src/server/control-plane/control-plane-restart-helper.js';

test('restart planner preserves configured restart commands', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-configured-restart-plan-'));
  const plan = prepareControlPlaneRestartCommands(rootDir, {
    repoId: 'alpha',
    serverRestartCommand: ['node', 'server-restart.js'],
    controlBridgeRestartCommand: 'node bridge-restart.js',
  } as any);

  assert.equal(plan.restartStatus.status, 'deferred');
  assert.equal(plan.restartStatus.server.status, 'deferred');
  assert.equal(plan.restartStatus.server.mode, 'configured');
  assert.equal(plan.restartStatus.server.command, 'node server-restart.js');
  assert.equal(plan.restartStatus.controlBridge.status, 'deferred');
  assert.equal(plan.restartStatus.controlBridge.mode, 'configured');
  assert.equal(plan.restartStatus.controlBridge.command, 'node bridge-restart.js');
  assert.deepEqual(plan.deferredCommands.map((command) => command.mode), ['configured', 'configured']);
  assert.deepEqual(plan.deferredCommands.map((command) => command.target), ['server', 'controlBridge']);
});

test('restart planner creates default helper plan from valid lifecycle metadata', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-default-restart-plan-'));
  writeControlPlaneServiceLifecycle(rootDir, buildControlPlaneServiceLifecycleMetadata('server', {
    pid: process.pid,
    cwd: rootDir,
    launch: {
      command: process.execPath,
      args: ['dist/bin/autonomy-v2-control.js', 'serve', '--root', rootDir],
      cwd: rootDir,
      env: {},
    },
    matchTokens: [],
    recordedAt: '2026-04-22T01:00:00.000Z',
  }));
  writeControlPlaneServiceLifecycle(rootDir, buildControlPlaneServiceLifecycleMetadata('controlBridge', {
    pid: process.pid,
    cwd: rootDir,
    launch: {
      command: process.execPath,
      args: ['dist/bin/autonomy-v2-control.js', 'bridge', '--root', rootDir],
      cwd: rootDir,
      env: {},
    },
    matchTokens: [],
    recordedAt: '2026-04-22T01:00:01.000Z',
  }));

  const plan = prepareControlPlaneRestartCommands(rootDir, { repoId: 'alpha' } as any, {
    jobId: 'job-default-restart',
    repoId: 'alpha',
  });

  assert.equal(plan.restartStatus.status, 'deferred');
  assert.equal(plan.restartStatus.server.status, 'deferred');
  assert.equal(plan.restartStatus.server.mode, 'default');
  assert.equal(plan.restartStatus.server.reason, 'default-lifecycle-metadata');
  assert.equal(plan.restartStatus.controlBridge.status, 'deferred');
  assert.equal(plan.restartStatus.controlBridge.mode, 'default');
  assert.equal(plan.restartStatus.controlBridge.reason, 'default-lifecycle-metadata');
  assert.equal(plan.deferredCommands.length, 1);
  assert.equal(plan.deferredCommands[0].mode, 'default');
  assert.equal(plan.deferredCommands[0].target, 'default');
  assert.deepEqual(
    plan.deferredCommands[0].helperPlan.targets.map((target) => target.target),
    ['server', 'controlBridge']
  );
});

test('restart planner reports missing lifecycle metadata without guessing PIDs', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-missing-restart-plan-'));
  const plan = prepareControlPlaneRestartCommands(rootDir, { repoId: 'alpha' } as any);

  assert.equal(plan.restartStatus.status, 'skipped');
  assert.equal(plan.restartStatus.server.status, 'skipped');
  assert.equal(plan.restartStatus.server.reason, 'missing-metadata');
  assert.equal(plan.restartStatus.controlBridge.status, 'skipped');
  assert.equal(plan.restartStatus.controlBridge.reason, 'missing-metadata');
  assert.equal(plan.deferredCommands.length, 0);
});

test('restart planner fails stale lifecycle PIDs before creating a default helper', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-stale-restart-plan-'));
  const stalePid = 99999999;
  writeControlPlaneServiceLifecycle(rootDir, buildControlPlaneServiceLifecycleMetadata('server', {
    pid: stalePid,
    cwd: rootDir,
    launch: {
      command: process.execPath,
      args: ['dist/bin/autonomy-v2-control.js', 'serve'],
      cwd: rootDir,
      env: {},
    },
    matchTokens: [],
  }));
  writeControlPlaneServiceLifecycle(rootDir, buildControlPlaneServiceLifecycleMetadata('controlBridge', {
    pid: stalePid,
    cwd: rootDir,
    launch: {
      command: process.execPath,
      args: ['dist/bin/autonomy-v2-control.js', 'bridge'],
      cwd: rootDir,
      env: {},
    },
    matchTokens: [],
  }));

  const plan = prepareControlPlaneRestartCommands(rootDir, { repoId: 'alpha' } as any);

  assert.equal(plan.restartStatus.status, 'failed');
  assert.equal(plan.restartStatus.server.status, 'failed');
  assert.equal(plan.restartStatus.server.reason, 'stale-pid');
  assert.match(plan.restartStatus.server.error, /PID 99999999 is not running/);
  assert.equal(plan.restartStatus.controlBridge.status, 'failed');
  assert.equal(plan.restartStatus.controlBridge.reason, 'stale-pid');
  assert.equal(plan.deferredCommands.length, 0);
});

test('detached default restart helper stops registered PIDs and relaunches services', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-default-restart-helper-'));
  const probeScriptPath = writeRestartProbeScript(rootDir);
  const eventsPath = path.join(rootDir, 'restart-events.log');
  const serverPidPath = path.join(rootDir, 'server.pid');
  const bridgePidPath = path.join(rootDir, 'bridge.pid');
  const server = startRestartProbe(rootDir, probeScriptPath, 'server', serverPidPath, eventsPath);
  const bridge = startRestartProbe(rootDir, probeScriptPath, 'controlBridge', bridgePidPath, eventsPath);
  const cleanupPids = new Set<number>();
  t.after(async () => {
    await stopPid(readPidFile(serverPidPath));
    await stopPid(readPidFile(bridgePidPath));
    await stopChild(server);
    await stopChild(bridge);
    cleanupPids.forEach((pid) => {
      if (pid !== readPidFile(serverPidPath) && pid !== readPidFile(bridgePidPath)) {
        void stopPid(pid);
      }
    });
  });

  const originalServerPid = await waitForPidFile(serverPidPath);
  const originalBridgePid = await waitForPidFile(bridgePidPath);
  cleanupPids.add(originalServerPid);
  cleanupPids.add(originalBridgePid);
  writeControlPlaneServiceLifecycle(rootDir, buildProbeLifecycle('server', rootDir, probeScriptPath, serverPidPath, eventsPath, originalServerPid));
  writeControlPlaneServiceLifecycle(rootDir, buildProbeLifecycle('controlBridge', rootDir, probeScriptPath, bridgePidPath, eventsPath, originalBridgePid));
  const plan = prepareControlPlaneRestartCommands(rootDir, { repoId: 'alpha' } as any, {
    jobId: 'job-detached-default',
    repoId: 'alpha',
  });

  const results = await runDeferredControlPlaneRestartCommands(plan.deferredCommands);
  assert.equal(results.length, 1);
  assert.equal(results[0].mode, 'default');
  assert.equal(results[0].status, 'launched');
  assert.deepEqual(results[0].targets, ['server', 'controlBridge']);

  const newServerPid = await waitForChangedPid(serverPidPath, originalServerPid);
  const newBridgePid = await waitForChangedPid(bridgePidPath, originalBridgePid);
  cleanupPids.add(newServerPid);
  cleanupPids.add(newBridgePid);
  assert.notEqual(newServerPid, originalServerPid);
  assert.notEqual(newBridgePid, originalBridgePid);
  assert.equal(isProcessAlive(newServerPid), true);
  assert.equal(isProcessAlive(newBridgePid), true);

  const events = await waitForFileText(eventsPath);
  assert.match(events, new RegExp(`server:stopped:${originalServerPid}`));
  assert.match(events, new RegExp(`controlBridge:stopped:${originalBridgePid}`));
  assert.match(events, new RegExp(`server:started:${newServerPid}`));
  assert.match(events, new RegExp(`controlBridge:started:${newBridgePid}`));
});

test('default restart helper reports relaunch failures after stopping a verified PID', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-default-relaunch-failed-'));
  const probeScriptPath = writeRestartProbeScript(rootDir);
  const eventsPath = path.join(rootDir, 'restart-events.log');
  const pidPath = path.join(rootDir, 'server.pid');
  const server = startRestartProbe(rootDir, probeScriptPath, 'server', pidPath, eventsPath);
  t.after(async () => {
    await stopPid(readPidFile(pidPath));
    await stopChild(server);
  });

  const originalPid = await waitForPidFile(pidPath);
  const metadata = buildControlPlaneServiceLifecycleMetadata('server', {
    pid: originalPid,
    cwd: rootDir,
    launch: {
      command: path.join(rootDir, 'missing-restart-binary'),
      args: [],
      cwd: rootDir,
      env: {},
    },
    matchTokens: [path.basename(probeScriptPath), 'server'],
  });
  writeControlPlaneServiceLifecycle(rootDir, metadata);
  const job = enqueueJob(rootDir, createControlPlaneRestartJob({ repoId: 'alpha' }));

  const outcome = await runDefaultControlPlaneRestart({
    rootDir,
    jobId: job.id,
    startDelayMs: 0,
    stopTimeoutMs: 500,
    targets: [
      {
        target: 'server',
        metadata,
      },
    ],
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.targets.length, 1);
  assert.equal(outcome.targets[0].target, 'server');
  assert.equal(outcome.targets[0].status, 'relaunch-failed');
  assert.equal(outcome.targets[0].reason, 'spawn-error');
  assert.match(outcome.targets[0].error || '', /ENOENT|missing-restart-binary/);

  const storedJob = loadControlPlaneState(rootDir).jobs.find((entry) => entry.id === job.id);
  assert.equal(storedJob?.result?.restartStatus.status, 'failed');
  assert.equal(storedJob?.result?.restartStatus.helperStatus, 'failed');
  assert.equal(storedJob?.result?.restartStatus.server.status, 'relaunch-failed');
  assert.equal(storedJob?.result?.restartStatus.helperResults[0].status, 'relaunch-failed');
});

test('default restart helper reports failure when a relaunched process exits after spawn', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-default-relaunch-exited-'));
  const probeScriptPath = writeRestartProbeScript(rootDir);
  const eventsPath = path.join(rootDir, 'restart-events.log');
  const pidPath = path.join(rootDir, 'server.pid');
  const server = startRestartProbe(rootDir, probeScriptPath, 'server', pidPath, eventsPath);
  t.after(async () => {
    await stopPid(readPidFile(pidPath));
    await stopChild(server);
  });

  const originalPid = await waitForPidFile(pidPath);
  const metadata = buildControlPlaneServiceLifecycleMetadata('server', {
    pid: originalPid,
    cwd: rootDir,
    launch: {
      command: process.execPath,
      args: [probeScriptPath, 'server', pidPath, eventsPath],
      cwd: rootDir,
      env: {
        AUTONOMY_RESTART_PROBE_EXIT_CODE: '42',
      },
    },
    matchTokens: [path.basename(probeScriptPath), 'server'],
  });
  writeControlPlaneServiceLifecycle(rootDir, metadata);
  const job = enqueueJob(rootDir, createControlPlaneRestartJob({ repoId: 'alpha' }));

  const outcome = await runDefaultControlPlaneRestart({
    rootDir,
    jobId: job.id,
    startDelayMs: 0,
    stopTimeoutMs: 500,
    relaunchReadyTimeoutMs: 500,
    targets: [
      {
        target: 'server',
        metadata,
      },
    ],
  });

  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.targets.length, 1);
  assert.equal(outcome.targets[0].target, 'server');
  assert.equal(outcome.targets[0].status, 'relaunch-failed');
  assert.equal(outcome.targets[0].reason, 'early-exit');
  assert.match(outcome.targets[0].error || '', /exit code 42/);

  const storedJob = loadControlPlaneState(rootDir).jobs.find((entry) => entry.id === job.id);
  assert.equal(storedJob?.result?.restartStatus.status, 'failed');
  assert.equal(storedJob?.result?.restartStatus.helperStatus, 'failed');
  assert.equal(storedJob?.result?.restartStatus.server.status, 'relaunch-failed');
  assert.equal(storedJob?.result?.restartStatus.server.reason, 'early-exit');
  assert.equal(storedJob?.result?.restartStatus.helperResults[0].status, 'relaunch-failed');
});

function buildProbeLifecycle(
  kind: 'server' | 'controlBridge',
  rootDir: string,
  probeScriptPath: string,
  pidPath: string,
  eventsPath: string,
  pid: number
) {
  return buildControlPlaneServiceLifecycleMetadata(kind, {
    pid,
    cwd: rootDir,
    launch: {
      command: process.execPath,
      args: [probeScriptPath, kind, pidPath, eventsPath],
      cwd: rootDir,
      env: {},
    },
    matchTokens: [path.basename(probeScriptPath), kind],
  });
}

function writeRestartProbeScript(rootDir: string) {
  const scriptPath = path.join(rootDir, 'restart-probe.cjs');
  fs.writeFileSync(scriptPath, [
    "const fs = require('fs');",
    'const role = process.argv[2];',
    'const pidPath = process.argv[3];',
    'const eventsPath = process.argv[4];',
    "fs.writeFileSync(pidPath, `${process.pid}\\n`, 'utf8');",
    "fs.appendFileSync(eventsPath, `${role}:started:${process.pid}\\n`, 'utf8');",
    'const exitCode = Number(process.env.AUTONOMY_RESTART_PROBE_EXIT_CODE || 0);',
    'if (exitCode) {',
    "  fs.appendFileSync(eventsPath, `${role}:exiting:${process.pid}:${exitCode}\\n`, 'utf8');",
    '  process.exit(exitCode);',
    '}',
    'function shutdown() {',
    "  fs.appendFileSync(eventsPath, `${role}:stopped:${process.pid}\\n`, 'utf8');",
    '  process.exit(0);',
    '}',
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), 'utf8');
  return scriptPath;
}

function startRestartProbe(
  rootDir: string,
  probeScriptPath: string,
  kind: 'server' | 'controlBridge',
  pidPath: string,
  eventsPath: string
) {
  return spawn(process.execPath, [probeScriptPath, kind, pidPath, eventsPath], {
    cwd: rootDir,
    stdio: 'ignore',
  });
}

async function waitForPidFile(filePath: string, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = readPidFile(filePath);
    if (pid && isProcessAlive(pid)) {
      return pid;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for PID file ${filePath}.`);
}

async function waitForChangedPid(filePath: string, previousPid: number, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = readPidFile(filePath);
    if (pid && pid !== previousPid && isProcessAlive(pid)) {
      return pid;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath} to change from PID ${previousPid}.`);
}

function readPidFile(filePath: string) {
  try {
    const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch (_) {
    return 0;
  }
}

async function waitForFileText(filePath: string, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (child.pid) {
    await stopPid(child.pid);
  }
}

async function stopPid(pid: number) {
  if (!pid || pid === process.pid || !isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(20);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_) {
    // The process may have exited between the final poll and forced stop.
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
