import { createActionRuntime } from '../../../src/runtime/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createActionRegistry } from '../../../src/frontend/actions.js';
import { setCustomAgentEnabledOverride } from '../../../src/server/orchestrator/custom-agents.js';
import { createActions } from '../../shared/actions.js';
import { createLocalRuntime } from '../../../src/frontend/local-runtime.js';

function fixture(t: { after(fn: () => void): void }) {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-actions-')));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const log: string[] = [];
  return { rootDir, context: { rootDir, runtime: createActionRuntime(rootDir), log: (message: string) => log.push(message) }, log };
}

test('action groups expose only selected operations and trusted overrides', async () => {
  const all = await createActionRegistry({presets: ['shared', 'development', 'maintenance']});
  const validateLocalAction = (name: string, input: unknown) => all[name].validate(input);
  assert.deepEqual(Object.keys(await createActionRegistry()), ['chat:send', 'agent:toggle']);
  assert.deepEqual(Object.keys(await createActionRegistry({ presets: ['maintenance'] })), ['package:update', 'server:restart']);
  const custom = { validate: (input: unknown) => input, run: () => 42 };
  const registry = await createActionRegistry({ overrides: { 'chat:send': null, 'game:launch': custom } });
  assert.equal(registry['chat:send'], undefined);
  assert.equal(registry['game:launch'], custom);
  await assert.rejects(() => createActionRegistry({ presets: ['unknown' as never] }), /Unknown action preset/);
  assert.throws(() => validateLocalAction('agent:toggle', { agentKey: 'worker', enabled: 'true' }), /boolean/);
  assert.throws(() => validateLocalAction('deploy', { command: 'anything' }), /Unknown input field/);
  assert.throws(() => validateLocalAction('prd:add', { id: '../escape', title: 'Title', specification: 'Spec' }), /Invalid id/);
  assert.throws(() => validateLocalAction('prd:priority', { prdId: 'example', priority: 'invalid' }), /priority/);
  assert.deepEqual(validateLocalAction('prd:add', { id: 'example', title: 'Title', requirements: ['One'] }), { id: 'example', title: 'Title', specification: '', requirements: ['One'], priority: '' });
});

test('shared chat is workflow neutral, read-only and saves bounded repo-local history', async (t) => {
  const { rootDir, context, log } = fixture(t);
  let prompt = '';
  const registry = createActions({ codex: async (options) => {
    assert.equal(options.cwd, rootDir);
    assert.equal(options.readOnly, true);
    assert.equal(options.sandboxMode, 'read-only');
    prompt = options.prompt;
    return { reply: 'A local reply.' };
  } });
  const action = registry['chat:send'];
  await action.run(action.validate({ message: 'Explain the game', threadId: 'test' }), context);
  const result = await action.run(action.validate({ message: 'Continue', threadId: 'test' }), context) as { messages: unknown[] };
  assert.equal(result.messages.length, 4);
  assert.match(prompt, /Explain the game/);
  assert.doesNotMatch(prompt, /prdProposal|PRD planning/);
  const saved = JSON.parse(fs.readFileSync(path.join(rootDir, '.autonomy/runtime/frontend/chat/test.json'), 'utf8'));
  assert.equal(saved.messages[3].text, 'A local reply.');
  assert.match(log.join('\n'), /Reply saved/);
  assert.throws(() => action.validate({ message: 'test', threadId: '../outside' }), /threadId/);
});

test('agent toggle uses the scheduler configuration key and runtime enabled override', async (t) => {
  const { rootDir, context } = fixture(t);
  const configDir = path.join(rootDir, 'prompts/autonomous/v2/config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'control-plane.json'), JSON.stringify({ spawnCustomAgents: 'custom.json' }));
  fs.writeFileSync(path.join(rootDir, 'custom.json'), JSON.stringify({ enabled: true, agents: [{ id: 'sample', workspace: '.', decision: { command: ['node', 'should-run.mjs'] } }] }));
  const runtime = createLocalRuntime({ rootDir });
  t.after(() => runtime.dispose());
  const [agent] = await runtime.listAgents();
  const action = (await createActionRegistry())['agent:toggle'];
  await action.run(action.validate({ agentKey: agent.runtimeKey, enabled: false }), { ...context, runtime: createActionRuntime(rootDir), capabilities: { controlServer() {}, executeModel: async () => ({}), setAgentEnabled: (key, enabled) => setCustomAgentEnabledOverride(rootDir, key, enabled) } });
  const result = await runtime.getAgent(agent.runtimeKey);
  assert.equal(result.enabled, false);
  assert.equal(result.enabledSource, 'runtime');
});

test('development workers report local command errors through asynchronous operation logs', async (t) => {
  const { rootDir } = fixture(t);
  const runtime = createLocalRuntime({ rootDir, actions: await createActionRegistry({ presets: ['development'] }) });
  t.after(() => runtime.dispose());
  const started = await runtime.runAction('prd:add', { id: 'example', title: 'Title', specification: 'Spec' });
  for (let attempt = 0; attempt < 200; attempt++) {
    const operation = await runtime.getOperation(started.id);
    if (operation.status !== 'running') {
      assert.equal(operation.status, 'failure');
      assert.match(operation.logs.join('\n'), /not initialized|init|ENOENT|not a git repository/i);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Worker did not finish.');
});
