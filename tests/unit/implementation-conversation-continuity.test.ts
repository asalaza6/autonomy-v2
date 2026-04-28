import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { getAgentDefinition } from '../../src/agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES } from '../../src/agents/role-catalog.js';
import { buildAgentConversationKey, getAgentConversationId } from '../../src/agents/conversation-references.js';
import { appendTrackedBranchFollowupTask, enqueueLaneFollowupTask } from '../../src/autonomy-v2/commands/shared-worktrees.js';
import { markImplementationTaskComplete } from '../../src/autonomy-v2/runner/workspace.js';

const queueRelativePath = 'prompts/autonomous/v2/queues/architecture-agent.json';
const reviewerConversationKey = buildAgentConversationKey({ agentId: 'reviewer', role: AGENT_ROLES.REVIEW });
const implementationConversationKey = buildAgentConversationKey({ agentId: 'architecture-agent', role: AGENT_ROLES.IMPLEMENTATION });

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
    agents: [
      buildImplementationAgent(),
      {
        id: 'reviewer',
        role: AGENT_ROLES.REVIEW,
        taskQueue: 'prompts/autonomous/v2/queues/reviewer.json',
        systemPrompt: 'prompts/autonomous/v2/agents/reviewer/system.md',
      },
    ],
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

test('conversation lookup keeps references isolated by stored role metadata', () => {
  const sharedAgentReviewKey = buildAgentConversationKey({
    agentId: 'shared-agent',
    role: AGENT_ROLES.REVIEW,
  });
  const record = {
    conversationReferences: {
      [sharedAgentReviewKey]: {
        conversationId: 'review-session',
        agentId: 'shared-agent',
        role: AGENT_ROLES.REVIEW,
      },
    },
  };

  assert.equal(getAgentConversationId(record, {
    agentId: 'shared-agent',
    role: AGENT_ROLES.REVIEW,
  }), 'review-session');
  assert.equal(getAgentConversationId(record, {
    agentId: 'shared-agent',
    role: AGENT_ROLES.IMPLEMENTATION,
  }), '');
});

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
  assert.equal(queue.tasks[0].conversationReferences[implementationConversationKey].conversationId, 'session-original');
});

