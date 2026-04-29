import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildStatusSnapshot } from '../../src/autonomy-v2/control-plane/status-service.js';
import { selectActivePullRequestStatusForPrd } from '../../src/autonomy-v2/control-plane/status-view.js';
import { buildControlPlaneDashboard } from '../../src/server/control-plane/control-plane-dashboard.js';
import { resolveRepoAssistantGithubCapability } from '../../src/server/control-plane/control-plane-github.js';
import { setManagedProcess } from '../../src/server/control-plane/control-plane-store.js';
import {
  addPrdWithTasks,
  CLI_BIN,
  createFixtureRepo,
  getAutonomyPathsForTest,
  git,
  initAutonomyRepo,
  runNode,
} from '../smoke/package-smoke.helpers.js';

test('status snapshots include the current runtime and PRD state', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-fixture-');
  initAutonomyRepo(repoDir);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-status-001',
    '--title',
    'Status snapshot PRD',
    '--specification',
    'Validate the control plane status snapshot.',
  ]);

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.integrationBranch, 'dev');
  assert.equal(snapshot.prds.prds.length, 1);
  assert.equal(snapshot.prds.prds[0].id, 'prd-status-001');
  assert.equal(Array.isArray(snapshot.agentStatuses), true);
  assert.equal(snapshot.queues.length > 0, true);

  const output = runNode(CLI_BIN, [
    'status',
    '--root',
    repoDir,
  ]);
  assert.match(output, /PRDs:/);
  assert.match(output, /Active PRD:/);
});

test('status snapshots do not perform live GitHub validation during repeated refreshes', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-github-lightweight-');
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  initAutonomyRepo(repoDir);
  git(repoDir, ['remote', 'add', 'origin', 'https://github.com/asalaza6/autonomy-v2.git']);

  process.env.GITHUB_TOKEN = 'status-refresh-token';
  delete process.env.GH_TOKEN;

  try {
    const firstSnapshot = buildStatusSnapshot(repoDir);
    const secondSnapshot = buildStatusSnapshot(repoDir);

    assert.equal(firstSnapshot.repoAssistant.github.available, false);
    assert.equal(firstSnapshot.repoAssistant.github.status, 'validation-pending');
    assert.equal(secondSnapshot.repoAssistant.github.available, false);
    assert.equal(secondSnapshot.repoAssistant.github.status, 'validation-pending');
    assert.deepEqual(secondSnapshot.repoAssistant.github.repository, {
      owner: 'asalaza6',
      repo: 'autonomy-v2',
    });
  } finally {
    if (typeof originalGithubToken === 'string') {
      process.env.GITHUB_TOKEN = originalGithubToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    if (typeof originalGhToken === 'string') {
      process.env.GH_TOKEN = originalGhToken;
    } else {
      delete process.env.GH_TOKEN;
    }
  }
});

