import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import Shared from '../frontend.js';
import Development from '../../development/frontend.js';
import Maintenance from '../../maintenance/frontend.js';
import type { AutonomyRuntime, FrontendPageProps } from '../../../src/frontend/index.js';

function fixture(): { props: FrontendPageProps; calls: unknown[]; stopped: () => number } {
  const calls = []; let stopped = 0;
  const runtime = {
    async listFiles() { return []; }, async readJson() { return {}; },
    watch() { return () => { stopped++; }; },
    async listAgents() { return [{ runtimeKey: 'game:one', agentId: 'generator', enabled: true }]; },
    async getAgent() { return null; }, async listRuns() { return []; }, async getRun() { return null; }, async readLogs() { return { text: '', done: true }; },
    async runAction(name, input) { if (name !== 'prd:list') calls.push({ name, input }); return { id: 'operation', name, status: 'success', startedAt: '', logs: [], result: name === 'chat:send' ? { id: 'thread', messages: [{ role: 'assistant', text: 'Reply' }] } : name === 'prd:list' ? [] : null }; },
    async getOperation() { return null; },
  } as unknown as AutonomyRuntime;
  return { props: { runtime, context: { repository: { id: 'fixture', rootDir: '/fixture' } } }, calls, stopped: () => stopped };
}
test('all packaged frontend pages render React without a backend', () => {
  const { props } = fixture();
  assert.match(renderToStaticMarkup(<Shared {...props} />), /Chat/);
  assert.match(renderToStaticMarkup(<Development {...props} />), /PRDs/);
  assert.match(renderToStaticMarkup(<Maintenance {...props} />), /Update package/);
});
test('preset navigation and forms invoke runtime actions and dispose watchers', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const { props, calls, stopped } = fixture();
  let view;
  await act(async () => { view = create(<Development {...props} />); });
  const inputs = view.root.findAllByType('input');
  await act(async () => { inputs[0].props.onChange({ target: { value: 'new-prd' } }); inputs[1].props.onChange({ target: { value: 'Title' } }); view.root.findByType('textarea').props.onChange({ target: { value: 'Specification' } }); });
  await act(async () => { view.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(calls[0], { name: 'prd:add', input: { id: 'new-prd', title: 'Title', specification: 'Specification' } });
  const navigation = label => view.root.findAllByType('button').find(button => button.children.join('') === label);
  await act(async () => { navigation('Chat').props.onClick(); });
  await act(async () => { view.root.findByType('textarea').props.onChange({ target: { value: 'Hello' } }); });
  await act(async () => { view.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(calls[1], { name: 'chat:send', input: { message: 'Hello' } });
  await act(async () => { navigation('Agents').props.onClick(); });
  await act(async () => { view.root.findAllByType('button').find(button => button.children.join('').includes('Disable')).props.onClick(); });
  assert.deepEqual(calls[2], { name: 'agent:toggle', input: { agentKey: 'game:one', enabled: false } });
  await act(async () => { navigation('History').props.onClick(); });
  assert.match(JSON.stringify(view.toJSON()), /No archived PRDs/);
  await act(async () => { view.unmount(); }); assert.ok(stopped() >= 3);
});
