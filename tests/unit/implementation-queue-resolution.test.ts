import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { resolveImplementationQueueContext } from '../../src/server/orchestrator/queues.js';

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

test('resolveImplementationQueueContext does not re-dispatch a root queued task when the branch-local copy is already done', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-queue-resolution-'));
  const queueRelativePath = 'prompts/autonomous/v2/queues/architecture-agent.json';
  const rootQueuePath = path.join(rootDir, queueRelativePath);
  const branch = 'agent/shared/architecture-agent/prd-1-architecture-agent';
  const worktreePath = path.join(rootDir, '.autonomy', 'worktrees', 'architecture-agent', 'shared-prd-1-architecture-agent');

  git(rootDir, ['init', '-b', 'dev']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);

  writeJson(rootQueuePath, {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-1',
        agentId: 'architecture-agent',
        prdId: 'prd-1',
        laneKey: 'prd-1:architecture-agent',
        sprintId: 'shared',
        status: 'queued',
      },
    ],
  });
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-m', 'seed queue']);
  git(rootDir, ['checkout', '-b', branch]);
  git(rootDir, ['worktree', 'add', worktreePath, 'HEAD']);

  writeJson(path.join(worktreePath, queueRelativePath), {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-1',
        agentId: 'architecture-agent',
        prdId: 'prd-1',
        laneKey: 'prd-1:architecture-agent',
        sprintId: 'shared',
        status: 'done',
        state: 'done',
      },
    ],
  });

  const context = resolveImplementationQueueContext(rootDir, {
    integrationBranch: 'dev',
    branchPrefixes: { task: 'agent' },
    worktreesRoot: '.autonomy/worktrees',
    agents: [
      {
        id: 'architecture-agent',
        role: 'implementation',
        taskQueue: queueRelativePath,
      },
    ],
  } as any, { locks: [] }, {
    id: 'architecture-agent',
    role: 'implementation',
    taskQueue: queueRelativePath,
  } as any, {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-1',
        agentId: 'architecture-agent',
        prdId: 'prd-1',
        laneKey: 'prd-1:architecture-agent',
        sprintId: 'shared',
        status: 'queued',
      },
    ],
  });

  assert.equal(context.source, 'root');
  assert.deepEqual(context.queue.tasks, []);
  assert.equal(context.branch, null);
  assert.equal(context.worktreePath, null);
});

test('resolveImplementationQueueContext keeps newly queued root work runnable when older branch-local work is already done', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-queue-resolution-new-work-'));
  const queueRelativePath = 'prompts/autonomous/v2/queues/architecture-agent.json';
  const rootQueuePath = path.join(rootDir, queueRelativePath);
  const branch = 'agent/shared/architecture-agent/prd-1-architecture-agent';
  const worktreePath = path.join(rootDir, '.autonomy', 'worktrees', 'architecture-agent', 'shared-prd-1-architecture-agent');

  git(rootDir, ['init', '-b', 'dev']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);

  writeJson(rootQueuePath, {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-1',
        agentId: 'architecture-agent',
        prdId: 'prd-1',
        laneKey: 'prd-1:architecture-agent',
        sprintId: 'shared',
        status: 'queued',
      },
      {
        id: 'task-2',
        agentId: 'architecture-agent',
        prdId: 'prd-2',
        laneKey: 'prd-2:architecture-agent',
        sprintId: 'shared',
        status: 'queued',
      },
    ],
  });
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-m', 'seed queue']);
  git(rootDir, ['checkout', '-b', branch]);
  git(rootDir, ['worktree', 'add', worktreePath, 'HEAD']);

  writeJson(path.join(worktreePath, queueRelativePath), {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-1',
        agentId: 'architecture-agent',
        prdId: 'prd-1',
        laneKey: 'prd-1:architecture-agent',
        sprintId: 'shared',
        status: 'done',
        state: 'done',
      },
    ],
  });

  const context = resolveImplementationQueueContext(rootDir, {
    integrationBranch: 'dev',
    branchPrefixes: { task: 'agent' },
    worktreesRoot: '.autonomy/worktrees',
    agents: [
      {
        id: 'architecture-agent',
        role: 'implementation',
        taskQueue: queueRelativePath,
      },
    ],
  } as any, { locks: [] }, {
    id: 'architecture-agent',
    role: 'implementation',
    taskQueue: queueRelativePath,
  } as any, {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-1',
        agentId: 'architecture-agent',
        prdId: 'prd-1',
        laneKey: 'prd-1:architecture-agent',
        sprintId: 'shared',
        status: 'queued',
      },
      {
        id: 'task-2',
        agentId: 'architecture-agent',
        prdId: 'prd-2',
        laneKey: 'prd-2:architecture-agent',
        sprintId: 'shared',
        status: 'queued',
      },
    ],
  });

  assert.equal(context.source, 'root');
  assert.deepEqual(context.queue.tasks.map((task: any) => task.id), ['task-2']);
  assert.equal(context.branch, null);
  assert.equal(context.worktreePath, null);
});