test('status snapshots surface configured validation pull request overrides and cached validation state', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-github-configured-');
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  initAutonomyRepo(repoDir);
  git(repoDir, ['remote', 'add', 'origin', 'https://github.com/example/repo.git']);

  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify({
    schemaVersion: 1,
    repoId: 'default',
    label: 'Current workspace',
    description: 'Allowed PRD target for the control plane.',
    repoAssistantValidationPullRequest: 91,
  }, null, 2)}\n`, 'utf8');

  process.env.GITHUB_TOKEN = 'configured-status-token';
  delete process.env.GH_TOKEN;

  try {
    const pendingSnapshot = buildStatusSnapshot(repoDir);
    assert.equal(pendingSnapshot.repoAssistant.github.status, 'validation-pending');
    assert.equal(pendingSnapshot.repoAssistant.github.validation.pullRequestNumber, 91);
    assert.equal(pendingSnapshot.repoAssistant.github.validation.pullRequestSource, 'config');

    resolveRepoAssistantGithubCapability(repoDir, {
      repository: {
        owner: 'example',
        repo: 'repo',
      },
      configuredValidationPullNumber: 91,
      githubApiRunner(args) {
        if (args[0] === 'repos/example/repo') {
          return JSON.stringify({
            private: false,
            visibility: 'public',
            default_branch: 'dev',
          });
        }
        if (args[0] === 'repos/example/repo/pulls/91') {
          return JSON.stringify({
            number: 91,
            title: 'Configured validation',
            state: 'open',
            html_url: 'https://github.com/example/repo/pull/91',
            user: { login: 'example' },
            base: { ref: 'dev' },
            head: { ref: 'feature/repo-assistant' },
          });
        }
        if (args[0].includes('/files?per_page=100') || args[0].includes('/comments?per_page=100') || args[0].includes('/reviews?per_page=100')) {
          return '[]';
        }
        if (args[0] === 'graphql') {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [],
                  },
                },
              },
            },
          });
        }
        throw new Error(`Unexpected route: ${args[0]}`);
      },
    });

    const validatedSnapshot = buildStatusSnapshot(repoDir);
    assert.equal(validatedSnapshot.repoAssistant.github.available, true);
    assert.equal(validatedSnapshot.repoAssistant.github.status, 'enabled');
    assert.equal(validatedSnapshot.repoAssistant.github.validation.pullRequestNumber, 91);
    assert.equal(validatedSnapshot.repoAssistant.github.validation.pullRequestSource, 'config');
  } finally {
    if (typeof originalGithubToken === 'string') {
      process.env.GITHUB_TOKEN = originalGithubToken;
    } else {
      delete process.env.GITHUB_TOKEN;
    }
    if (typeof originalGhToken === 'string') {
      process.env.GH_TOKEN = originalGhToken;
    } else {
      delete process.env.GH_TOKEN;
    }
  }
});

test('status snapshots and CLI surface the latest automatic queued PRD promotion', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-promotion-');
  initAutonomyRepo(repoDir);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-promoted-001',
    '--title',
    'Promoted PRD',
    '--specification',
    'Show the latest queue promotion in status output.',
  ]);

  const runtimePath = path.join(repoDir, '.autonomy', 'runtime', 'state', 'runtime.json');
  fs.writeFileSync(runtimePath, `${JSON.stringify({
    workers: {},
    lastPrdPromotion: {
      id: 'prd-promoted-001',
      title: 'Promoted PRD',
      source: 'prompts/autonomous/v2/specs/prds/queue/prd-promoted-001.json',
      destination: 'prompts/autonomous/v2/specs/prds/prd-promoted-001.json',
      promotedAt: '2026-04-26T08:20:00.000Z',
      trigger: 'automatic-queue-promotion',
    },
  }, null, 2)}\n`, 'utf8');

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.runtime.lastPrdPromotion.id, 'prd-promoted-001');
  assert.equal(snapshot.runtime.lastPrdPromotion.title, 'Promoted PRD');

  const output = runNode(CLI_BIN, [
    'status',
    '--root',
    repoDir,
  ]);
  assert.match(output, /Last auto-promotion: Promoted PRD/);
});

test('status snapshots include installed autonomy package version separately from deploy version', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-package-version-');
  initAutonomyRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({
    name: 'package-version-fixture',
    private: true,
    optionalDependencies: {
      '@asalaza6/autonomy-v2': '^1.4.44',
    },
  }, null, 2)}\n`, 'utf8');
  const installedManifestPath = path.join(repoDir, 'node_modules', '@asalaza6', 'autonomy-v2', 'package.json');
  fs.mkdirSync(path.dirname(installedManifestPath), { recursive: true });
  fs.writeFileSync(installedManifestPath, `${JSON.stringify({
    name: '@asalaza6/autonomy-v2',
    version: '1.4.45',
  }, null, 2)}\n`, 'utf8');

  const snapshot = buildStatusSnapshot(repoDir);

  assert.equal(snapshot.autonomyPackage.packageName, '@asalaza6/autonomy-v2');
  assert.equal(snapshot.autonomyPackage.declaredVersion, '^1.4.44');
  assert.equal(snapshot.autonomyPackage.installedVersion, '1.4.45');
  assert.equal(snapshot.deployment.version.packageVersion, null);
});

