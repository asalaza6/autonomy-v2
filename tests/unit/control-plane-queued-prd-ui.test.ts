import test from 'node:test';
import assert from 'node:assert/strict';

import { h, renderToHtml } from '../../src/server/control-plane/control-plane-jsx-runtime/jsx-runtime.js';

test('queued PRD selection stays stable until queue membership changes', async () => {
  installBrowserStubs();
  const { resolveSelectedQueuedPrdState } = await import(`../../src/server/control-plane/control-plane-client.js?queued-selection=${Date.now()}`);

  const initial = resolveSelectedQueuedPrdState([
    { id: 'prd-queued-001' },
    { id: 'prd-queued-002' },
  ], '');
  assert.equal(initial.selectedPrdId, 'prd-queued-001');

  const stable = resolveSelectedQueuedPrdState([
    { id: 'prd-queued-001' },
    { id: 'prd-queued-002' },
  ], 'prd-queued-002');
  assert.equal(stable.selectedPrdId, 'prd-queued-002');

  const fallback = resolveSelectedQueuedPrdState([
    { id: 'prd-queued-003' },
    { id: 'prd-queued-004' },
  ], 'prd-queued-002');
  assert.equal(fallback.selectedPrdId, 'prd-queued-003');

  const empty = resolveSelectedQueuedPrdState([], 'prd-queued-004');
  assert.equal(empty.selectedPrdId, '');
});

test('queued PRD detail renders structured fields from the dashboard payload', async () => {
  installBrowserStubs();
  const { QueuedPrdDetail } = await import(`../../src/server/control-plane/control-plane-client.js?queued-detail=${Date.now()}`);

  const html = renderToHtml(h(QueuedPrdDetail as any, {
    prd: {
      id: 'prd-queued-001',
      title: 'Queued detail PRD',
      status: 'queued',
      stateLabel: 'Waiting in queue',
      problem: 'Queued work should be selectable in Main.',
      specification: 'Render a dedicated in-place detail panel.',
      requirements: ['Use existing dashboard data'],
      acceptanceCriteria: ['Selecting another queued PRD updates the detail panel'],
      verification: ['Run focused UI tests'],
      createdAt: '2026-04-26T10:00:00.000Z',
      updatedAt: '2026-04-26T10:05:00.000Z',
      sourceChat: {
        repoId: 'alpha',
        conversationId: 'chat-1',
        managerMessageId: 'msg-manager',
        agentMessageId: 'msg-agent',
        createdAt: '2026-04-26T09:55:00.000Z',
      },
    },
  }));

  assert.match(html, /Queued detail PRD/);
  assert.match(html, /prd-queued-001/);
  assert.match(html, /Waiting in queue/);
  assert.match(html, /Queued work should be selectable in Main\./);
  assert.match(html, /Render a dedicated in-place detail panel\./);
  assert.match(html, /Use existing dashboard data/);
  assert.match(html, /Selecting another queued PRD updates the detail panel/);
  assert.match(html, /Run focused UI tests/);
  assert.match(html, /Conversation chat-1/);
});

test('queued PRD components show clear empty states when no queue entries remain', async () => {
  installBrowserStubs();
  const { QueuedPrdList, QueuedPrdDetail } = await import(`../../src/server/control-plane/control-plane-client.js?queued-empty=${Date.now()}`);

  const listHtml = renderToHtml(h(QueuedPrdList as any, {
    queuedPrds: [],
    selectedPrdId: '',
  }));
  const detailHtml = renderToHtml(h(QueuedPrdDetail as any, {
    prd: null,
  }));

  assert.match(listHtml, /No queued PRDs\./);
  assert.match(detailHtml, /No queued PRDs right now\./);
});

function installBrowserStubs() {
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    __AUTONOMY_CONTROL_PLANE_API_BASE_URL__: '',
    __AUTONOMY_CONTROL_PLANE_DEV_TOKEN__: '',
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  };
  (globalThis as any).document = {
    body: {
      dataset: {
        controlPlaneEntrance: 'project',
        controlPlaneRepoId: 'alpha',
      },
    },
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
}
