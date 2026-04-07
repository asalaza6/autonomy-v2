import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { readImplementationQueueSnapshot } from '../../src/server/orchestrator/orchestrator-git.js';

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

test('readImplementationQueueSnapshot prefers live worktree queue state over committed branch state', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-queue-snapshot-'));
  const queuePath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'architecture-agent.json');

  git(rootDir, ['init', '-b', 'main']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);

  writeJson(queuePath, {
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-1',
        agentId: 'architecture-agent',
        status: 'queued',
      },
    ],
  });
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-m', 'seed queue']);
  git(rootDir, ['checkout', '-b', 'agent/shared/architecture-agent/prd-1-architecture-agent']);

  const worktreePath = path.join(rootDir, '.autonomy', 'worktrees', 'architecture-agent', 'shared-prd-1-architecture-agent');
  git(rootDir, ['worktree', 'add', worktreePath, 'HEAD']);

  writeJson(path.join(worktreePath, 'prompts', 'autonomous', 'v2', 'queues', 'architecture-agent.json'), {
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-1',
        agentId: 'architecture-agent',
        status: 'done',
        state: 'done',
      },
    ],
  });

  const snapshot = readImplementationQueueSnapshot(rootDir, {
    integrationBranch: 'dev',
    agents: [
      {
        id: 'architecture-agent',
        role: 'implementation',
        taskQueue: 'prompts/autonomous/v2/queues/architecture-agent.json',
      },
    ],
  } as any, 'architecture-agent', {
    branch: 'agent/shared/architecture-agent/prd-1-architecture-agent',
    worktreePath,
  });

  assert.equal(snapshot.tasks[0].status, 'done');
  assert.equal(snapshot.tasks[0].state, 'done');
});
