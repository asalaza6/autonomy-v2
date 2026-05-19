import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildStatusSnapshot } from '../../src/autonomy-v2/control-plane/status-service.js';
import { syncPrdSpecsFromIntegrationBranch } from '../../src/sync/syncer.js';

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeJson(filePath: string, payload: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function gitFileExists(cwd: string, revisionPath: string) {
  try {
    git(cwd, ['cat-file', '-e', revisionPath]);
    return true;
  } catch {
    return false;
  }
}

function createQueuePromotionOrderRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-queue-promotion-order-'));

  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json'), {
    schemaVersion: 1,
    integrationBranch: 'dev',
    worktreesRoot: '.autonomy/worktrees',
    branchPrefixes: {
      task: 'agent',
    },
    agents: [
      {
        id: 'architecture-agent',
        role: 'implementation',
        taskQueue: 'prompts/autonomous/v2/queues/architecture-agent.json',
        systemPrompt: 'prompts/autonomous/v2/agents/architecture-agent/system.md',
        gitIdentity: {
          name: 'architecture-agent',
          email: 'architecture-agent@example.com',
        },
      },
    ],
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'sprint.json'), {
    sprintId: 'multi-agent-mvp',
    defaultTaskBaseBranch: 'dev',
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'architecture-agent.json'), {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [],
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'queue', 'prd-queue-promo-200.json'), {
    id: 'prd-queue-promo-200',
    title: 'First queued PRD',
    createdAt: '2026-04-26T08:00:00.000Z',
    specification: 'This queued PRD should promote first.',
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'queue', 'prd-queue-promo-100.json'), {
    id: 'prd-queue-promo-100',
    title: 'Second queued PRD',
    createdAt: '2026-04-26T09:00:00.000Z',
    specification: 'This queued PRD should stay queued.',
  });

  git(rootDir, ['init', '-b', 'main']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);
  git(rootDir, ['add', 'prompts']);
  git(rootDir, ['commit', '-m', 'seed queued prd order fixture']);
  git(rootDir, ['branch', 'dev']);

  return rootDir;
}

function createStaleCompletedActivePrdRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-stale-active-promotion-'));
  const taskId = 'prd-stale-active-001-architecture-agent-1';

  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json'), {
    schemaVersion: 1,
    integrationBranch: 'dev',
    productionBranch: 'main',
    worktreesRoot: '.autonomy/worktrees',
    branchPrefixes: {
      task: 'agent',
    },
    agents: [
      {
        id: 'pm-agent',
        role: 'pm',
        taskQueue: 'prompts/autonomous/v2/queues/pm-agent.json',
        systemPrompt: 'prompts/autonomous/v2/agents/pm-agent/system.md',
        gitIdentity: {
          name: 'pm-agent',
          email: 'pm-agent@example.com',
        },
      },
      {
        id: 'architecture-agent',
        role: 'implementation',
        taskQueue: 'prompts/autonomous/v2/queues/architecture-agent.json',
        systemPrompt: 'prompts/autonomous/v2/agents/architecture-agent/system.md',
        gitIdentity: {
          name: 'architecture-agent',
          email: 'architecture-agent@example.com',
        },
      },
      {
        id: 'reviewer',
        role: 'review',
        taskQueue: 'prompts/autonomous/v2/queues/reviewer.json',
        systemPrompt: 'prompts/autonomous/v2/agents/reviewer/system.md',
        gitIdentity: {
          name: 'reviewer',
          email: 'reviewer@example.com',
        },
      },
    ],
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'sprint.json'), {
    sprintId: 'multi-agent-mvp',
    defaultTaskBaseBranch: 'dev',
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json'), {
    schemaVersion: 1,
    repoId: 'stale-active-fixture',
    label: 'Stale active fixture',
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'architecture-agent.json'), {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [],
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'reviewer.json'), {
    agentId: 'reviewer',
    role: 'review',
    tasks: [],
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'prd-stale-active-001.json'), {
    id: 'prd-stale-active-001',
    title: 'Stale completed active PRD',
    createdAt: '2026-05-19T20:00:00.000Z',
    tasks: [
      {
        id: taskId,
        title: 'Build stale active slice',
        agentId: 'architecture-agent',
        acceptance: ['Merged work should complete the PRD.'],
      },
    ],
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'specs', 'prd-state', 'prd-stale-active-001.json'), {
    schemaVersion: 1,
    prdId: 'prd-stale-active-001',
    status: 'planned',
    plannedTaskIds: [taskId],
    createdAt: '2026-05-19T20:01:00.000Z',
    updatedAt: '2026-05-19T20:01:00.000Z',
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'queue', 'prd-next-queued-001.json'), {
    id: 'prd-next-queued-001',
    title: 'Next queued PRD',
    createdAt: '2026-05-19T21:00:00.000Z',
    specification: 'This PRD should be promoted after stale active completion.',
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'queue', 'prd-later-queued-001.json'), {
    id: 'prd-later-queued-001',
    title: 'Later queued PRD',
    createdAt: '2026-05-19T22:00:00.000Z',
    specification: 'This PRD should remain queued.',
  });
  writeJson(path.join(rootDir, '.autonomy', 'runtime', 'state', 'prs.json'), {
    pullRequests: [
      {
        id: 'pr-prd-stale-active-001-architecture-agent',
        taskId,
        agentId: 'architecture-agent',
        laneKey: 'prd-stale-active-001:architecture-agent',
        prdId: 'prd-stale-active-001',
        sprintId: 'multi-agent-mvp',
        taskIds: [taskId],
        completedTaskIds: [taskId],
        pendingTaskIds: [],
        headBranch: 'agent/multi-agent-mvp/architecture-agent/prd-stale-active-001-architecture-agent',
        baseBranch: 'dev',
        status: 'approved',
        title: '[architecture-agent] Stale completed active PRD',
        createdAt: '2026-05-19T20:05:00.000Z',
        updatedAt: '2026-05-19T20:10:00.000Z',
        remote: {
          number: 42,
          url: 'https://github.com/example/repo/pull/42',
          state: 'closed',
          mergedAt: '2026-05-19T20:10:00.000Z',
        },
      },
    ],
  });
  writeJson(path.join(rootDir, '.autonomy', 'runtime', 'state', 'branch-locks.json'), {
    locks: [],
  });
  writeJson(path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json'), {
    workers: {},
  });

  git(rootDir, ['init', '-b', 'main']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);
  git(rootDir, ['add', 'prompts']);
  git(rootDir, ['commit', '-m', 'seed stale active prd fixture']);
  git(rootDir, ['branch', 'dev']);

  return rootDir;
}

