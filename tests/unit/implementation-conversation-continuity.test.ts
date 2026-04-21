import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { getAgentDefinition } from '../../src/agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES } from '../../src/agents/role-catalog.js';
import { appendTrackedBranchFollowupTask } from '../../src/autonomy-v2/commands/shared-worktrees.js';
import { markImplementationTaskComplete } from '../../src/autonomy-v2/runner/workspace.js';

const queueRelativePath = 'prompts/autonomous/v2/queues/architecture-agent.json';

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

function buildImplementationAgent() {
  return {
    id: 'architecture-agent',
    role: AGENT_ROLES.IMPLEMENTATION,
    taskQueue: queueRelativePath,
    include: ['**/*'],
    checks: [],
    gitIdentity: {
      name: 'Architecture Agent',
      email: 'architecture@example.com',
    },
  };
}

function buildConfig() {
  return {
    integrationBranch: 'dev',
    productionBranch: 'main',
    branchPrefixes: { task: 'agent' },
    worktreesRoot: '.autonomy/worktrees',
    agents: [buildImplementationAgent()],
  };
}

function buildTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prd-conversation-architecture-agent-1',
    title: 'Implement conversation continuity',
    description: 'Initial implementation task',
    agentId: 'architecture-agent',
    prdId: 'prd-conversation',
    laneKey: 'prd-conversation:architecture-agent',
    type: 'implementation',
    sprintId: 'shared',
    baseBranch: 'dev',
    checks: [],
    acceptance: ['done'],
    state: 'active',
    status: 'active',
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
    ...overrides,
  };
}

function buildQueue(tasks: unknown[]) {
  return {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: AGENT_ROLES.IMPLEMENTATION,
    tasks,
  };
}

test('implementation task completion persists the implementation conversation id', () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-conversation-'));
  const queuePath = path.join(worktreePath, queueRelativePath);
  const task = buildTask({
    implementationConversationId: 'session-original',
  });
  writeJson(queuePath, buildQueue([buildTask()]));

  markImplementationTaskComplete(
    worktreePath,
    buildConfig(),
    task,
    'agent/shared/architecture-agent/prd-conversation-architecture-agent',
    'code'
  );

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(queue.tasks[0].status, 'done');
  assert.equal(queue.tasks[0].implementationConversationId, 'session-original');
});

test('tracked review follow-up task carries the original implementation conversation id', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-followup-conversation-'));
  const config = buildConfig();
  const queuePath = path.join(rootDir, queueRelativePath);
  const branch = 'agent/shared/architecture-agent/prd-conversation-architecture-agent';
  const worktreePath = path.join(rootDir, '.autonomy', 'worktrees', 'architecture-agent', 'shared-prd-conversation-architecture-agent');
  const originalTask = buildTask({
    branch,
    state: 'done',
    status: 'done',
    implementationConversationId: 'session-original',
    completedAt: '2026-04-21T00:10:00.000Z',
  });

  git(rootDir, ['init', '-b', 'dev']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);
  writeJson(queuePath, buildQueue([buildTask({ state: 'queued', status: 'queued' })]));
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-m', 'seed queue']);
  git(rootDir, ['checkout', '-b', branch]);
  writeJson(queuePath, buildQueue([originalTask]));
  git(rootDir, ['add', queueRelativePath]);
  git(rootDir, ['commit', '-m', 'complete original task']);
  git(rootDir, ['checkout', 'dev']);
  git(rootDir, ['worktree', 'add', worktreePath, branch]);

  const pr = {
    id: 'pr-prd-conversation-architecture-agent',
    title: 'Conversation continuity',
    taskId: originalTask.id,
    laneKey: originalTask.laneKey,
    prdId: originalTask.prdId,
    sprintId: originalTask.sprintId,
    agentId: originalTask.agentId,
    baseBranch: 'dev',
    headBranch: branch,
    reviews: [{ decision: 'changes_requested' }],
    completedTaskIds: [originalTask.id],
  };
  const state = {
    config,
    taskQueues: {
      'architecture-agent': buildQueue([buildTask({ state: 'queued', status: 'queued' })]),
    },
    branchLocks: {
      locks: [
        {
          taskId: originalTask.id,
          laneKey: originalTask.laneKey,
          agentId: originalTask.agentId,
          branch,
          worktreePath,
          completedTasks: [originalTask],
          updatedAt: '2026-04-21T00:10:00.000Z',
        },
      ],
    },
  };

  const followupTask = appendTrackedBranchFollowupTask(rootDir, state, pr, {
    id: 'architecture-agent-followup-pr-prd-conversation-architecture-agent-1',
    title: 'Address review for Conversation continuity',
    description: 'Address reviewer feedback.',
    type: 'review_followup',
    source: 'review_followup',
    createdAt: '2026-04-21T00:20:00.000Z',
    updatedAt: '2026-04-21T00:20:00.000Z',
  });

  assert.equal(followupTask.implementationConversationId, 'session-original');
  const worktreeQueue = JSON.parse(fs.readFileSync(path.join(worktreePath, queueRelativePath), 'utf8'));
  const queuedFollowup = worktreeQueue.tasks.find((task) => task.id === followupTask.id);
  assert.equal(queuedFollowup.implementationConversationId, 'session-original');
});

