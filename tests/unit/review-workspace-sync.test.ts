import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { ensureReviewContext } from '../../src/autonomy-v2/runner/workspace.js';

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

test('ensureReviewContext does not dirty a checked-out base branch when origin/base is ahead', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-review-workspace-'));
  const originDir = path.join(tempRoot, 'origin.git');
  const seedDir = path.join(tempRoot, 'seed');
  const rootDir = path.join(tempRoot, 'root');
  const reviewerQueuePath = path.join(seedDir, 'prompts', 'autonomous', 'v2', 'queues', 'reviewer.json');

  fs.mkdirSync(originDir, { recursive: true });
  git(originDir, ['init', '--bare']);

  fs.mkdirSync(seedDir, { recursive: true });
  git(seedDir, ['init', '-b', 'main']);
  git(seedDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(seedDir, ['config', 'user.name', 'Autonomy Test']);
  writeJson(reviewerQueuePath, {
    agentId: 'reviewer',
    role: 'review',
    tasks: [
      {
        id: 'review-pr-1',
        title: 'Review PR',
        agentId: 'reviewer',
        type: 'review',
        prId: 'pr-1',
        sourceTaskId: 'task-1',
        sourceAgentId: 'architecture-agent',
        reviewRound: 1,
        status: 'queued',
        createdAt: '2026-03-31T06:45:28.050Z',
        updatedAt: '2026-03-31T06:45:28.050Z',
      },
    ],
  });
  git(seedDir, ['add', '.']);
  git(seedDir, ['commit', '-m', 'initial reviewer queue']);
  git(seedDir, ['branch', 'dev']);
  git(seedDir, ['remote', 'add', 'origin', originDir]);
  git(seedDir, ['push', 'origin', 'main', 'dev']);

  git(tempRoot, ['clone', originDir, rootDir]);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);
  git(rootDir, ['checkout', 'dev']);
  git(rootDir, ['checkout', '-b', 'feature-1']);
  git(rootDir, ['checkout', 'dev']);

  git(seedDir, ['checkout', 'dev']);
  writeJson(reviewerQueuePath, {
    agentId: 'reviewer',
    role: 'review',
    tasks: [
      {
        id: 'review-pr-1',
        title: 'Review PR',
        agentId: 'reviewer',
        type: 'review',
        prId: 'pr-1',
        sourceTaskId: 'task-1',
        sourceAgentId: 'architecture-agent',
        reviewRound: 1,
        status: 'assigned',
        createdAt: '2026-03-31T06:45:28.050Z',
        updatedAt: '2026-03-31T06:45:33.918Z',
        dispatchedAt: '2026-03-31T06:45:33.918Z',
        dispatcher: 'scheduler',
      },
    ],
  });
  git(seedDir, ['add', '.']);
  git(seedDir, ['commit', '-m', 'assign reviewer queue']);
  git(seedDir, ['push', 'origin', 'dev']);

  git(rootDir, ['fetch', 'origin', 'dev']);

  const reviewContext = ensureReviewContext(rootDir, {
    id: 'pr-1',
    agentId: 'architecture-agent',
    taskId: 'task-1',
    laneKey: 'lane-1',
    baseBranch: 'dev',
    headBranch: 'feature-1',
  });

  assert.equal(git(rootDir, ['status', '--short']), '');
  assert.equal(git(rootDir, ['rev-parse', 'dev']), git(rootDir, ['rev-parse', 'origin/dev']));
  assert.equal(fs.existsSync(reviewContext.worktreePath), true);
});