test('implementation task completion maps generalized references back to legacy implementation id', () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-conversation-generalized-'));
  const queuePath = path.join(worktreePath, queueRelativePath);
  const task = buildTask({
    implementationConversationId: undefined,
    conversationReferences: {
      [implementationConversationKey]: {
        conversationId: 'session-generalized',
        agentId: 'architecture-agent',
        role: AGENT_ROLES.IMPLEMENTATION,
      },
    },
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
  assert.equal(queue.tasks[0].implementationConversationId, 'session-generalized');
  assert.equal(queue.tasks[0].conversationReferences[implementationConversationKey].conversationId, 'session-generalized');
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
  assert.equal(followupTask.conversationReferences[implementationConversationKey].conversationId, 'session-original');
  const worktreeQueue = JSON.parse(fs.readFileSync(path.join(worktreePath, queueRelativePath), 'utf8'));
  const queuedFollowup = worktreeQueue.tasks.find((task) => task.id === followupTask.id);
  assert.equal(queuedFollowup.implementationConversationId, 'session-original');
  assert.equal(queuedFollowup.conversationReferences[implementationConversationKey].conversationId, 'session-original');
});

test('review follow-up task falls back to the PR implementation conversation reference', () => {
  const taskQueues = {
    'architecture-agent': buildQueue([]),
  };
  const pr = {
    id: 'pr-prd-conversation-architecture-agent',
    title: 'Conversation continuity',
    taskId: 'prd-conversation-architecture-agent-1',
    laneKey: 'prd-conversation:architecture-agent',
    prdId: 'prd-conversation',
    sprintId: 'shared',
    agentId: 'architecture-agent',
    baseBranch: 'dev',
    reviews: [{ decision: 'changes_requested' }],
    acceptance: ['done'],
    conversationReferences: {
      [implementationConversationKey]: {
        conversationId: 'session-from-pr',
        agentId: 'architecture-agent',
        role: AGENT_ROLES.IMPLEMENTATION,
      },
    },
  };

  const followupTask = enqueueLaneFollowupTask(taskQueues, buildConfig(), pr, {
    id: 'architecture-agent-followup-pr-prd-conversation-architecture-agent-1',
    title: 'Address review for Conversation continuity',
    description: 'Address reviewer feedback.',
    type: 'review_followup',
    source: 'review_followup',
    createdAt: '2026-04-21T00:20:00.000Z',
    updatedAt: '2026-04-21T00:20:00.000Z',
  });

  assert.equal(followupTask.implementationConversationId, 'session-from-pr');
  assert.equal(followupTask.conversationReferences[implementationConversationKey].conversationId, 'session-from-pr');
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
    clock: {
      now() {
        return '2026-04-21T00:40:00.000Z';
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
  assert.equal(completedTasks[0].conversationReferences[implementationConversationKey].conversationId, 'session-fallback');
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
    conversationReferences: {
      [reviewerConversationKey]: {
        conversationId: 'reviewer-reference',
        agentId: 'reviewer',
        role: AGENT_ROLES.REVIEW,
      },
    },
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

test('reviewer auto-approves after four prior review rounds when checks and scope are clean', async () => {
  const { context, recordedReviews } = buildReviewRunnerContext(async () => ({
    decision: 'changes_requested',
    summary: 'Still asking for another review round.',
    concerns: ['Please revisit this once more.'],
  }), {
    prOverrides: {
      reviews: [
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 1' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 2' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 3' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 4' },
      ],
      status: 'changes_requested',
    },
  });

  const result = await getAgentDefinition(AGENT_ROLES.REVIEW).execute(context, {
    kind: AGENT_ROLES.REVIEW,
    agentId: 'reviewer',
    reason: 'runner',
    reviewTaskId: 'review-pr-prd-conversation-architecture-agent',
    prId: 'pr-prd-conversation-architecture-agent',
    sourceAgentId: 'architecture-agent',
  });

  assert.equal(result.status, 'approved');
  assert.equal(result.decision, 'approve');
  assert.equal(recordedReviews.length, 1);
  assert.equal(recordedReviews[0].decision, 'approve');
  assert.match(recordedReviews[0].summary, /Auto-approval threshold reached: 4\+ reviewer rounds with passing checks\/scope\./);
});

function buildReviewTask(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'review-pr-prd-conversation-architecture-agent',
    title: 'Review Conversation continuity',
    description: 'Review pr-prd-conversation-architecture-agent',
    agentId: 'reviewer',
    type: AGENT_ROLES.REVIEW,
    prId: 'pr-prd-conversation-architecture-agent',
    sourceTaskId: 'prd-conversation-architecture-agent-1',
    sourceAgentId: 'architecture-agent',
    reviewRound: 2,
    status: 'queued',
    createdAt: '2026-04-21T00:30:00.000Z',
    updatedAt: '2026-04-21T00:30:00.000Z',
    ...overrides,
  };
}

function buildPr(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'pr-prd-conversation-architecture-agent',
    taskId: 'prd-conversation-architecture-agent-1',
    laneKey: 'prd-conversation:architecture-agent',
    agentId: 'architecture-agent',
    title: '[architecture-agent] Conversation continuity',
    body: 'Conversation continuity',
    baseBranch: 'dev',
    headBranch: 'agent/shared/architecture-agent/prd-conversation-architecture-agent',
    acceptance: ['done'],
    checks: [],
    reviews: [
      {
        reviewerId: 'reviewer',
        decision: 'changes_requested',
        summary: 'Earlier feedback.',
      },
    ],
    status: 'changes_requested',
    commitCount: 2,
    createdAt: '2026-04-21T00:10:00.000Z',
    updatedAt: '2026-04-21T00:20:00.000Z',
    ...overrides,
  };
}

function buildReviewRunnerContext(
  reviewPr: (input: any) => Promise<any>,
  options: {
    reviewTaskOverrides?: Record<string, unknown>;
    prOverrides?: Record<string, unknown>;
    rootDir?: string;
    worktreePath?: string;
    diffFiles?: string[];
    runCheckCommands?: (worktreePath: string, commands: string[]) => any[];
  } = {}
) {
  const reviewTask = buildReviewTask(options.reviewTaskOverrides || {});
  const pr = buildPr(options.prOverrides || {});
  const recordedReviews: any[] = [];
  const rootDir = options.rootDir || '/tmp/example';
  const worktreePath = options.worktreePath || path.join(rootDir, '.autonomy', 'worktrees', 'reviewer', 'pr-prd-conversation-architecture-agent');
  const context: any = {
    phase: 'runner',
    rootDir,
    agent: {
      id: 'reviewer',
      role: AGENT_ROLES.REVIEW,
      taskQueue: 'prompts/autonomous/v2/queues/reviewer.json',
      systemPrompt: 'prompts/autonomous/v2/agents/reviewer/system.md',
    },
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
      getReviewTask() {
        return reviewTask;
      },
      persistReviewerTaskState(_reviewTaskId: string, patch: any) {
        Object.assign(reviewTask, patch);
      },
    },
    prStore: {
      getPr() {
        return pr;
      },
      recordReviewDecision(params: any) {
        recordedReviews.push(params);
      },
    },
    branchLockStore: {},
    logger: {
      logRunnerEvent() {},
      appendRunnerLog() {},
    },
    codex: {
      useStub() {
        return false;
      },
      reviewPr,
    },
    scm: {
      ensureReviewContext() {
        return {
          branch: pr.headBranch,
          worktreePath,
        };
      },
      listBranchCommits() {
        return [];
      },
      listReviewDiffFiles() {
        return options.diffFiles || ['src/example.ts'];
      },
      ensureCheckEnvironment() {},
      runCheckCommands(checkPath: string, commands: string[]) {
        if (options.runCheckCommands) {
          return options.runCheckCommands(checkPath, commands);
        }
        return [];
      },
      tryMergeWithRetry() {
        return { merged: false, message: 'not expected' };
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
      publishMergeFollowupCommentIfNeeded() {
        return false;
      },
    },
    clock: {
      now() {
        return '2026-04-21T00:40:00.000Z';
      },
    },
  };
  return { context, reviewTask, pr, recordedReviews };
}

async function runReview(context: any) {
  return getAgentDefinition(AGENT_ROLES.REVIEW).execute(context, {
    kind: AGENT_ROLES.REVIEW,
    agentId: 'reviewer',
    reason: 'runner',
    reviewTaskId: 'review-pr-prd-conversation-architecture-agent',
    prId: 'pr-prd-conversation-architecture-agent',
    sourceAgentId: 'architecture-agent',
  } as any);
}

test('reviewer runner records a reviewer conversation reference when codex returns one', async () => {
  const calls: any[] = [];
  const { context, reviewTask, pr, recordedReviews } = buildReviewRunnerContext(async (input) => {
    calls.push(input);
    return {
      decision: 'changes_requested',
      summary: 'Needs one fix.',
      concerns: ['Fix the regression.'],
      conversationId: 'review-session-1',
    };
  });

  await runReview(context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].resumeConversationId, undefined);
  assert.equal(reviewTask.conversationReferences[reviewerConversationKey].conversationId, 'review-session-1');
  assert.equal(pr.conversationReferences[reviewerConversationKey].conversationId, 'review-session-1');
  assert.equal(recordedReviews[0].conversationId, 'review-session-1');
});

test('reviewer runner resumes the prior reviewer conversation for the same review agent', async () => {
  const calls: any[] = [];
  const { context } = buildReviewRunnerContext(async (input) => {
    calls.push(input);
    return {
      decision: 'changes_requested',
      summary: 'Still needs one fix.',
      concerns: ['Fix remains.'],
      conversationId: 'review-session-next',
    };
  }, {
    reviewTaskOverrides: {
      conversationReferences: {
        [reviewerConversationKey]: {
          conversationId: 'review-session-original',
          agentId: 'reviewer',
          role: AGENT_ROLES.REVIEW,
        },
        [implementationConversationKey]: {
          conversationId: 'implementation-session',
          agentId: 'architecture-agent',
          role: AGENT_ROLES.IMPLEMENTATION,
        },
      },
    },
  });

  await runReview(context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].resumeConversationId, 'review-session-original');
  assert.equal(calls[0].disableConversationResume, undefined);
});

