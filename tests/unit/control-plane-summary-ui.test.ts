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
      description: 'Primary customer repo',
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
      deploymentUrl: 'https://alpha.example.com',
      deploymentLabel: 'Production site',
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

  assert.match(html, /Alpha/);
  assert.match(html, /alpha · Primary customer repo/);
  assert.match(html, /Open repo control page/);
  assert.match(html, /Production site/);
  assert.match(html, /<details class=\"repo-disclosure\" data-repo-disclosure-key=\"manager:alpha:repo-status-details\">/);
  assert.match(html, /Repo status and details/);
  assert.match(html, /Current work/);
  assert.match(html, /Compact summary PRD/);
  assert.match(html, /33% complete/);
  assert.match(html, /Implementation is running: 1\/3 tasks complete\./);
  assert.match(html, /Deploy available/);
  assert.match(html, /dev is 2 commits ahead of main/);
  assert.match(html, /GitHub validation failed/);
  assert.match(html, /PR drift/);
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

test('manager repo disclosure state persists across refresh re-renders and stays isolated per repo', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?manager-refresh=${Date.now()}`);
  const disclosureKey = client.buildRepoDisclosurePersistenceKey('manager', 'alpha', 'repo-status-details');
  const otherRepoDisclosureKey = client.buildRepoDisclosurePersistenceKey('manager', 'beta', 'repo-status-details');

  let html = renderToHtml(h(client.ManagerRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      updatedAt: '2026-04-26T10:10:00.000Z',
      activePrd: {
        id: 'prd-active-001',
        title: 'Original PRD',
        stateLabel: 'In progress',
        detail: '2 tasks remaining',
      },
    },
  }));
  assert.doesNotMatch(html, /<details class=\"repo-disclosure\"[^>]* open(?:=\"\")?>/);

  client.persistRepoDisclosureOpenState(disclosureKey, true);
  html = renderToHtml(h(client.ManagerRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      updatedAt: '2026-04-27T10:10:00.000Z',
      activePrd: {
        id: 'prd-active-002',
        title: 'Updated PRD',
        stateLabel: 'Review active',
        detail: 'Waiting on review',
      },
    },
  }));
  assert.match(html, /<details class=\"repo-disclosure\" data-repo-disclosure-key=\"manager:alpha:repo-status-details\" open>/);
  assert.match(html, /Updated PRD/);
  assert.equal(client.resolveRepoDisclosureOpenState(disclosureKey), true);
  assert.equal(client.resolveRepoDisclosureOpenState(otherRepoDisclosureKey), false);

  client.persistRepoDisclosureOpenState(disclosureKey, false);
  html = renderToHtml(h(client.ManagerRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      updatedAt: '2026-04-28T10:10:00.000Z',
      activePrd: {
        id: 'prd-active-003',
        title: 'Closed PRD',
        stateLabel: 'Queued',
        detail: 'Ready to start',
      },
    },
  }));
  assert.doesNotMatch(html, /data-repo-disclosure-key=\"manager:alpha:repo-status-details\" open/);
});

test('project repo disclosures persist across refresh re-renders and stay isolated by view and repo', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?project-refresh=${Date.now()}`);
  client.setLiveProcessPanelTestState({
    outputs: {},
  });

  const workDisclosureKey = client.buildRepoDisclosurePersistenceKey('project', 'alpha', 'work-coordination-details');
  const diagnosticsDisclosureKey = client.buildRepoDisclosurePersistenceKey('project', 'alpha', 'operational-diagnostics-controls');
  const managerDisclosureKey = client.buildRepoDisclosurePersistenceKey('manager', 'alpha', 'repo-status-details');
  const otherRepoWorkDisclosureKey = client.buildRepoDisclosurePersistenceKey('project', 'beta', 'work-coordination-details');

  client.persistRepoDisclosureOpenState(workDisclosureKey, true);
  client.persistRepoDisclosureOpenState(diagnosticsDisclosureKey, false);

  const html = renderToHtml(h(client.ProjectRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      updatedAt: '2026-04-28T10:10:00.000Z',
      activePrd: {
        id: 'prd-active-010',
        title: 'Refresh PRD',
        stateLabel: 'In progress',
        detail: 'Still running',
      },
      prdRun: {
        currentStepId: 'implementing',
        currentStepLabel: 'Implementing',
        detail: 'Implementation is running: 2/4 tasks complete.',
      },
      agentStatuses: [
        {
          agentId: 'architecture-agent',
          role: 'implementation',
          workerStatus: 'running',
          detail: 'Carrying disclosure state through refresh',
        },
      ],
      pullRequestStatuses: [
        {
          prdId: 'prd-active-010',
          number: 43,
          title: 'Refresh PR',
          url: 'https://github.com/asalaza6/autonomy-v2/pull/43',
          status: 'open',
          statusLabel: 'review active',
          updatedAt: '2026-04-28T10:10:00.000Z',
        },
      ],
      repoAssistant: {
        github: {
          available: true,
          statusLabel: 'GitHub access ready',
        },
      },
      managedProcesses: {
        server: {
          target: 'server',
          pid: 789,
          running: true,
          command: 'npm run dev',
          cwd: '/tmp/alpha',
        },
      },
    },
  }));

  assert.match(html, /data-repo-disclosure-key=\"project:alpha:work-coordination-details\" open/);
  assert.doesNotMatch(html, /data-repo-disclosure-key=\"project:alpha:operational-diagnostics-controls\" open/);
  assert.equal(client.resolveRepoDisclosureOpenState(workDisclosureKey), true);
  assert.equal(client.resolveRepoDisclosureOpenState(diagnosticsDisclosureKey), false);
  assert.equal(client.resolveRepoDisclosureOpenState(managerDisclosureKey), false);
  assert.equal(client.resolveRepoDisclosureOpenState(otherRepoWorkDisclosureKey), false);
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
