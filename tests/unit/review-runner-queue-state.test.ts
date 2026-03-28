import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { loadState, persistReviewerTaskState } from '../../src/autonomy-v2/runner/runner-state.js';

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

function createReviewQueueRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-review-runner-'));
  const agentsPath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json');
  const reviewerQueuePath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'reviewer.json');

  writeJson(agentsPath, {
    integrationBranch: 'dev',
    agents: [
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
  writeJson(reviewerQueuePath, {
    agentId: 'reviewer',
    role: 'review',
    tasks: [],
  });

  git(rootDir, ['init', '-b', 'main']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-m', 'initial queues']);
  git(rootDir, ['branch', 'dev']);
  git(rootDir, ['checkout', 'dev']);

  writeJson(reviewerQueuePath, {
    agentId: 'reviewer',
    role: 'review',
    tasks: [
      {
        id: 'review-pr-fe-architecture-agent',
        title: 'Review PR',
        agentId: 'reviewer',
        type: 'review',
        prId: 'pr-fe-architecture-agent',
        sourceAgentId: 'fe-architecture-agent',
        status: 'assigned',
        createdAt: '2026-03-28T19:45:15.000Z',
        updatedAt: '2026-03-28T19:45:15.000Z',
      },
    ],
  });
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-m', 'queue review task on dev']);
  git(rootDir, ['checkout', 'main']);

  return {
    rootDir,
    agentsPath,
    reviewerQueuePath,
  };
}

test('runner loads reviewer tasks from the tracked integration branch queue', () => {
  const { rootDir } = createReviewQueueRepo();

  const state = loadState(rootDir);
  const reviewerQueue = state.queues.reviewer;

  assert.equal(reviewerQueue.tasks.length, 1);
  assert.equal(reviewerQueue.tasks[0].id, 'review-pr-fe-architecture-agent');
  assert.equal(reviewerQueue.tasks[0].status, 'assigned');
});

test('runner persists reviewer task updates back to the tracked integration branch queue', () => {
  const { rootDir, agentsPath, reviewerQueuePath } = createReviewQueueRepo();
  const config = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));

  persistReviewerTaskState(rootDir, config, 'review-pr-fe-architecture-agent', {
    status: 'approved',
    updatedAt: '2026-03-28T19:45:19.000Z',
  });

  const trackedQueue = JSON.parse(git(rootDir, ['show', 'dev:prompts/autonomous/v2/queues/reviewer.json']));
  assert.equal(trackedQueue.tasks[0].id, 'review-pr-fe-architecture-agent');
  assert.equal(trackedQueue.tasks[0].status, 'approved');

  const workingTreeQueue = JSON.parse(fs.readFileSync(reviewerQueuePath, 'utf8'));
  assert.equal(workingTreeQueue.tasks.length, 0);
});