test('reviewer runner falls back to explicit review context when resume is unavailable', async () => {
  const calls: any[] = [];
  const { context, recordedReviews } = buildReviewRunnerContext(async (input) => {
    calls.push(input);
    if (input.resumeConversationId) {
      throw new Error('session expired');
    }
    return {
      decision: 'changes_requested',
      summary: 'Fallback review ran.',
      concerns: ['Review used explicit context.'],
      conversationId: 'review-session-fallback',
    };
  }, {
    reviewTaskOverrides: {
      conversationReferences: {
        [reviewerConversationKey]: {
          conversationId: 'review-session-original',
          agentId: 'reviewer',
          role: AGENT_ROLES.REVIEW,
        },
      },
    },
  });

  await runReview(context);

  assert.equal(calls.length, 2);
  assert.equal(calls[0].resumeConversationId, 'review-session-original');
  assert.equal(calls[1].resumeConversationId, '');
  assert.equal(calls[1].disableConversationResume, true);
  assert.equal(recordedReviews[0].conversationId, 'review-session-fallback');
});

test('reviewer runner does not resume implementation conversation references', async () => {
  const calls: any[] = [];
  const { context } = buildReviewRunnerContext(async (input) => {
    calls.push(input);
    return {
      decision: 'changes_requested',
      summary: 'Fresh review.',
      concerns: [],
      conversationId: 'review-session-new',
    };
  }, {
    reviewTaskOverrides: {
      implementationConversationId: 'implementation-legacy-session',
      conversationReferences: {
        [implementationConversationKey]: {
          conversationId: 'implementation-session',
          agentId: 'architecture-agent',
          role: AGENT_ROLES.IMPLEMENTATION,
        },
      },
    },
    prOverrides: {
      conversationReferences: {
        [implementationConversationKey]: {
          conversationId: 'implementation-session-from-pr',
          agentId: 'architecture-agent',
          role: AGENT_ROLES.IMPLEMENTATION,
        },
      },
    },
  });

  await runReview(context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].resumeConversationId, undefined);
  assert.equal(calls[0].disableConversationResume, undefined);
});

