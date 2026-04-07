import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { runImplementation } from '../../src/autonomy-v2/runner/task-flow.js';

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

test('runImplementation commits staged changes instead of always falling into commit-skip', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-runner-commit-'));
  const worktreePath = path.join(rootDir, '.autonomy', 'worktrees', 'architecture-agent', 'shared-number-styling1-architecture-agent');
  const queueRelativePath = 'prompts/autonomous/v2/queues/architecture-agent.json';
  const queuePath = path.join(worktreePath, queueRelativePath);
  const pagePath = path.join(worktreePath, 'src', 'pages', 'index.tsx');
  const agentsConfigPath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json');
  const prsPath = path.join(rootDir, '.autonomy', 'runtime', 'state', 'prs.json');
  const tasksPath = path.join(rootDir, '.autonomy', 'runtime', 'state', 'tasks.json');
  const branchLocksPath = path.join(rootDir, '.autonomy', 'runtime', 'state', 'branch-locks.json');

  git(rootDir, ['init', '-b', 'main']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);
  git(rootDir, ['checkout', '-b', 'dev']);

  writeJson(agentsConfigPath, {
    integrationBranch: 'dev',
    productionBranch: 'main',
    projectName: 'test-repo',
    branchPrefixes: { task: 'agent' },
    worktreesRoot: '.autonomy/worktrees',
    agents: [
      {
        id: 'architecture-agent',
        role: 'implementation',
        taskQueue: queueRelativePath,
        include: ['**/*'],
        checks: [],
        gitIdentity: {
          name: 'Architecture Agent',
          email: 'architecture@example.com',
        },
      },
    ],
  });
  writeJson(prsPath, { pullRequests: [] });
  writeJson(tasksPath, { tasks: [] });
  writeJson(branchLocksPath, { locks: [] });
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-m', 'seed runtime']);

  git(rootDir, ['checkout', '-b', 'agent/shared/architecture-agent/number-styling1-architecture-agent']);
  git(rootDir, ['worktree', 'add', worktreePath, 'HEAD']);

  writeJson(queuePath, {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'number-styling1-architecture-agent-1',
        title: 'Style the home page number presentation',
        description: 'Update the home page number treatment.',
        agentId: 'architecture-agent',
        prdId: 'number-styling1',
        laneKey: 'number-styling1:architecture-agent',
        type: 'implementation',
        sprintId: 'shared',
        baseBranch: 'dev',
        checks: [],
        acceptance: ['done'],
        state: 'active',
        status: 'active',
        createdAt: '2026-04-07T00:00:00.000Z',
        updatedAt: '2026-04-07T00:00:00.000Z',
        branch: 'agent/shared/architecture-agent/number-styling1-architecture-agent',
        startedAt: '2026-04-07T00:00:00.000Z',
      },
    ],
  });
  fs.mkdirSync(path.dirname(pagePath), { recursive: true });
  fs.writeFileSync(pagePath, 'export default function Home() { return <main>updated</main>; }\n', 'utf8');

  const result: any = await runImplementation({
    rootDir,
    agentId: 'architecture-agent',
    taskId: 'number-styling1-architecture-agent-1',
    branch: 'agent/shared/architecture-agent/number-styling1-architecture-agent',
    worktreePath,
  });

  assert.equal(result.status, 'done');
  assert.equal(git(worktreePath, ['rev-list', '--count', 'HEAD']), '2');
  const prs = JSON.parse(fs.readFileSync(prsPath, 'utf8'));
  assert.equal(prs.pullRequests.length, 1);
  assert.equal(prs.pullRequests[0].pendingTaskIds.length, 0);
});
