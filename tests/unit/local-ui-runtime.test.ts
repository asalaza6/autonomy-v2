import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLocalRuntime } from '../../src/frontend/local-runtime.js';
import type { AutonomyRuntime, Operation } from '../../src/frontend/runtime-types.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-local-ui-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function write(file: string, value: unknown) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return { root, write };
}

async function finished(runtime: AutonomyRuntime, initial: Operation) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const operation = await runtime.getOperation(initial.id);
    if (operation?.status !== 'running') return operation;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Operation did not settle.');
}

test('local files support text, binary, JSON, discovery and reject escaping paths', async (t) => {
  const { root, write } = fixture(t);
  write('nested/value.json', { value: 3 });
  write('asset.bin', 'hello');
  fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
  fs.symlinkSync('nested', path.join(root, 'alias'));
  const runtime = createLocalRuntime({ rootDir: root });
  t.after(() => runtime.dispose());
  assert.deepEqual(await runtime.readJson('alias/value.json'), { value: 3 });
  assert.equal(await runtime.readFile('asset.bin', { encoding: 'base64' }), 'aGVsbG8=');
  assert.deepEqual((await runtime.listFiles('.', { recursive: true })).map((file) => file.path), ['alias', 'asset.bin', 'nested', 'nested/value.json', 'outside']);
  await assert.rejects(runtime.readFile('../outside'), /outside the repository/);
  await assert.rejects(runtime.readFile('outside/missing'), /outside the repository/);
  await assert.rejects(runtime.listFiles('outside'), /outside the repository/);
  assert.throws(() => runtime.watch(['outside'], () => {}), /outside the repository/);
  fs.symlinkSync(path.join(os.tmpdir(), 'missing-destination'), path.join(root, 'dangling'));
  await assert.rejects(runtime.readFile('dangling/value'), /Unresolved symlink/);
  write('broken.json', '{');
  await assert.rejects(runtime.readJson('broken.json'), SyntaxError);
  runtime.dispose();
  await assert.rejects(runtime.readFile('asset.bin'), /disposed/);
});

test('agent and invocation lookups preserve config-qualified keys and parallel pools without mutating state', async (t) => {
  const { root, write } = fixture(t);
  const configDir = 'prompts/autonomous/v2/config';
  write(`${configDir}/control-plane.json`, { spawnCustomAgents: ['first.json', 'second.json'] });
  const config = { enabled: true, agents: [{ id: 'worker', parallelism: 2, workspace: '.', decision: { command: ['node', '-e', ''] }, lifecycle: { environment: ['node', '-e', ''], prompt: ['node', '-e', ''], finalize: ['node', '-e', ''] } }] };
  write('first.json', config);
  write('second.json', config);
  const runtime = createLocalRuntime({ rootDir: root });
  t.after(() => runtime.dispose());
  const agents = await runtime.listAgents();
  assert.equal(agents.length, 2);
  assert.notEqual(agents[0].runtimeKey, agents[1].runtimeKey);
  assert.equal((await runtime.getAgent(agents[0].runtimeKey))?.runtimeKey, agents[0].runtimeKey);
  assert.equal(await runtime.getAgent('worker'), null);
  const key = agents[0].runtimeKey;
  const runDir = '.autonomy/runtime/custom-agents/test-run';
  write(`${runDir}/environment.command.json`, { stdout: 'prepared' });
  write(`${runDir}/run.log`, 'first\nsecond\n');
  const state = { workers: {}, customAgentInvocations: {
    'run-old': { runtimeKey: `${key}#2`, baseRuntimeKey: key, startedAt: '2026-01-01', paths: { invocationDir: path.join(root, runDir) } },
    'run-new': { runtimeKey: key, startedAt: '2026-01-02' },
    other: { runtimeKey: agents[1].runtimeKey, startedAt: '2026-01-03' },
  } };
  write('.autonomy/runtime/state/runtime.json', state);
  const before = fs.readFileSync(path.join(root, '.autonomy/runtime/state/runtime.json'), 'utf8');
  assert.deepEqual((await runtime.listRuns(key)).map((run) => run.invocationId), ['run-new', 'run-old']);
  assert.deepEqual((await runtime.getRun('run-old'))?.outputs, { environment: { stdout: 'prepared' } });
  assert.equal(await runtime.getRun('missing'), null);
  const first = await runtime.readLogs('run-old', { limit: 6 });
  assert.deepEqual(first, { path: 'run.log', text: 'first\n', nextOffset: 6, done: false });
  assert.equal((await runtime.readLogs('run-old', { offset: first.nextOffset })).text, 'second\n');
  await assert.rejects(runtime.readLogs('run-old', { path: '../../../../package.json' }), /outside the repository/);
  await assert.rejects(runtime.readLogs('run-old', { limit: -1 }), /bounds/);
  write(`${runDir}/unicode.log`, '🌍 next');
  const unicode = await runtime.readLogs('run-old', { path: 'unicode.log', limit: 1 });
  assert.equal(unicode.text, '🌍');
  assert.equal(unicode.nextOffset, 4);
  fs.symlinkSync(path.join(root, 'first.json'), path.join(root, runDir, 'escape.log'));
  await assert.rejects(runtime.readLogs('run-old', { path: 'escape.log' }), /outside the repository/);
  assert.equal(fs.readFileSync(path.join(root, '.autonomy/runtime/state/runtime.json'), 'utf8'), before);
});