test('status snapshots include archived PRDs for project history', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-history-');
  initAutonomyRepo(repoDir);

  const archivedSpecPath = path.join(
    repoDir,
    'prompts',
    'autonomous',
    'v2',
    'specs',
    'prds',
    'archived',
    'prd-history-001.json'
  );
  fs.mkdirSync(path.dirname(archivedSpecPath), { recursive: true });
  fs.writeFileSync(archivedSpecPath, `${JSON.stringify({
    id: 'prd-history-001',
    title: 'History PRD',
    createdAt: '2026-04-01T12:00:00.000Z',
    specification: 'Keep completed PRDs visible.',
    requirements: ['show full PRD info'],
    tasks: [
      {
        id: 'task-history-001',
        title: 'Render history',
        agentId: 'architecture-agent',
        acceptance: ['History includes archived PRDs.'],
      },
    ],
  }, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'prompts/autonomous/v2/specs/prds/archived/prd-history-001.json']);
  git(repoDir, ['commit', '-m', 'archive history prd']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);

  const paths = getAutonomyPathsForTest(repoDir);
  fs.writeFileSync(paths.prsState, `${JSON.stringify({
    pullRequests: [
      {
        id: 'pr-prd-history-001-architecture-agent',
        taskId: 'task-history-001',
        agentId: 'architecture-agent',
        laneKey: 'prd-history-001:architecture-agent',
        prdId: 'prd-history-001',
        sprintId: 'multi-agent-mvp',
        headBranch: 'agent/multi-agent-mvp/architecture-agent/prd-history-001-architecture-agent',
        baseBranch: 'dev',
        status: 'merged',
        title: '[architecture-agent] History PRD',
        createdAt: '2026-04-01T12:05:00.000Z',
        updatedAt: '2026-04-01T12:10:00.000Z',
        remote: {
          number: 13,
          url: 'https://github.com/asalaza6/autonomy-v2/pull/13',
          mergedAt: '2026-04-01T12:10:00.000Z',
        },
      },
    ],
  }, null, 2)}\n`, 'utf8');

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.prds.prds.some((prd) => prd.id === 'prd-history-001'), false);
  assert.equal(snapshot.prdHistory.prds.length, 1);
  assert.equal(snapshot.prdHistory.prds[0].id, 'prd-history-001');
  assert.equal(snapshot.prdHistory.prds[0].archivePath, 'prompts/autonomous/v2/specs/prds/archived/prd-history-001.json');
  assert.deepEqual(snapshot.prdHistory.prds[0].pullRequest, {
    number: 13,
    url: 'https://github.com/asalaza6/autonomy-v2/pull/13',
  });
});

test('status snapshots expose managed process records for the current repo target scope', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-managed-processes-');
  initAutonomyRepo(repoDir);

  setManagedProcess(repoDir, 'default', 'server', {
    sessionId: 'proc-server-1',
    outputSessionId: 'output-server-1',
    pid: process.pid,
    running: true,
    singletonOutcome: 'replaced',
    preRestartPid: 12345,
    postRestartPid: process.pid,
  });

  const snapshot = buildStatusSnapshot(repoDir);

  assert.equal(snapshot.controlPlane.managedProcesses.server.sessionId, 'proc-server-1');
  assert.equal(snapshot.controlPlane.managedProcesses.server.outputSessionId, 'output-server-1');
  assert.equal(snapshot.controlPlane.managedProcesses.server.pid, process.pid);
  assert.equal(snapshot.controlPlane.managedProcesses.server.running, true);
  assert.equal(snapshot.controlPlane.managedProcesses.server.singletonOutcome, 'replaced');
  assert.equal(snapshot.controlPlane.managedProcesses.server.preRestartPid, 12345);
  assert.equal('default' in snapshot.controlPlane.managedProcesses, false);
});

test('status snapshots omit linked pull request metadata when history PRDs have no associated PR', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-history-no-pr-');
  initAutonomyRepo(repoDir);

  const archivedSpecPath = path.join(
    repoDir,
    'prompts',
    'autonomous',
    'v2',
    'specs',
    'prds',
    'archived',
    'prd-history-no-pr-001.json'
  );
  fs.mkdirSync(path.dirname(archivedSpecPath), { recursive: true });
  fs.writeFileSync(archivedSpecPath, `${JSON.stringify({
    id: 'prd-history-no-pr-001',
    title: 'History PRD without PR',
    createdAt: '2026-04-01T12:00:00.000Z',
    specification: 'History item without a linked pull request.',
  }, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'prompts/autonomous/v2/specs/prds/archived/prd-history-no-pr-001.json']);
  git(repoDir, ['commit', '-m', 'archive history prd without pr']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.prdHistory.prds.length, 1);
  assert.equal(snapshot.prdHistory.prds[0].id, 'prd-history-no-pr-001');
  assert.equal('pullRequest' in snapshot.prdHistory.prds[0], false);
});

