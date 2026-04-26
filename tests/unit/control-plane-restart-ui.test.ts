import test from 'node:test';
import assert from 'node:assert/strict';

import { h, renderToHtml } from '../../src/server/control-plane/control-plane-jsx-runtime/jsx-runtime.js';

test('manager and project restart views render successful, skipped, and failed evidence', async () => {
  installBrowserStubs();
  const client = await import('../../src/server/control-plane/control-plane-client.js');

  const successHtml = renderToHtml(h(client.ProjectRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      restartJob: {
        status: 'completed',
        statusLabel: 'Restart recorded',
        detail: 'restart restarted | server pid 123 -> 456, bridge pid 789 -> 812',
        restartEvidence: {
          status: 'restarted',
          statusLabel: 'Restarted',
          completedAt: '2026-04-22T01:06:30.000Z',
          targets: [
            {
              target: 'server',
              label: 'server',
              status: 'restarted',
              statusLabel: 'Restarted',
              modeLabel: 'default',
              preRestartPid: 123,
              postRestartPid: 456,
              recordedAt: '2026-04-22T01:00:00.000Z',
              completedAt: '2026-04-22T01:06:10.000Z',
              pidChanged: true,
              compactLabel: 'server pid 123 -> 456',
            },
            {
              target: 'controlBridge',
              label: 'bridge',
              status: 'restarted',
              statusLabel: 'Restarted',
              modeLabel: 'default',
              preRestartPid: 789,
              postRestartPid: 812,
              recordedAt: '2026-04-22T01:00:01.000Z',
              completedAt: '2026-04-22T01:06:20.000Z',
              pidChanged: true,
              compactLabel: 'bridge pid 789 -> 812',
            },
          ],
        },
      },
    },
  }));

  assert.match(successHtml, /Restart Evidence/);
  assert.match(successHtml, /server pid 123 -&gt; 456/);
  assert.match(successHtml, /bridge pid 789 -&gt; 812/);
  assert.match(successHtml, /Heartbeat unavailable/);
  assert.match(successHtml, /pid changed/);

  const skippedHtml = renderToHtml(h(client.ProjectRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      restartJob: {
        status: 'completed',
        statusLabel: 'Restart recorded',
        detail: 'restart skipped',
        restartEvidence: {
          status: 'skipped',
          statusLabel: 'Skipped',
          completedAt: '2026-04-22T01:07:00.000Z',
          targets: [
            {
              target: 'server',
              label: 'server',
              status: 'skipped',
              statusLabel: 'Skipped',
              reason: 'missing-metadata',
              reasonLabel: 'missing metadata',
              modeLabel: 'default',
              recordedAt: null,
              completedAt: '2026-04-22T01:07:00.000Z',
              pidChanged: null,
              compactLabel: 'server skipped (missing metadata) | pid missing',
            },
          ],
        },
      },
    },
  }));

  assert.match(skippedHtml, /missing metadata/);
  assert.match(skippedHtml, /pid missing/);

  const failedManagerHtml = renderToHtml(h(client.ManagerRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      restartJob: {
        status: 'completed',
        statusLabel: 'Restart recorded',
        detail: 'restart failed',
        restartEvidence: {
          status: 'failed',
          statusLabel: 'Failed',
          completedAt: '2026-04-22T01:08:00.000Z',
          compactSummary: 'server failed (stale pid) | pid 222, bridge relaunch failed | pid 333',
          allTargetsRelaunched: false,
          allTargetsChangedPid: false,
          targets: [
            {
              target: 'server',
              label: 'server',
              status: 'failed',
              statusLabel: 'Failed',
              reason: 'stale-pid',
              reasonLabel: 'stale pid',
              preRestartPid: 222,
              postRestartPid: null,
              pidChanged: null,
              compactLabel: 'server failed (stale pid) | pid 222',
            },
            {
              target: 'controlBridge',
              label: 'bridge',
              status: 'relaunch-failed',
              statusLabel: 'Relaunch failed',
              reason: 'early-exit',
              reasonLabel: 'early exit',
              preRestartPid: 333,
              postRestartPid: 334,
              pidChanged: true,
              compactLabel: 'bridge relaunch failed (early exit) | pid 333',
            },
          ],
        },
      },
    },
  }));

  assert.match(failedManagerHtml, /Restart/);
  assert.match(failedManagerHtml, /0\/2 targets relaunched/);
  assert.match(failedManagerHtml, /server failed \(stale pid\) \| pid 222/);
});

test('manager repo card renders reset controls and reset job state for active PRDs', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?reset=${Date.now()}`);

  const html = renderToHtml(h(client.ManagerRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      activePrd: {
        id: 'prd-reset-001',
        title: 'Resettable PRD',
        stateLabel: 'In progress',
        detail: '2 tasks remaining',
      },
      prdResetJob: {
        status: 'queued',
        statusLabel: 'Queued',
        detail: 'Waiting for bridge claim',
      },
      prdHistory: [],
    },
  }));

  assert.match(html, /Resettable PRD/);
  assert.match(html, /data-action="reset-prds"/);
  assert.match(html, /Reset queued/);
  assert.match(html, /Latest reset job: Queued/);
  assert.match(html, /Waiting for bridge claim/);
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
    getElementById: (id: string) => {
      if (id === 'control-plane-heartbeats') {
        return {
          innerHTML: '',
        };
      }
      return null;
    },
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
}