test('registered actions validate, lock, report failures and retain independent operation history', async (t) => {
  const { root } = fixture(t);
  let release: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const validate = (input: unknown) => {
    if (typeof input !== 'number') throw new Error('Expected a number.');
    return input;
  };
  const runtime = createLocalRuntime({ rootDir: root, actions: {
    slow: { validate, lockKey: 'shared', async run(input, context) { context.log('started'); await gate; return input; } },
    conflict: { validate, lockKey: 'shared', run: () => 0 },
    quick: { validate, run: (input) => input },
    fail: { validate, run() { throw new Error('Expected failure'); } },
  } });
  t.after(() => runtime.dispose());
  await assert.rejects(runtime.runAction('unknown'), /Unknown action/);
  await assert.rejects(runtime.runAction('slow', 'wrong'), /Expected a number/);
  const slow = await runtime.runAction('slow', 4);
  assert.equal(slow.status, 'running');
  await assert.rejects(runtime.runAction('conflict', 1), /already running/);
  assert.equal((await finished(runtime, await runtime.runAction('quick', 2)))?.result, 2);
  const failed = await finished(runtime, await runtime.runAction('fail', 3));
  assert.equal(failed?.status, 'failure');
  assert.equal(failed?.error, 'Expected failure');
  release();
  const done = await finished(runtime, slow);
  assert.equal(done?.status, 'success');
  assert.deepEqual(done?.logs, ['started']);
  done?.logs.push('mutated');
  assert.deepEqual((await runtime.getOperation(slow.id))?.logs, ['started']);
  runtime.dispose();
  const restarted = createLocalRuntime({ rootDir: root });
  t.after(() => restarted.dispose());
  assert.equal((await restarted.getOperation(slow.id))?.result, 4);
  await assert.rejects(restarted.getOperation('../escape'), /Invalid operation ID/);
});

test('watch tracks missing paths, unsubscribes, and closes with its runtime', async (t) => {
  const { root, write } = fixture(t);
  const runtime = createLocalRuntime({ rootDir: root });
  t.after(() => runtime.dispose());
  let count = 0;
  let changed: () => void;
  const notification = new Promise<void>((resolve) => { changed = resolve; });
  const unsubscribe = runtime.watch(['new.json'], () => { count++; changed(); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  write('new.json', '{}');
  let timeout: NodeJS.Timeout;
  try {
    await Promise.race([notification, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Missing watch notification')), 3000); })]);
  } finally { clearTimeout(timeout); }
  unsubscribe();
  const previous = count;
  write('new.json', '{"next":true}');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(count, previous);
  runtime.watch(['new.json'], () => { count++; });
  runtime.dispose();
  write('new.json', '{}');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(count, previous);
});