test('status snapshots derive completed PRD tasks from active PR records', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-prd-review-');
  initAutonomyRepo(repoDir);

  const taskOne = {
    id: 'prd-review-001-architecture-agent-1',
    title: 'Build first slice',
    agentId: 'architecture-agent',
    description: 'First implementation task.',
    acceptance: ['First implementation task is complete.'],
    sprintId: 'multi-agent-mvp',
  };
  const taskTwo = {
    id: 'prd-review-001-architecture-agent-2',
    title: 'Build second slice',
    agentId: 'architecture-agent',
    description: 'Second implementation task.',
    acceptance: ['Second implementation task is complete.'],
    sprintId: 'multi-agent-mvp',
  };
  addPrdWithTasks(repoDir, 'prd-review-001', 'Review step PRD', [taskOne, taskTwo]);

  const paths = getAutonomyPathsForTest(repoDir);
  fs.writeFileSync(paths.prsState, `${JSON.stringify({
    pullRequests: [
      {
        id: 'pr-prd-review-001-architecture-agent',
        taskId: taskTwo.id,
        agentId: 'architecture-agent',
        laneKey: 'prd-review-001:architecture-agent',
        prdId: 'prd-review-001',
        sprintId: 'multi-agent-mvp',
        taskIds: [taskOne.id, taskTwo.id],
        completedTaskIds: [taskOne.id, taskTwo.id],
        pendingTaskIds: [],
        headBranch: 'agent/multi-agent-mvp/architecture-agent/prd-review-001-architecture-agent',
        baseBranch: 'dev',
        status: 'open',
        title: '[architecture-agent] Review step PRD',
        createdAt: '2026-04-01T12:00:00.000Z',
        updatedAt: '2026-04-01T12:10:00.000Z',
        remote: {
          number: 7,
          url: 'https://github.com/asalaza6/autonomy-v2/pull/7',
          state: 'open',
        },
      },
    ],
  }, null, 2)}\n`, 'utf8');

  const snapshot = buildStatusSnapshot(repoDir);
  const prd = snapshot.prds.prds.find((candidate) => candidate.id === 'prd-review-001');
  assert.ok(prd);
  assert.equal(prd.status, 'planned');
  assert.equal(prd.statusSource, 'remote');
  assert.equal(prd.reconciliationStatus, 'stale');
  assert.deepEqual(prd.completedTaskSpecIds, [taskOne.id, taskTwo.id]);
  assert.deepEqual(prd.linkedPullRequestSummary, {
    total: 1,
    open: 1,
    resolved: 0,
    stale: 1,
  });
  assert.equal(snapshot.pullRequestStatuses.length, 1);
  assert.equal(snapshot.pullRequestStatuses[0].canonicalState, 'open');
  assert.equal(snapshot.pullRequestStatuses[0].canonicalSource, 'remote');
  assert.equal(snapshot.pullRequestStatuses[0].reconciliationStatus, 'stale');

  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        updatedAt: '2026-04-01T12:11:00.000Z',
        snapshot,
      },
    },
  } as any);

  assert.equal(dashboard.repos[0].activePrd.completedTaskCount, 2);
  assert.equal(dashboard.repos[0].activePrd.remainingTaskCount, 0);
  assert.equal(dashboard.repos[0].prdRun.currentStepId, 'reviewing');
  assert.deepEqual(
    dashboard.repos[0].prdRun.steps.map((step) => step.state),
    ['done', 'done', 'active']
  );
});

test('active PR selection prefers the most relevant matching PRD record with a valid URL', () => {
  const activePrd = {
    id: 'prd-active-001',
    status: 'planned',
    plannedTaskCount: 2,
    completedTaskCount: 1,
  };

  const selected = selectActivePullRequestStatusForPrd(activePrd, [
    {
      prId: 'pr-prd-active-001-approved',
      prdId: 'prd-active-001',
      number: 12,
      status: 'approved',
      statusLabel: 'approved waiting merge',
      mergeState: 'waiting',
      updatedAt: '2026-04-01T12:11:00.000Z',
      url: 'https://github.com/asalaza6/autonomy-v2/pull/12',
    },
    {
      prId: 'pr-prd-active-001-review',
      prdId: 'prd-active-001',
      number: 9,
      status: 'open',
      statusLabel: 'review active',
      updatedAt: '2026-04-01T12:10:00.000Z',
      url: 'https://github.com/asalaza6/autonomy-v2/pull/9',
    },
    {
      prId: 'pr-prd-active-001-invalid-url',
      prdId: 'prd-active-001',
      number: 13,
      status: 'open',
      statusLabel: 'review active',
      updatedAt: '2026-04-01T12:12:00.000Z',
      url: 'github.com/asalaza6/autonomy-v2/pull/13',
    },
    {
      prId: 'pr-prd-other-001-review',
      prdId: 'prd-other-001',
      number: 20,
      status: 'open',
      statusLabel: 'review active',
      updatedAt: '2026-04-01T12:13:00.000Z',
      url: 'https://github.com/asalaza6/autonomy-v2/pull/20',
    },
  ]);

  assert.ok(selected);
  assert.equal(selected.prId, 'pr-prd-active-001-review');
  assert.equal(selected.number, 9);
});

