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
