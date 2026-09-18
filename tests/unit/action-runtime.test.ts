import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActionRuntime } from '../../src/runtime/index.js';
test('action runtime owns IO, process execution, repository boundaries and lock cleanup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = createActionRuntime(root);
  await runtime.writeJson('data/item.json', { value: 3 });
  assert.deepEqual(await runtime.readJson('data/item.json'), { value: 3 });
  assert.deepEqual(await runtime.readJson('missing.json', []), []);
  const files = await runtime.listFiles('data'); assert.equal(files[0].path, 'data/item.json');
  assert.equal((await runtime.runProcess(process.execPath, ['-e', 'process.stdout.write("ok")'])).stdout, 'ok');
  await assert.rejects(() => runtime.writeFile('../outside', 'bad'), /outside/);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  await assert.rejects(() => runtime.readFile('escape/outside'), /outside/);
  await assert.rejects(() => runtime.withLock(() => { throw new Error('failure'); }), /failure/);
  assert.equal(fs.existsSync(path.join(root, '.autonomy/state-lock')), false);
  await runtime.removeFile('data', { recursive: true }); assert.equal(fs.existsSync(path.join(root, 'data')), false);
});

test('async repository locks let pending operations finish while another waits', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'action-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = createActionRuntime(root), second = createActionRuntime(root);
  const order: string[] = [];
  await Promise.all([
    first.withLock(async () => { order.push('start'); await new Promise(resolve => setTimeout(resolve, 20)); order.push('end'); }),
    second.withLock(() => { order.push('second'); }),
  ]);
  assert.deepEqual(order, ['start', 'end', 'second']);
});