test('status snapshots reconcile stale manually resolved review state', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-stale-review-');
  initAutonomyRepo(repoDir);

  const task = {
    id: 'prd-resolved-review-001-architecture-agent-1',
    title: 'Build resolved slice',
    agentId: 'architecture-agent',
    description: 'Implementation was already applied.',
    acceptance: ['Implementation task is complete.'],
    sprintId: 'multi-agent-mvp',
  };
  addPrdWithTasks(repoDir, 'prd-resolved-review-001', 'Resolved review PRD', [task]);

  const prId = 'pr-prd-resolved-review-001-architecture-agent';
  const controlWorktree = path.join(repoDir, '.autonomy', 'control', 'dev-sync');
  const architectureQueuePath = path.join(controlWorktree, 'prompts', 'autonomous', 'v2', 'queues', 'architecture-agent.json');
  const reviewerQueuePath = path.join(controlWorktree, 'prompts', 'autonomous', 'v2', 'queues', 'reviewer.json');
  const architectureQueue = JSON.parse(fs.readFileSync(architectureQueuePath, 'utf8'));
  architectureQueue.tasks = architectureQueue.tasks.map((candidate) => candidate.id === task.id
    ? {
        ...candidate,
        state: 'done',
        status: 'done',
        completedAt: '2026-04-21T08:00:00.000Z',
        updatedAt: '2026-04-21T08:00:00.000Z',
      }
    : candidate);
  fs.writeFileSync(architectureQueuePath, `${JSON.stringify(architectureQueue, null, 2)}\n`, 'utf8');
  fs.writeFileSync(reviewerQueuePath, `${JSON.stringify({
    agentId: 'reviewer',
    role: 'review',
    tasks: [
      {
        id: `review-${prId}`,
        title: 'Review resolved PRD',
        description: 'Stale review task left behind after manual resolution.',
        agentId: 'reviewer',
        type: 'review',
        prId,
        sourceAgentId: 'architecture-agent',
        sourceTaskId: task.id,
        status: 'changes_requested',
        lastDecision: 'changes_requested',
        lastMergeFailureMessage: 'waiting for architecture-agent to address feedback',
        createdAt: '2026-04-21T07:55:00.000Z',
        updatedAt: '2026-04-21T07:55:00.000Z',
      },
    ],
  }, null, 2)}\n`, 'utf8');
  git(controlWorktree, [
    'add',
    '--all',
    '--',
    'prompts/autonomous/v2/queues/architecture-agent.json',
    'prompts/autonomous/v2/queues/reviewer.json',
  ]);
  git(controlWorktree, ['commit', '-m', 'seed stale resolved review state']);
  git(repoDir, ['update-ref', 'refs/heads/dev', git(controlWorktree, ['rev-parse', 'HEAD'])]);

  const paths = getAutonomyPathsForTest(repoDir);
  fs.writeFileSync(paths.prsState, `${JSON.stringify({
    pullRequests: [
      {
        id: prId,
        taskId: task.id,
        agentId: 'architecture-agent',
        laneKey: 'prd-resolved-review-001:architecture-agent',
        prdId: 'prd-resolved-review-001',
        sprintId: 'multi-agent-mvp',
        taskIds: [task.id],
        completedTaskIds: [task.id],
        pendingTaskIds: [],
        headBranch: 'agent/multi-agent-mvp/architecture-agent/prd-resolved-review-001-architecture-agent',
        baseBranch: 'dev',
        status: 'changes_requested',
        title: '[architecture-agent] Resolved review PRD',
        createdAt: '2026-04-21T07:50:00.000Z',
        updatedAt: '2026-04-21T08:00:00.000Z',
        remote: {
          number: 11,
          url: 'https://github.com/asalaza6/autonomy-v2/pull/11',
          state: 'open',
        },
      },
    ],
  }, null, 2)}\n`, 'utf8');

  const snapshot = buildStatusSnapshot(repoDir);
  const reviewerQueue = snapshot.queues.find((queue) => queue.agentId === 'reviewer');
  const reviewerStatus = snapshot.agentStatuses.find((agent) => agent.agentId === 'reviewer');
  const prd = snapshot.prds.prds.find((candidate) => candidate.id === 'prd-resolved-review-001');

  assert.equal(reviewerQueue.statuses.changes_requested, undefined);
  assert.equal(reviewerQueue.statuses.merged, 1);
  assert.equal(snapshot.taskCounts.changes_requested, undefined);
  assert.equal(snapshot.prCounts.changes_requested, 1);
  assert.equal(snapshot.prCounts.merged, undefined);
  assert.equal(reviewerStatus.workerStatus, 'idle');
  assert.equal(reviewerStatus.detail, 'no review tasks');
  assert.equal(snapshot.pullRequestStatuses.length, 1);
  assert.equal(snapshot.pullRequestStatuses[0].canonicalState, 'open');
  assert.equal(snapshot.pullRequestStatuses[0].canonicalSource, 'remote');
  assert.equal(snapshot.pullRequestStatuses[0].inferredState, 'merged');
  assert.equal(snapshot.pullRequestStatuses[0].reconciliationStatus, 'stale');
  assert.equal(prd.status, 'planned');
  assert.equal(prd.statusSource, 'remote');
  assert.equal(prd.reconciliationStatus, 'stale');
  assert.deepEqual(prd.completedTaskSpecIds, [task.id]);

  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        updatedAt: '2026-04-21T08:01:00.000Z',
        snapshot,
      },
    },
  } as any);

  assert.equal(dashboard.repos[0].activePrd.id, 'prd-resolved-review-001');
  assert.equal(dashboard.repos[0].prdRun.currentStepId, 'reviewing');
});

