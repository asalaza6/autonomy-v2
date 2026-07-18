import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCodex } from '../src/custom-agents/codex.js';
import { loadRuntime } from '../src/runtime.js';
import {
  makeRoot,
  waitForChild,
  withEnvironment,
  writeExecutable,
  writeFluxborneFixture,
} from './helpers.js';

type ProcessMarker = {
  processPid: number;
  descendantPid: number;
};

const resistantDescendantSource = `
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
setInterval(() => {}, 1_000);
`;

test('a Codex timeout kills a SIGTERM-resistant descendant', {
  skip: process.platform === 'win32',
  timeout: 10_000,
}, async () => {
  const rootDir = makeRoot();
  const markerPath = path.join(rootDir, 'codex-processes.json');
  const fakeCodexPath = path.join(rootDir, 'fake-codex');
  let marker: ProcessMarker | null = null;

  writeResistantProcessTree(fakeCodexPath, markerPath);
  try {
    await withEnvironment({
      AUTONOMY_CODEX_BIN: fakeCodexPath,
      AUTONOMY_CODEX_EXEC_TIMEOUT_MS: '500',
    }, async () => {
      const rejection = assert.rejects(runCodex({
        cwd: rootDir,
        prompt: 'wait forever',
        sandboxMode: 'workspace-write',
      }), /exceeded wall-clock timeout/);

      await waitFor(() => fs.existsSync(markerPath), 3_000, 'fake Codex PID marker');
      marker = readMarker(markerPath);
      await rejection;
      await waitFor(
        () => !isProcessAlive(marker?.descendantPid),
        2_000,
        'timed-out Codex descendant to exit'
      );
      assert.equal(isProcessAlive(marker.descendantPid), false);
    });
  } finally {
    cleanupProcessTree(marker);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('server shutdown retains a worker process group through SIGKILL grace', {
  skip: process.platform === 'win32',
  timeout: 15_000,
}, async () => {
  const fixture = writeFluxborneFixture(makeRoot());
  const markerPath = path.join(fixture.rootDir, 'server-processes.json');
  const serverPath = fileURLToPath(new URL('../bin/autonomy-v2-server.js', import.meta.url));
  let marker: ProcessMarker | null = null;
  let server: ChildProcess | null = null;
  let workerPid = 0;
  let output = '';

  writeResistantProcessTree(fixture.codexPath, markerPath);
  try {
    server = spawn(process.execPath, [
      serverPath,
      'serve',
      '--root',
      fixture.rootDir,
      '--poll-ms',
      '50',
    ], {
      cwd: fixture.rootDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AUTONOMY_CODEX_BIN: fixture.codexPath,
        AUTONOMY_CODEX_EXEC_TIMEOUT_MS: '0',
      },
    });
    server.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    server.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });

    await waitFor(() => fs.existsSync(markerPath), 6_000, 'server Codex PID marker');
    marker = readMarker(markerPath);
    workerPid = Number(loadRuntime(fixture.rootDir).customAgents['game-agent:fluxborne']?.pid || 0);
    assert.ok(workerPid > 0, `expected a tracked worker PID; server output:\n${output}`);

    server.kill('SIGTERM');
    const exit = await waitForChildWithTimeout(server, 4_000);
    assert.equal(exit.code, 0, `server output:\n${output}`);
    await waitFor(
      () => !isProcessAlive(marker?.processPid) && !isProcessAlive(marker?.descendantPid),
      2_000,
      'server-owned process tree to exit'
    );
    assert.equal(isProcessAlive(marker.processPid), false);
    assert.equal(isProcessAlive(marker.descendantPid), false);
  } finally {
    killProcessGroup(server?.pid);
    killProcessGroup(workerPid);
    cleanupProcessTree(marker);
    await delay(50);
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

test('server shutdown cancels an in-flight decision before worker launch', {
  skip: process.platform === 'win32',
  timeout: 12_000,
}, async () => {
  const fixture = writeFluxborneFixture(makeRoot());
  const decisionPath = path.join(fixture.rootDir, 'scripts', 'agent', 'decision.mjs');
  const decisionReadyPath = path.join(fixture.rootDir, 'decision-ready');
  const serverPath = fileURLToPath(new URL('../bin/autonomy-v2-server.js', import.meta.url));
  let decisionPid = 0;
  let workerPid = 0;
  let server: ChildProcess | null = null;
  let output = '';

  writeExecutable(decisionPath, `#!/usr/bin/env node
import fs from 'node:fs';

let handled = false;
process.on('SIGTERM', () => {
  if (handled) return;
  handled = true;
  fs.writeSync(1, JSON.stringify({
    shouldRun: true,
    reason: 'run only after shutdown begins',
  }) + '\\n');
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(decisionReadyPath)}, String(process.pid));
setInterval(() => {}, 1_000);
`);

  try {
    server = spawn(process.execPath, [
      serverPath,
      'serve',
      '--root',
      fixture.rootDir,
      '--poll-ms',
      '50',
    ], {
      cwd: fixture.rootDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AUTONOMY_CODEX_BIN: fixture.codexPath,
      },
    });
    server.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    server.stderr?.on('data', (chunk) => {
      output += String(chunk);
    });

    await waitFor(() => fs.existsSync(decisionReadyPath), 5_000, 'in-flight decision');
    decisionPid = Number(fs.readFileSync(decisionReadyPath, 'utf8'));
    assert.ok(decisionPid > 0);

    server.kill('SIGTERM');
    const exit = await waitForChildWithTimeout(server, 5_000);
    assert.equal(exit.code, 0, `server output:\n${output}`);

    const status = loadRuntime(fixture.rootDir).customAgents['game-agent:fluxborne'];
    workerPid = Number(status?.pid || 0);
    assert.equal(status?.running, false, `server output:\n${output}`);
    assert.equal(status?.lastDecision, 'cancelled', `server output:\n${output}`);
    assert.equal(fs.existsSync(fixture.lifecycleLog), false, `server output:\n${output}`);
    assert.equal(fs.existsSync(fixture.codexLog), false, `server output:\n${output}`);
  } finally {
    killProcessGroup(server?.pid);
    killProcessGroup(decisionPid);
    killProcessGroup(workerPid);
    killProcess(decisionPid);
    await delay(50);
    fs.rmSync(fixture.rootDir, { recursive: true, force: true });
  }
});

function writeResistantProcessTree(executablePath: string, markerPath: string) {
  writeExecutable(executablePath, `#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(resistantDescendantSource)}], {
  stdio: 'ignore',
});
fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
  processPid: process.pid,
  descendantPid: descendant.pid,
}));
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
setInterval(() => {}, 1_000);
`);
}

function readMarker(markerPath: string): ProcessMarker {
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as ProcessMarker;
  assert.ok(Number.isInteger(marker.processPid) && marker.processPid > 0);
  assert.ok(Number.isInteger(marker.descendantPid) && marker.descendantPid > 0);
  return marker;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  description: string
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

async function waitForChildWithTimeout(child: ChildProcess, timeoutMs: number) {
  return Promise.race([
    waitForChild(child),
    delay(timeoutMs).then(() => {
      throw new Error(`Timed out waiting for child process ${child.pid || '-'}`);
    }),
  ]);
}

function isProcessAlive(pid: number | null | undefined) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const status = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return Boolean(status) && !status.includes('Z');
  } catch {
    return true;
  }
}

function cleanupProcessTree(marker: ProcessMarker | null) {
  killProcessGroup(marker?.processPid);
  killProcess(marker?.processPid);
  killProcess(marker?.descendantPid);
}

function killProcessGroup(pid: number | null | undefined) {
  if (!pid || !Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return;
  killProcess(-pid);
}

function killProcess(pid: number | null | undefined) {
  if (!pid || !Number.isInteger(pid) || pid === 0) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
