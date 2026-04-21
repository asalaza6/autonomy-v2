import test from 'node:test';
import assert from 'node:assert/strict';

import { h, renderToHtml } from '../../src/server/control-plane/control-plane-jsx-runtime/jsx-runtime.js';

test('package controls render distinct update and restart actions', async () => {
  installBrowserStubs();
  const { PackageUpdateButton } = await import('../../src/server/control-plane/control-plane-client.js');

  const html = renderToHtml(h(PackageUpdateButton as any, {
    repo: {
      repoId: 'alpha',
      packageUpdateJob: null,
      restartJob: null,
    },
  }));

  assert.match(html, /data-action="package-update"/);
  assert.match(html, /data-action="restart"/);
  assert.match(html, /Update package/);
  assert.match(html, /Restart services/);
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