test('status snapshots preserve remote provenance for remotely resolved PRDs', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-remote-resolved-prd-');
  initAutonomyRepo(repoDir);

  const task = {
    id: 'prd-remote-resolved-001-architecture-agent-1',
    title: 'Build remote resolved slice',
    agentId: 'architecture-agent',
    description: 'Implementation is complete upstream.',
    acceptance: ['Implementation task is complete.'],
    sprintId: 'multi-agent-mvp',
  };
  addPrdWithTasks(repoDir, 'prd-remote-resolved-001', 'Remote resolved PRD', [task]);

  const paths = getAutonomyPathsForTest(repoDir);
  fs.writeFileSync(paths.prsState, `${JSON.stringify({
    pullRequests: [
      {
        id: 'pr-prd-remote-resolved-001-architecture-agent',
        taskId: task.id,
        agentId: 'architecture-agent',
        laneKey: 'prd-remote-resolved-001:architecture-agent',
        prdId: 'prd-remote-resolved-001',
        sprintId: 'multi-agent-mvp',
        taskIds: [task.id],
        completedTaskIds: [task.id],
        pendingTaskIds: [],
        headBranch: 'agent/multi-agent-mvp/architecture-agent/prd-remote-resolved-001-architecture-agent',
        baseBranch: 'dev',
        status: 'approved',
        title: '[architecture-agent] Remote resolved PRD',
        createdAt: '2026-04-21T07:50:00.000Z',
        updatedAt: '2026-04-21T08:00:00.000Z',
        remote: {
          number: 12,
          url: 'https://github.com/asalaza6/autonomy-v2/pull/12',
          state: 'closed',
          mergedAt: '2026-04-21T07:59:00.000Z',
        },
      },
    ],
  }, null, 2)}\n`, 'utf8');

  const snapshot = buildStatusSnapshot(repoDir);
  const prd = snapshot.prds.prds.find((candidate) => candidate.id === 'prd-remote-resolved-001');

  assert.ok(prd);
  assert.equal(prd.status, 'completed');
  assert.equal(prd.statusSource, 'remote');
  assert.equal(prd.reconciliationStatus, 'remote');
  assert.deepEqual(prd.linkedPullRequestSummary, {
    total: 1,
    open: 0,
    resolved: 1,
    stale: 0,
  });
  assert.equal(snapshot.pullRequestStatuses.length, 0);
});

