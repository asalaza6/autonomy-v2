import test from 'node:test';
import assert from 'node:assert/strict';

import { h, renderToHtml } from '../../src/server/control-plane/control-plane-jsx-runtime/jsx-runtime.js';

test('manager repo card renders a compact summary with attention signals and control-page link', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?manager-summary=${Date.now()}`);

  const html = renderToHtml(h(client.ManagerRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      freshnessStatus: 'stale',
      freshnessStatusLabel: 'Stale',
      updatedAt: '2026-04-26T10:10:00.000Z',
      activePrd: {
        id: 'prd-active-001',
        title: 'Compact summary PRD',
        stateLabel: 'In progress',
        detail: '2 tasks remaining',
        completedTaskCount: 1,
        remainingTaskCount: 2,
        progressPercent: 33,
      },
      prdRun: {
        currentStepId: 'implementing',
        currentStepLabel: 'Implementing',
        detail: 'Implementation is running: 1/3 tasks complete.',
      },
      deployment: {
        hasChanges: true,
        deployable: true,
        status: 'pending',
        statusLabel: 'Deploy available',
        detail: 'dev is 2 commits ahead of main',
      },
      repoAssistant: {
        github: {
          available: false,
          statusLabel: 'GitHub repo access denied',
        },
      },
      pullRequestStatuses: [
        {
          statusLabel: 'Blocked from merge',
          mergeBlockedReason: 'state drift: local review state mismatches GitHub',
        },
      ],
    },
  }));

  assert.match(html, /Current work/);
  assert.match(html, /Compact summary PRD/);
  assert.match(html, /33% complete/);
  assert.match(html, /GitHub validation failed/);
  assert.match(html, /Deploy available/);
  assert.match(html, /PR drift/);
  assert.match(html, /Open repo control page/);
  assert.doesNotMatch(html, /Live Process/);
  assert.doesNotMatch(html, /Autonomy v2/);
});

test('project repo card hides operational diagnostics behind labeled disclosures', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?project-summary=${Date.now()}`);
  client.setLiveProcessPanelTestState({
    outputs: {},
  });

  const html = renderToHtml(h(client.ProjectRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      activePrd: {
        id: 'prd-active-001',
        title: 'Current work PRD',
        stateLabel: 'In progress',
        detail: '1 task remaining',
        plannedTaskCount: 2,
        completedTaskCount: 1,
        remainingTaskCount: 1,
        progressPercent: 50,
      },
      prdRun: {
        currentStepId: 'implementing',
        currentStepLabel: 'Implementing',
        detail: 'Implementation is running: 1/2 tasks complete.',
      },
      queuedPrds: [],
      deployment: {
        hasChanges: true,
        deployable: true,
        status: 'pending',
        statusLabel: 'Deploy available',
        detail: 'dev is ahead of main',
        sourceBranch: 'dev',
        targetBranch: 'main',
      },
      repoAssistant: {
        github: {
          available: false,
          statusLabel: 'GitHub repo access denied',
          detail: 'Token is missing repo scope.',
        },
      },
      packageStatus: {
        installedVersion: '1.0.0',
        packageName: '@asalaza6/autonomy-v2',
        detail: 'declared ^1.0.0 | npm',
      },
      restartJob: {
        status: 'completed',
        statusLabel: 'Restart recorded',
        detail: 'restart failed',
        restartEvidence: {
          status: 'failed',
          statusLabel: 'Failed',
          compactSummary: 'server failed (stale pid) | pid 222',
          targets: [],
        },
      },
      managedProcesses: {
        server: {
          target: 'server',
          pid: 456,
          running: true,
          command: 'npm run dev',
          cwd: '/tmp/alpha',
        },
      },
      pullRequestStatuses: [
        {
          prdId: 'prd-active-001',
          number: 42,
          title: 'Current work PR',
          url: 'https://github.com/asalaza6/autonomy-v2/pull/42',
          status: 'open',
          statusLabel: 'review active',
          updatedAt: '2026-04-26T10:10:00.000Z',
        },
      ],
      agentStatuses: [
        {
          agentId: 'architecture-agent',
          role: 'implementation',
          workerStatus: 'running',
          detail: 'Building the compact summary UI',
        },
      ],
    },
  }));

  assert.match(html, /Current Work/);
  assert.match(html, /Open pull request #42/);
  assert.match(html, /Operational diagnostics and controls/);
  assert.match(html, /Work coordination details/);
  assert.match(html, /Live server process/);
  assert.match(html, /GitHub repo access denied/);
  assert.match(html, /Update package/);
  assert.match(html, /Restart failed/);
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