function buildRunnerContext(executeTask: (input: any) => Promise<any>, taskOverrides: Record<string, unknown> = {}) {
  const task = buildTask({
    implementationConversationId: 'session-original',
    ...taskOverrides,
  });
  const completedTasks: any[] = [];
  const context: any = {
    phase: 'runner',
    rootDir: '/tmp/example',
    agent: buildImplementationAgent(),
    config: buildConfig(),
    current: {
      queues: {},
    },
    runtimeStore: {
      loadState() {
        return {
          config: context.config,
          queues: {},
        };
      },
    },
    queueStore: {
      getTask() {
        return task;
      },
      buildTaskLaneKey() {
        return task.laneKey;
      },
      getLaneTasks() {
        return [task];
      },
      isPendingImplementationTask() {
        return false;
      },
      markImplementationTaskComplete(_worktreePath: string, _config: unknown, completedTask: any) {
        completedTasks.push({ ...completedTask });
        return {
          queuePath: '/tmp/example/prompts/autonomous/v2/queues/architecture-agent.json',
          relativePath: queueRelativePath,
        };
      },
    },
    prStore: {
      getPrForLane() {
        return {
          id: 'pr-prd-conversation-architecture-agent',
          status: 'changes_requested',
          reviews: [{ decision: 'changes_requested', summary: 'Fix this.' }],
          pendingTaskIds: [task.id],
        };
      },
      finalizeTaskRun() {},
    },
    branchLockStore: {
      getCompletedLaneTasks() {
        return [];
      },
      recordLaneTaskCompletion() {
        return [{ id: task.id }];
      },
    },
    logger: {
      logRunnerEvent() {},
      appendRunnerLog() {},
    },
    codex: {
      useStub() {
        return false;
      },
      executeTask,
    },
    scm: {
      ensureCheckEnvironment() {},
      listChangedFiles() {
        return [];
      },
      runCheckCommands() {
        return [];
      },
      buildCommitMessage() {
        return 'auto(architecture-agent): followup prd-conversation-architecture-agent-1';
      },
      runGit() {},
      hasStagedGitChanges() {
        return false;
      },
    },
    scopeEvaluator: {
      evaluate() {
        return { ok: true, violations: [] };
      },
    },
    reviewClient: {
      hasGithubAuth() {
        return false;
      },
    },
  };
  return { context, completedTasks };
}

test('implementation runner resumes an existing implementation conversation', async () => {
  const calls: any[] = [];
  const { context } = buildRunnerContext(async (input) => {
    calls.push(input);
    return {
      status: 'completed',
      implementationConversationId: input.resumeConversationId,
    };
  });

  await getAgentDefinition(AGENT_ROLES.IMPLEMENTATION).execute(context, {
    kind: 'task',
    agentId: 'architecture-agent',
    reason: 'runner',
    taskId: 'prd-conversation-architecture-agent-1',
    branch: 'agent/shared/architecture-agent/prd-conversation-architecture-agent',
    worktreePath: '/tmp/example/.autonomy/worktrees/architecture-agent/shared-prd-conversation-architecture-agent',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].resumeConversationId, 'session-original');
  assert.equal(calls[0].disableConversationResume, undefined);
});

test('implementation runner falls back to explicit task context when resume is unavailable', async () => {
  const calls: any[] = [];
  const { context, completedTasks } = buildRunnerContext(async (input) => {
    calls.push(input);
    if (input.resumeConversationId) {
      throw new Error('session expired');
    }
    return {
      status: 'completed',
      implementationConversationId: 'session-fallback',
    };
  });

  await getAgentDefinition(AGENT_ROLES.IMPLEMENTATION).execute(context, {
    kind: 'task',
    agentId: 'architecture-agent',
    reason: 'runner',
    taskId: 'prd-conversation-architecture-agent-1',
    branch: 'agent/shared/architecture-agent/prd-conversation-architecture-agent',
    worktreePath: '/tmp/example/.autonomy/worktrees/architecture-agent/shared-prd-conversation-architecture-agent',
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].resumeConversationId, 'session-original');
  assert.equal(calls[1].resumeConversationId, '');
  assert.equal(calls[1].disableConversationResume, true);
  assert.equal(completedTasks[0].implementationConversationId, 'session-fallback');
});

test('implementation runner does not resume from generic reviewer conversation fields', async () => {
  const calls: any[] = [];
  const { context, completedTasks } = buildRunnerContext(async (input) => {
    calls.push(input);
    return {
      status: 'completed',
      sessionId: 'session-new-implementation',
    };
  }, {
    implementationConversationId: undefined,
    conversationId: 'reviewer-conversation',
    sessionId: 'reviewer-session',
  });

  await getAgentDefinition(AGENT_ROLES.IMPLEMENTATION).execute(context, {
    kind: 'task',
    agentId: 'architecture-agent',
    reason: 'runner',
    taskId: 'prd-conversation-architecture-agent-1',
    branch: 'agent/shared/architecture-agent/prd-conversation-architecture-agent',
    worktreePath: '/tmp/example/.autonomy/worktrees/architecture-agent/shared-prd-conversation-architecture-agent',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].resumeConversationId, undefined);
  assert.equal(calls[0].disableConversationResume, undefined);
  assert.equal(completedTasks[0].implementationConversationId, 'session-new-implementation');
});
