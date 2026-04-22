import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

function countReviewerQueueSyncCommits(rootDir: string) {
  const output = git(rootDir, [
    'log',
    '--format=%s',
    'dev',
    '--',
    'prompts/autonomous/v2/queues/reviewer.json',
  ]);
  return output
    .split('\n')
    .filter((line) => line.trim() === 'autonomy(queue): sync reviewer queue')
    .length;
}

function createReviewerQueueSyncRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-reviewer-sync-'));
  const taskId = 'prd-reviewer-sync-architecture-agent-1';
  const prId = 'pr-prd-reviewer-sync-architecture-agent';

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
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'prd-reviewer-sync.json'), {
    id: 'prd-reviewer-sync',
    title: 'Reviewer sync PRD',
    createdAt: '2026-04-22T08:00:00.000Z',
    specification: 'Verify reviewer queue sync is idempotent.',
    tasks: [
      {
        id: taskId,
        title: 'Build reviewer sync fixture',
        agentId: 'architecture-agent',
        acceptance: ['Reviewer queue sync fixture is complete.'],
      },
    ],
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'architecture-agent.json'), {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: taskId,
        title: 'Build reviewer sync fixture',
        description: 'Fixture implementation task.',
        agentId: 'architecture-agent',
        prdId: 'prd-reviewer-sync',
        laneKey: 'prd-reviewer-sync:architecture-agent',
        sprintId: 'multi-agent-mvp',
        status: 'done',
        state: 'done',
        acceptance: ['Reviewer queue sync fixture is complete.'],
        createdAt: '2026-04-22T08:00:00.000Z',
        updatedAt: '2026-04-22T08:10:00.000Z',
        completedAt: '2026-04-22T08:10:00.000Z',
      },
    ],
  });
  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'reviewer.json'), {
    agentId: 'reviewer',
    role: 'review',
    tasks: [],
  });
  writeJson(path.join(rootDir, '.autonomy', 'runtime', 'state', 'prs.json'), {
    pullRequests: [
      {
        id: prId,
        taskId,
        laneKey: 'prd-reviewer-sync:architecture-agent',
        prdId: 'prd-reviewer-sync',
        sprintId: 'multi-agent-mvp',
        agentId: 'architecture-agent',
        sourceTitle: 'Reviewer sync PRD',
        sourceBody: 'Lane task ids: prd-reviewer-sync-architecture-agent-1',
        taskIds: [taskId],
        completedTaskIds: [taskId],
        pendingTaskIds: [],
        acceptance: ['Reviewer queue sync fixture is complete.'],
        checks: [],
        commitCount: 1,
        headBranch: 'agent/multi-agent-mvp/architecture-agent/prd-reviewer-sync-architecture-agent',
        baseBranch: 'dev',
        status: 'open',
        reviews: [],
        createdAt: '2026-04-22T08:12:00.000Z',
        updatedAt: '2026-04-22T08:12:00.000Z',
        remote: null,
        title: '[architecture-agent] Reviewer sync PRD',
        body: 'Lane task ids: prd-reviewer-sync-architecture-agent-1',
      },
    ],
  });

  git(rootDir, ['init', '-b', 'main']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);
  git(rootDir, ['add', 'prompts']);
  git(rootDir, ['commit', '-m', 'seed tracked queues']);
  git(rootDir, ['branch', 'dev']);

  return rootDir;
}

test('tracked reviewer queue sync does not commit again when state is unchanged', () => {
  const rootDir = createReviewerQueueSyncRepo();

  assert.equal(countReviewerQueueSyncCommits(rootDir), 0);

  syncPrdSpecsFromIntegrationBranch(rootDir, 'dev');
  const firstSyncedHead = git(rootDir, ['rev-parse', 'dev']);
  assert.equal(countReviewerQueueSyncCommits(rootDir), 1);

  syncPrdSpecsFromIntegrationBranch(rootDir, 'dev');
  const secondSyncedHead = git(rootDir, ['rev-parse', 'dev']);
  assert.equal(countReviewerQueueSyncCommits(rootDir), 1);
  assert.equal(secondSyncedHead, firstSyncedHead);
});
