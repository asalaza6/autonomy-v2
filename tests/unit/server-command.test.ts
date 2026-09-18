import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { createServerController } from '../../src/server/server-controller.js';

test('detached server starts and stops without consumer npm scripts', async t => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy bare consumer '));
  const cli = fileURLToPath(new URL('../../bin/autonomy-v2.js', import.meta.url));
  const run = (args: string[]) => promisify(execFile)(process.execPath, [cli, ...args, '--root', rootDir], {
    cwd: rootDir, timeout: 20000, env: { ...process.env, AUTONOMY_RESTART_READY_TIMEOUT_MS: '5000' },
  });
  t.after(async () => {
    await run(['server:kill']);
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  await run(['init']);
  const started = await run(['server:start', '--detached', '--no-trace-window']);
  assert.match(started.stdout, /Started autonomy-v2-server pid/);
  const owner = JSON.parse(fs.readFileSync(path.join(rootDir, '.autonomy/server-lock/owner.json'), 'utf8'));
  assert.doesNotThrow(() => process.kill(owner.pid, 0));
  const status = await run(['server:status']);
  assert.match(status.stdout, /alive=true/);
  await run(['server:kill']);
  assert.throws(() => process.kill(owner.pid, 0));
});

test('server:status reports missing owner without requiring initialized autonomy state', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-server-command-status-'));
  const output = await captureConsole(() => createServerController(rootDir).run('server:status'));

  assert.match(output.stdout, /autonomy-v2-server owner: missing/);
  assert.equal(output.stderr, '');
});

test('server:kill is a no-op when no repo-local server processes are running', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-server-command-kill-'));
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const output = await captureConsole(() => createServerController(rootDir).run('server:kill'));
    const logPath = path.join(rootDir, '.autonomy', 'runtime', 'restart-server.log');

    assert.match(output.stdout, /No autonomy-v2-server processes or trace terminals found/);
    assert.equal(output.stderr, '');
    assert.equal(process.exitCode, 0);
    assert.match(fs.readFileSync(logPath, 'utf8'), /kill requested: no server processes found/);
  } finally {
    process.exitCode = previousExitCode;
  }
});

async function captureConsole(run: () => unknown | Promise<unknown>) {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...args: unknown[]) => {
    stdout.push(args.join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.join(' '));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return {
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}
