import test from 'node:test';
import assert from 'node:assert/strict';

test('project advanced debug payloads stay empty until disclosure opens and clear again when it closes', async () => {
  const rawContentEl = createElementStub();
  const advancedDisclosureEl = createDetailsStub();

  installBrowserStubs({
    'advanced-debug-disclosure': advancedDisclosureEl,
    'advanced-debug-content': rawContentEl,
    'last-updated': createElementStub(),
    'dashboard-repos': createElementStub(),
    'dashboard-summary-note': createElementStub(),
    'control-plane-heartbeats': createElementStub(),
  });

  const client = await import(`../../src/server/control-plane/control-plane-client.js?advanced-ui=${Date.now()}`);
  const state = {
    dashboard: {
      repoCount: 1,
      repos: [{ repoId: 'alpha', label: 'Alpha' }],
      jobs: [],
    },
    jobs: [{ id: 'job-1', status: 'queued' }],
  };

  client.renderAdvanced(state as any);
  assert.equal(rawContentEl.innerHTML, '');

  advancedDisclosureEl.open = true;
  advancedDisclosureEl.dispatch('toggle');
  assert.match(rawContentEl.innerHTML, /State JSON/);
  assert.match(rawContentEl.innerHTML, /Dashboard JSON/);
  assert.match(rawContentEl.innerHTML, /Jobs JSON/);
  assert.match(rawContentEl.innerHTML, /Repo status JSON/);
  assert.match(rawContentEl.innerHTML, /repoCount/);
  assert.match(rawContentEl.innerHTML, /alpha/);

  rawContentEl.innerHTML = 'stale';
  advancedDisclosureEl.open = false;
  advancedDisclosureEl.dispatch('toggle');
  assert.equal(rawContentEl.innerHTML, '');

  client.renderAdvanced({
    dashboard: {
      repoCount: 2,
    },
    jobs: [{ id: 'job-2', status: 'completed' }],
  } as any);
  assert.equal(rawContentEl.innerHTML, '');
});

function installBrowserStubs(elements: Record<string, any>) {
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    __AUTONOMY_CONTROL_PLANE_API_BASE_URL__: '',
    __AUTONOMY_CONTROL_PLANE_DEV_TOKEN__: '',
    setInterval: () => 0,
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
    getElementById: (id: string) => elements[id] || null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
  (globalThis as any).fetch = async (url: string) => ({
    ok: true,
    status: 200,
    async json() {
      if (String(url).includes('/api/repos')) {
        return {
          repos: [{ repoId: 'alpha', label: 'Alpha' }],
        };
      }
      return {
        dashboard: {
          repoCount: 1,
          repos: [{ repoId: 'alpha', label: 'Alpha' }],
          jobs: [],
        },
        jobs: [],
      };
    },
  });
}

function createElementStub() {
  return {
    innerHTML: '',
    textContent: '',
    addEventListener: () => undefined,
  };
}

function createDetailsStub() {
  const listeners = new Map<string, Array<() => void>>();
  return {
    open: false,
    addEventListener(event: string, handler: () => void) {
      const current = listeners.get(event) || [];
      current.push(handler);
      listeners.set(event, current);
    },
    dispatch(event: string) {
      for (const handler of listeners.get(event) || []) {
        handler();
      }
    },
  };
}
