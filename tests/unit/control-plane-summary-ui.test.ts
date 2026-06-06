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

test('manager repo card shows deploy action for aligned manageable repos', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?manager-aligned-deploy=${Date.now()}`);

  const html = renderToHtml(h(client.ManagerRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      controlAccess: {
        canManage: true,
      },
      deployment: {
        sourceBranch: 'dev',
        targetBranch: 'main',
        branchesAligned: true,
        hasChanges: false,
        deployable: false,
        status: 'online',
        statusLabel: 'Branches aligned',
        detail: 'dev and main are aligned',
      },
    },
  }));

  assert.match(html, /data-action="deploy"/);
  assert.match(html, /data-repo-id="alpha"/);
  assert.match(html, /Deploy dev to main/);
  assert.doesNotMatch(html, /disabled/);
});

test('manager repo card reuses deploy queued state', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?manager-queued-deploy=${Date.now()}`);

  const html = renderToHtml(h(client.ManagerRepoCard as any, {
    repo: {
      repoId: 'alpha',
      label: 'Alpha',
      controlAccess: {
        canManage: true,
      },
      deployment: {
        sourceBranch: 'dev',
        targetBranch: 'main',
        branchesAligned: true,
        hasChanges: false,
        deployable: false,
      },
      deployJob: {
        status: 'queued',
        statusLabel: 'Queued',
      },
    },
  }));

  assert.match(html, /data-action="deploy"/);
  assert.match(html, /Deploy queued/);
  assert.match(html, /disabled/);
});

test('project deploy actions stay hidden for aligned repos without pending changes', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?project-aligned-deploy=${Date.now()}`);
  const repo = {
    repoId: 'alpha',
    label: 'Alpha',
    queuedPrds: [],
    deployment: {
      sourceBranch: 'dev',
      targetBranch: 'main',
      branchesAligned: true,
      hasChanges: false,
      deployable: false,
      status: 'online',
      statusLabel: 'Branches aligned',
      detail: 'dev and main are aligned',
    },
    deploymentUrl: 'https://example.test/alpha',
  };

  const projectCardHtml = renderToHtml(h(client.ProjectRepoCard as any, { repo }));
  const projectMainHtml = renderToHtml(h(client.ProjectMainDeployActions as any, { repo }));

  assert.match(projectMainHtml, /Deployment site/);
  assert.doesNotMatch(projectCardHtml, /data-action="deploy"/);
  assert.doesNotMatch(projectCardHtml, /Deploy dev to main/);
  assert.doesNotMatch(projectMainHtml, /data-action="deploy"/);
  assert.doesNotMatch(projectMainHtml, /Deploy dev to main/);
});

test('project shell exposes a dedicated agents tab and panel', async () => {
  const page = await import(`../../src/server/control-plane/control-plane-page.js?project-agents-tab=${Date.now()}`);

  const html = renderToHtml(h(page.ControlPlanePage as any, {
    entrance: 'project',
    repoId: 'alpha',
  }));

  assert.match(html, /data-tab="agents"/);
  assert.match(html, />Agents</);
  assert.match(html, /id="agents-panel"/);
  assert.match(html, /id="agents-panel-content"/);
});

test('project repo card hides operational diagnostics behind labeled disclosures', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?project-summary=${Date.now()}`);
  client.setLiveProcessPanelTestState({
    outputs: {},
  });

  const repo = {
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
      customAgents: [
        {
          runtimeKey: 'feedback-bot:project',
          agentId: 'feedback-bot',
          kind: 'feedback-bots',
          configSource: 'prompts/autonomous/v2/config/feedback-bots.json',
          enabled: false,
          enabledSource: 'runtime',
          defaultEnabled: true,
          status: 'disabled',
          target: { type: 'project', id: 'alpha' },
          workspacePath: '/tmp/alpha/.autonomy/custom/feedback',
          intervalSeconds: 60,
          lastDecision: 'disabled',
          lastDecisionReason: 'agent disabled by control-plane override',
          tools: {
            autonomy: {
              envPresent: true,
            },
          },
        },
      ],
    };
  const html = renderToHtml(h(client.ProjectRepoCard as any, { repo }));
  const agentsHtml = renderToHtml(h(client.ProjectAgentsPanel as any, { repo }));

  assert.match(html, /Current Work/);
  assert.match(html, /Open pull request #42/);
  assert.match(html, /Operational diagnostics and controls/);
  assert.match(html, /Work coordination details/);
  assert.match(html, /Live server process/);
  assert.match(html, /GitHub repo access denied/);
  assert.match(html, /Update package/);
  assert.match(html, /Restart failed/);
  assert.doesNotMatch(html, /Custom Agents/);
  assert.doesNotMatch(html, /feedback-bot/);
  assert.match(agentsHtml, /Custom Agents/);
  assert.match(agentsHtml, /Packaged Agents/);
  assert.match(agentsHtml, /feedback-bot/);
  assert.match(agentsHtml, /architecture-agent/);
  assert.match(agentsHtml, /enabled from UI override/);
  assert.match(agentsHtml, /data-action="custom-agent-toggle"/);
  assert.match(agentsHtml, /data-runtime-key="feedback-bot:project"/);
  assert.match(agentsHtml, />Enable</);
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
