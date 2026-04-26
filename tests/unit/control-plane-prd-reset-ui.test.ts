import test from 'node:test';
import assert from 'node:assert/strict';

test('history refresh prefers the newly reset PRD once it reaches history', async () => {
  installBrowserStubs();
  const { resolveSelectedHistoryState } = await import(`../../src/server/control-plane/control-plane-client.js?history=${Date.now()}`);

  const queuedSelection = resolveSelectedHistoryState([
    { id: 'prd-older-001' },
  ], 'prd-older-001', 'prd-reset-001');
  assert.equal(queuedSelection.selectedPrdId, 'prd-older-001');
  assert.equal(queuedSelection.preferredPrdId, 'prd-reset-001');

  const completedSelection = resolveSelectedHistoryState([
    { id: 'prd-reset-001' },
    { id: 'prd-older-001' },
  ], queuedSelection.selectedPrdId, queuedSelection.preferredPrdId);
  assert.equal(completedSelection.selectedPrdId, 'prd-reset-001');
  assert.equal(completedSelection.preferredPrdId, '');
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