test('status snapshots surface degraded validation state instead of inferred terminal PR state', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-pr-validation-error-');
  initAutonomyRepo(repoDir);

  const task = {
    id: 'prd-validation-error-001-architecture-agent-1',
    title: 'Build ambiguous remote slice',
    agentId: 'architecture-agent',
    description: 'Local work is complete but GitHub PR truth is unavailable.',
    acceptance: ['Control-plane status does not silently mark the PR merged.'],
    sprintId: 'multi-agent-mvp',
  };
  addPrdWithTasks(repoDir, 'prd-validation-error-001', 'Validation error PRD', [task]);

  const paths = getAutonomyPathsForTest(repoDir);
  fs.writeFileSync(paths.prsState, `${JSON.stringify({
    pullRequests: [
      {
        id: 'pr-prd-validation-error-001-architecture-agent',
        taskId: task.id,
        agentId: 'architecture-agent',
        laneKey: 'prd-validation-error-001:architecture-agent',
        prdId: 'prd-validation-error-001',
        sprintId: 'multi-agent-mvp',
        taskIds: [task.id],
        completedTaskIds: [task.id],
        pendingTaskIds: [],
        headBranch: 'agent/multi-agent-mvp/architecture-agent/prd-validation-error-001-architecture-agent',
        baseBranch: 'dev',
        status: 'changes_requested',
        title: '[architecture-agent] Validation error PRD',
        createdAt: '2026-04-21T07:50:00.000Z',
        updatedAt: '2026-04-21T08:00:00.000Z',
        remote: {
          number: 14,
          url: 'https://github.com/asalaza6/autonomy-v2/pull/14',
        },
      },
    ],
  }, null, 2)}\n`, 'utf8');

  const snapshot = buildStatusSnapshot(repoDir);
  const prd = snapshot.prds.prds.find((candidate) => candidate.id === 'prd-validation-error-001');

  assert.ok(prd);
  assert.equal(snapshot.pullRequestStatuses.length, 1);
  assert.equal(snapshot.pullRequestStatuses[0].status, 'validation_error');
  assert.equal(snapshot.pullRequestStatuses[0].statusLabel, 'GitHub validation failed');
  assert.equal(snapshot.pullRequestStatuses[0].canonicalState, 'validation-error');
  assert.equal(snapshot.pullRequestStatuses[0].canonicalSource, 'validation');
  assert.equal(snapshot.pullRequestStatuses[0].inferredState, 'merged');
  assert.equal(snapshot.pullRequestStatuses[0].reconciliationStatus, 'validation-error');
  assert.match(snapshot.pullRequestStatuses[0].action, /GitHub validation failed/i);
  assert.equal(prd.status, 'planned');
  assert.equal(prd.statusSource, 'validation');
  assert.equal(prd.reconciliationStatus, 'validation-error');
  assert.equal(prd.statusReason, 'GitHub pull request state could not be validated');
  assert.deepEqual(prd.linkedPullRequestSummary, {
    total: 1,
    open: 1,
    resolved: 0,
    stale: 0,
  });
});

test('status snapshots include deployment branch comparison details', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-deploy-');
  initAutonomyRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ version: '1.0.0' }, null, 2) + '\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'add package version']);
  git(repoDir, ['branch', '-f', 'dev', 'main']);

  git(repoDir, ['checkout', 'dev']);
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ version: '1.1.0' }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'deploy.js'), 'export const deploy = true;\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'advance dev']);

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.deployment.sourceBranch, 'dev');
  assert.equal(snapshot.deployment.targetBranch, 'main');
  assert.equal(snapshot.deployment.branchesAligned, false);
  assert.equal(snapshot.deployment.hasChanges, true);
  assert.equal(snapshot.deployment.sourceAheadBy > 0, true);
  assert.match(snapshot.deployment.detail, /ahead of main/);
  assert.match(snapshot.deployment.version.currentVersion, /^1\.0\.0\+build\.\d+\.[a-f0-9]+$/);
  assert.match(snapshot.deployment.version.sourceVersion, /^1\.1\.0\+build\.\d+\.[a-f0-9]+$/);
  assert.match(snapshot.deployment.version.targetVersion, /^1\.0\.0\+build\.\d+\.[a-f0-9]+$/);
  assert.equal(snapshot.deployment.version.packageVersion, '1.0.0');
  assert.equal(snapshot.deployment.version.sourcePackageVersion, '1.1.0');
  assert.equal(snapshot.deployment.version.targetPackageVersion, '1.0.0');
  assert.equal(snapshot.deployment.version.isNewVersion, false);
});