test('queued PRD promotion follows queue creation order instead of path order', () => {
  const rootDir = createQueuePromotionOrderRepo();

  const result = syncPrdSpecsFromIntegrationBranch(rootDir, 'dev');

  assert.equal(result.queuedPromotion.id, 'prd-queue-promo-200');
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0], 'prd-queue-promo-200');
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-200.json'),
    true
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-200.json'),
    false
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-100.json'),
    true
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-100.json'),
    false
  );
});

test('sync archives stale completed active PRD before promoting one queued PRD', () => {
  const rootDir = createStaleCompletedActivePrdRepo();

  const result = syncPrdSpecsFromIntegrationBranch(rootDir, 'dev');

  assert.deepEqual(result.archivedCompletedPrds.map((entry) => entry.id), ['prd-stale-active-001']);
  assert.equal(result.queuedPromotion.id, 'prd-next-queued-001');
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/prd-stale-active-001.json'),
    false
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/archived/prd-stale-active-001.json'),
    true
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prd-state/prd-stale-active-001.json'),
    false
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/prd-next-queued-001.json'),
    true
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-next-queued-001.json'),
    false
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-later-queued-001.json'),
    true
  );

  const secondResult = syncPrdSpecsFromIntegrationBranch(rootDir, 'dev');
  assert.deepEqual(secondResult.archivedCompletedPrds, []);
  assert.equal(secondResult.queuedPromotion, null);

  const snapshot = buildStatusSnapshot(rootDir);
  const stalePrd = snapshot.prds.prds.find((candidate) => candidate.id === 'prd-stale-active-001');
  const promotedPrd = snapshot.prds.prds.find((candidate) => candidate.id === 'prd-next-queued-001');
  const pmStatus = snapshot.agentStatuses.find((agent) => agent.agentId === 'pm-agent');

  assert.equal(stalePrd, undefined);
  assert.ok(promotedPrd);
  assert.equal(promotedPrd.isQueued, false);
  assert.equal(promotedPrd.status, 'queued');
  assert.match(pmStatus.detail, /2 PRDs awaiting planning/);
});

test('queued PRD promotion prefers highest priority before queue creation order', () => {
  const rootDir = createQueuePromotionOrderRepo();
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'queue', 'prd-queue-promo-900.json'), {
    id: 'prd-queue-promo-900',
    title: 'Highest priority queued PRD',
    createdAt: '2026-04-26T10:00:00.000Z',
    priority: 'highest',
    specification: 'This queued PRD should jump ahead of older normal priority PRDs.',
  });
  git(rootDir, ['add', 'prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-900.json']);
  git(rootDir, ['commit', '-m', 'add highest priority queued prd']);
  git(rootDir, ['branch', '-f', 'dev', 'HEAD']);

  const result = syncPrdSpecsFromIntegrationBranch(rootDir, 'dev');

  assert.equal(result.queuedPromotion.id, 'prd-queue-promo-900');
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0], 'prd-queue-promo-900');
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-900.json'),
    true
  );
  assert.equal(
    gitFileExists(rootDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-200.json'),
    true
  );
});
