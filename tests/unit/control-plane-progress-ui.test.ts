import test from 'node:test';
import assert from 'node:assert/strict';

import { h, renderToHtml } from '../../src/server/control-plane/control-plane-jsx-runtime/jsx-runtime.js';

test('project progress renders an active pull request link during implementation and review states', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?progress=${Date.now()}`);

  const progress = client.resolveProjectProgress({
    repoId: 'alpha',
    activePrd: {
      id: 'prd-progress-001',
      title: 'Progress PRD',
      status: 'planned',
      stateLabel: 'In progress',
      plannedTaskCount: 2,
      completedTaskCount: 2,
      remainingTaskCount: 0,
      progressPercent: 100,
    },
    prdRun: {
      currentStepId: 'reviewing',
      currentStepLabel: 'Reviewing',
      detail: 'Review is active on 1 pull request.',
    },
    pullRequestStatuses: [
      {
        prId: 'pr-prd-progress-001-architecture-agent',
        prdId: 'prd-progress-001',
        number: 42,
        status: 'open',
        statusLabel: 'review active',
        updatedAt: '2026-04-26T10:10:00.000Z',
        url: 'https://github.com/asalaza6/autonomy-v2/pull/42',
      },
    ],
  });

  assert.equal(progress.title, 'Progress PRD');
  assert.equal(progress.stats, '2 complete · 0 remaining');
  assert.equal(progress.percent, 100);

  const html = renderToHtml(h(client.ProjectMainProgressActions as any, { progress }));
  assert.match(html, /https:\/\/github\.com\/asalaza6\/autonomy-v2\/pull\/42/);
  assert.match(html, /Open pull request #42/);
});

test('project progress hides the pull request link when the active PRD is not implementing or reviewing', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?planning=${Date.now()}`);

  const progress = client.resolveProjectProgress({
    repoId: 'alpha',
    activePrd: {
      id: 'prd-planning-001',
      title: 'Planning PRD',
      status: 'planning',
      stateLabel: 'Planning',
      plannedTaskCount: 0,
      completedTaskCount: 0,
    },
    prdRun: {
      currentStepId: 'planning',
      currentStepLabel: 'Planning',
      detail: 'Planning is turning the PRD into implementation tasks.',
    },
    pullRequestStatuses: [
      {
        prId: 'pr-prd-planning-001-architecture-agent',
        prdId: 'prd-planning-001',
        number: 7,
        status: 'open',
        statusLabel: 'review active',
        updatedAt: '2026-04-26T10:10:00.000Z',
        url: 'https://github.com/asalaza6/autonomy-v2/pull/7',
      },
    ],
  });

  assert.equal(renderToHtml(h(client.ProjectMainProgressActions as any, { progress })), '');
});

test('project progress hides the pull request link when no valid URL is available', async () => {
  installBrowserStubs();
  const client = await import(`../../src/server/control-plane/control-plane-client.js?invalid-url=${Date.now()}`);

  const progress = client.resolveProjectProgress({
    repoId: 'alpha',
    activePrd: {
      id: 'prd-implementing-001',
      title: 'Implementing PRD',
      status: 'planned',
      stateLabel: 'In progress',
      plannedTaskCount: 3,
      completedTaskCount: 1,
      remainingTaskCount: 2,
      progressPercent: 33,
    },
    prdRun: {
      currentStepId: 'implementing',
      currentStepLabel: 'Implementing',
      detail: 'Implementation is running: 1/3 tasks complete.',
    },
    pullRequestStatuses: [
      {
        prId: 'pr-prd-implementing-001-architecture-agent',
        prdId: 'prd-implementing-001',
        status: 'open',
        statusLabel: 'review active',
        updatedAt: '2026-04-26T10:10:00.000Z',
        url: 'github.com/asalaza6/autonomy-v2/pull/99',
      },
    ],
  });

  assert.equal(progress.stats, '1 complete · 2 remaining');
  assert.equal(renderToHtml(h(client.ProjectMainProgressActions as any, { progress })), '');
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
