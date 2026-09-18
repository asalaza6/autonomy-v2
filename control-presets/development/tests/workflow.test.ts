import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFrontendRuntime } from '../../../src/frontend/configured-runtime.js';
import { createActionRuntime } from '../../../src/runtime/index.js';

function fixture(t) {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'development-controls-')));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'dev'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(rootDir, '.gitignore'), '.autonomy/\n');
  fs.writeFileSync(path.join(rootDir, 'controls.json'), JSON.stringify({ controls: { preset: 'development' } }));
  git('add', '.'); git('commit', '-m', 'fixture');
  return { rootDir, git };
}
async function invoke(runtime, name, input) {
  const operation = await runtime.runAction(name, input);
  for (let i = 0; i < 300; i++) {
    const result = await runtime.getOperation(operation.id);
    if (result.status !== 'running') { assert.equal(result.status, 'success', result.error); return result.result; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Action timed out');
}
test('PRD controls write tracked specs consumed by PM and reset the custom lifecycle state', async t => {
  const { rootDir, git } = fixture(t);
  const { runtime } = await createFrontendRuntime({ rootDir, configPath: 'controls.json' }); t.after(() => runtime.dispose());
  const io = createActionRuntime(rootDir);
  const first = await invoke(runtime, 'prd:add', { id: 'one', title: 'First', specification: 'Do the work' });
  assert.equal(first.queued, false);
  assert.equal(JSON.parse(git('show', 'dev:prompts/autonomous/v2/specs/prds/one.json')).specification, 'Do the work');
  const second = await invoke(runtime, 'prd:add', { id: 'two', title: 'Second', requirements: ['Test it'] });
  assert.equal(second.queued, true);
  await invoke(runtime, 'prd:priority', { prdId: 'two', priority: 'highest' });
  assert.equal(JSON.parse(git('show', 'dev:prompts/autonomous/v2/specs/prds/queue/two.json')).priority, 'highest');
  const lifecycle = '.autonomy/runtime/custom-lifecycle';
  await io.writeJson(`${lifecycle}/queues/architecture.json`, { tasks: [{ id: 'task', prdId: 'one', status: 'active' }, { id: 'other', prdId: 'two', status: 'pending' }] });
  await io.writeJson(`${lifecycle}/state/prs.json`, { pullRequests: [{ id: 'pr', prdId: 'one' }, { id: 'keep', prdId: 'two' }] });
  await invoke(runtime, 'prd:reset', { prdId: 'one', reason: 'Restart planning' });
  assert.equal(fs.existsSync(path.join(rootDir, 'prompts/autonomous/v2/specs/prds/one.json')), false);
  assert.equal(JSON.parse(git('show', 'dev:prompts/autonomous/v2/specs/prds/archived/one.json')).archive.reason, 'Restart planning');
  assert.equal((await io.readJson<any>(`${lifecycle}/queues/architecture.json`)).tasks[0].status, 'archived');
  assert.deepEqual((await io.readJson<any>(`${lifecycle}/state/prs.json`)).pullRequests, [{ id: 'keep', prdId: 'two' }]);
  assert.equal(git('status', '--porcelain'), '');
  await invoke(runtime, 'prd:reset', { prdId: 'two' });
  const recreated = await invoke(runtime, 'prd:add', { id: 'one', title: 'New generation', specification: 'New work' });
  assert.equal(recreated.queued, false);
});

test('PRD reads and mutations use integration branch while checkout stays on another branch', async t => {
  const { rootDir, git } = fixture(t);
  git('checkout', '-b', 'main');
  const { runtime } = await createFrontendRuntime({ rootDir, configPath: 'controls.json' }); t.after(() => runtime.dispose());
  await invoke(runtime, 'prd:add', { id: 'branch-test', title: 'Branch test', specification: 'Same state in UI and action' });
  assert.equal(git('branch', '--show-current'), 'main');
  assert.equal(fs.existsSync(path.join(rootDir, 'prompts/autonomous/v2/specs/prds/branch-test.json')), false);
  const entries = await invoke(runtime, 'prd:list', {});
  assert.equal(entries[0].id, 'branch-test');
  await invoke(runtime, 'prd:reset', { prdId: 'branch-test' });
  assert.equal((await invoke(runtime, 'prd:list', {}))[0].archive.kind, 'reset');
  assert.equal(git('status', '--porcelain'), '');
});
