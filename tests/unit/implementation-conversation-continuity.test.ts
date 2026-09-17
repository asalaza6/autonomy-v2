import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { AGENT_ROLES } from '../../src/agents/role-catalog.js';
import { buildAgentConversationKey, getAgentConversationId } from '../../src/agents/conversation-references.js';
import { appendTrackedBranchFollowupTask, enqueueLaneFollowupTask } from '../../src/autonomy-v2/commands/shared-worktrees.js';

const queueRelativePath = 'prompts/autonomous/v2/queues/architecture-agent.json';
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