test('reviewer runner includes repo merge-blocking lint and typecheck scripts in executed checks', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-review-checks-'));
  const worktreePath = path.join(rootDir, '.autonomy', 'worktrees', 'reviewer', 'pr-prd-conversation-architecture-agent');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, 'package.json'), `${JSON.stringify({
    name: 'review-check-fixture',
    scripts: {
      lint: 'eslint src',
      typecheck: 'tsc --noEmit',
    },
  }, null, 2)}\n`, 'utf8');

  const seenCommands: string[][] = [];
  const { context, recordedReviews } = buildReviewRunnerContext(async () => ({
    decision: 'approved',
    summary: 'Looks good.',
    concerns: [],
  }), {
    rootDir,
    worktreePath,
    prOverrides: {
      checks: ['npm run test'],
    },
    runCheckCommands(_checkPath, commands) {
      seenCommands.push(commands);
      return commands.map((command) => ({
        command,
        status: command === 'npm run lint' ? 'failed' : 'passed',
        output: command === 'npm run lint' ? 'lint failed' : '',
      }));
    },
  });

  await runReview(context);

  assert.deepEqual(seenCommands[0], ['npm run test', 'npm run typecheck', 'npm run lint']);
  assert.equal(recordedReviews[0].decision, 'changes-requested');
  assert.match(recordedReviews[0].summary, /Blocking checks failed: npm run lint/);
});

test('reviewer runner includes focused control-plane summary ui checks when the diff touches summary surfaces', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-review-summary-ui-checks-'));
  const worktreePath = path.join(rootDir, '.autonomy', 'worktrees', 'reviewer', 'pr-prd-conversation-architecture-agent');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, 'package.json'), `${JSON.stringify({
    name: 'review-check-fixture',
    scripts: {
      lint: 'eslint src',
      typecheck: 'tsc --noEmit',
      'test:control-plane-summary-ui': 'node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
    },
  }, null, 2)}\n`, 'utf8');

  const seenCommands: string[][] = [];
  const { context, recordedReviews } = buildReviewRunnerContext(async () => ({
    decision: 'approved',
    summary: 'Looks good.',
    concerns: [],
  }), {
    rootDir,
    worktreePath,
    diffFiles: ['src/server/control-plane/control-plane-client.tsx'],
    runCheckCommands(_checkPath, commands) {
      seenCommands.push(commands);
      return commands.map((command) => ({
        command,
        status: 'passed',
        output: '',
      }));
    },
  });

  await runReview(context);

  assert.deepEqual(seenCommands[0], ['npm run typecheck', 'npm run lint', 'npm run test:control-plane-summary-ui']);
  assert.equal(recordedReviews[0].decision, 'approve');
});
