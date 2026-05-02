import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { getAgentDefinition } from '../../src/agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES } from '../../src/agents/role-catalog.js';
import { buildAgentConversationKey, getAgentConversationId } from '../../src/agents/conversation-references.js';
import { run as runGate } from '../../src/autonomy-v2/commands/gate.js';
import { appendTrackedBranchFollowupTask, enqueueLaneFollowupTask } from '../../src/autonomy-v2/commands/shared-worktrees.js';
import {
  buildReviewerBlockersFromReview,
  resolveVerificationCommandsFromChangedFiles,
} from '../../src/autonomy-v2/commands/shared-review-blockers.js';
import { markImplementationTaskComplete } from '../../src/autonomy-v2/runner/workspace.js';
import { recordLaneTaskCompletion } from '../../src/autonomy-v2/runner/runner-state.js';

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
    systemPrompt: 'prompts/autonomous/v2/agents/architecture-agent/system.md',
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
        gitIdentity: {
          name: 'Reviewer Agent',
          email: 'reviewer@example.com',
        },
      },
    ],
  };
}

function buildTask(overrides: Record<string, unknown> = {}): any {
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

test('review follow-up task stores structured reviewer blockers and required checks', () => {
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
  };
  const reviewDecision = {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Run `npm run test:unit -- review-followup` before approval.',
  };
  const reviewerBlockers = buildReviewerBlockersFromReview(pr, reviewDecision);

  const followupTask = enqueueLaneFollowupTask(taskQueues, buildConfig(), pr, {
    id: 'architecture-agent-followup-pr-prd-conversation-architecture-agent-structured-1',
    title: 'Address review for Conversation continuity',
    description: reviewDecision.summary,
    type: 'review_followup',
    source: 'review_followup',
    createdAt: '2026-04-21T00:20:00.000Z',
    updatedAt: '2026-04-21T00:20:00.000Z',
    reviewerBlockers,
  });

  assert.deepEqual(followupTask.checks, ['npm run test:unit -- review-followup']);
  assert.equal(followupTask.reviewerBlockers.length, 1);
  assert.equal(followupTask.reviewerBlockers[0].category, 'verification');
  assert.deepEqual(followupTask.reviewerBlockers[0].requiredChecks, ['npm run test:unit -- review-followup']);
  assert.equal(followupTask.reviewerBlockers[0].requiredEvidence[0].kind, 'command_output');
  assert.equal(followupTask.reviewerBlockers[0].status.state, 'open');
});

test('review blocker extraction resolves mentioned test files into executable verification commands', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please run `tests/unit/control-plane-summary-ui.test.ts` before approval.',
  });

  assert.equal(reviewerBlockers.length, 1);
  assert.equal(reviewerBlockers[0].category, 'verification');
  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'mentioned_test_file');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedFiles, ['tests/unit/control-plane-summary-ui.test.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js']);
  assert.equal(reviewerBlockers[0].requiredEvidence[0].command, 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js');
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction resolves focused verification areas into executable commands', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun the control plane summary UI verification before approval.',
  }, {
    packageScripts: {
      'test:control-plane-summary-ui': 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
    },
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'mentioned_area');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['control-plane-summary-ui']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:control-plane-summary-ui']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction prefers changed-file-derived area commands when changed files resolve the same mentioned area', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun the control plane summary UI verification before approval.',
  }, {
    packageScripts: {
      'test:control-plane-summary-ui': 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
    },
    changedFiles: ['src/server/control-plane/control-plane-client.tsx'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['control-plane-summary-ui']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/server/control-plane/control-plane-client.tsx']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:control-plane-summary-ui']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction resolves changed-file-derived areas into executable verification commands', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:control-plane-summary-ui': 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
    },
    changedFiles: ['src/server/control-plane/control-plane-client.tsx'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['control-plane-summary-ui']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/server/control-plane/control-plane-client.tsx']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:control-plane-summary-ui']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction derives changed-file area commands without reviewer-supplied area text', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification before approval.',
  }, {
    packageScripts: {
      'test:control-plane-summary-ui': 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
    },
    changedFiles: ['src/server/control-plane/control-plane-client.tsx'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['control-plane-summary-ui']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/server/control-plane/control-plane-client.tsx']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:control-plane-summary-ui']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction prefers changed-file-derived area commands when the review mentions an affected area and touched files', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun the control plane summary UI verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:control-plane-summary-ui': 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
    },
    changedFiles: ['src/server/control-plane/control-plane-client.tsx'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['control-plane-summary-ui']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/server/control-plane/control-plane-client.tsx']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:control-plane-summary-ui']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction derives focused test commands from changed source files alone', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/autonomy-v2/commands/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/review-followup.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction resolves changed files through the matching package test script when one exists', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:review-followup': 'npm run build && node --test dist/tests/unit/review-followup.test.js',
      typecheck: 'tsc --noEmit',
    },
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/autonomy-v2/commands/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:review-followup']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction resolves changed files deterministically when candidate test files are unsorted', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:review-followup': 'npm run build && node --test dist/tests/unit/review-followup.test.js',
      'test:review-followup-suite': 'npm run build && node --test dist/tests/unit/review-followup-extra.test.js dist/tests/unit/review-followup.test.js',
    },
    availableTestFiles: [
      'tests/unit/review-followup-extra.test.ts',
      'tests/unit/review-followup.test.ts',
    ],
    changedFiles: ['src/lib/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, []);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/lib/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:review-followup']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction resolves changed files into runnable verification without area heuristics', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:review-followup': 'npm run build && node --test dist/tests/unit/review-followup.test.js',
    },
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/lib/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, []);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/lib/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:review-followup']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction resolves changed files without reviewer-supplied changed-file keywords', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification before approval.',
  }, {
    packageScripts: {
      'test:review-followup': 'npm run build && node --test dist/tests/unit/review-followup.test.js',
    },
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/lib/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, []);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/lib/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:review-followup']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction keeps changed-file-derived commands executable when reviewer mentions an unmapped area for the touched files', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun lint for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:review-followup': 'npm run build && node --test dist/tests/unit/review-followup.test.js',
    },
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/lib/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, []);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/lib/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:review-followup']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction picks the most focused matching package script for changed files', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:review-followup': 'npm run build && node --test dist/tests/unit/review-followup.test.js',
      'test:review-followup-suite': 'npm run build && node --test dist/tests/unit/review-followup.test.js dist/tests/unit/implementation-conversation-continuity.test.js',
    },
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/autonomy-v2/commands/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:review-followup']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction derives broad unit verification from changed source files when no focused test can be resolved', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    changedFiles: ['src/autonomy-v2/commands/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/*.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction derives typecheck from changed config files alone', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    packageScripts: {
      typecheck: 'tsc --noEmit',
    },
    changedFiles: ['package.json'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['typecheck']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['package.json']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run typecheck']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction prefers focused changed-file commands over broad unit verification requests', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun unit verification for the files touched here before approval.',
  }, {
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/autonomy-v2/commands/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/review-followup.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction resolves broad area requests through changed-file-derived focused tests', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun unit verification before approval.',
  }, {
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/autonomy-v2/commands/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/review-followup.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction derives changed-file area commands even when reviewer only gives a broad verification area', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun unit verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:control-plane-summary-ui': 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
    },
    changedFiles: ['src/server/control-plane/control-plane-client.tsx'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['control-plane-summary-ui']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/server/control-plane/control-plane-client.tsx']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:control-plane-summary-ui']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction prefers direct changed test-file commands over broader changed-file area scripts', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:control-plane-summary-ui': 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
    },
    changedFiles: ['tests/unit/control-plane-summary-ui.test.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['control-plane-summary-ui']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['tests/unit/control-plane-summary-ui.test.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction derives focused test commands from unit tests that import changed source files', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    worktreePath: process.cwd(),
    changedFiles: ['src/autonomy-v2/commands/shared-review-blockers.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/shared-review-blockers.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/implementation-conversation-continuity.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction resolves changed files through import-based test discovery without reviewer area hints', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification before approval.',
  }, {
    worktreePath: process.cwd(),
    changedFiles: ['src/autonomy-v2/commands/shared-review-blockers.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/shared-review-blockers.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/implementation-conversation-continuity.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('changed-file verification resolution derives a runnable command from changed source files alone', () => {
  const verificationTarget = resolveVerificationCommandsFromChangedFiles(
    ['src/autonomy-v2/commands/shared-review-blockers.ts'],
    {
      worktreePath: process.cwd(),
    }
  );

  assert.equal(verificationTarget?.source, 'changed_files');
  assert.deepEqual(verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(verificationTarget?.changedFiles, ['src/autonomy-v2/commands/shared-review-blockers.ts']);
  assert.deepEqual(verificationTarget?.resolvedCommands, ['npm run build && node --test dist/tests/unit/implementation-conversation-continuity.test.js']);
  assert.equal(verificationTarget?.unresolvedReason, null);
});

test('review blocker extraction resolves "files touched here" requests from changed files without reviewer-supplied area text or literal commands', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    packageScripts: {
      'test:review-followup': 'npm run build && node --test dist/tests/unit/review-followup.test.js',
    },
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/lib/review-followup.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, []);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/lib/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run test:review-followup']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('changed-file verification resolution resolves touched source files without reviewer area keywords', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for the files touched here before approval.',
  }, {
    worktreePath: process.cwd(),
    changedFiles: ['src/autonomy-v2/commands/shared-review-blockers.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedAreas, ['unit']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/shared-review-blockers.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/implementation-conversation-continuity.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('changed-file verification resolution resolves an arbitrary changed source file through the matching package test script', () => {
  const verificationTarget = resolveVerificationCommandsFromChangedFiles(
    ['src/lib/review-followup.ts'],
    {
      packageScripts: {
        'test:review-followup': 'npm run build && node --test dist/tests/unit/review-followup.test.js',
      },
      availableTestFiles: ['tests/unit/review-followup.test.ts'],
    }
  );

  assert.equal(verificationTarget?.source, 'changed_files');
  assert.deepEqual(verificationTarget?.referencedAreas, []);
  assert.deepEqual(verificationTarget?.changedFiles, ['src/lib/review-followup.ts']);
  assert.deepEqual(verificationTarget?.resolvedCommands, ['npm run test:review-followup']);
  assert.equal(verificationTarget?.unresolvedReason, null);
});

test('changed-file verification resolution derives area-based commands from changed files alone', () => {
  const verificationTarget = resolveVerificationCommandsFromChangedFiles(
    ['src/server/control-plane/control-plane-client.tsx'],
    {
      packageScripts: {
        'test:control-plane-summary-ui': 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js dist/tests/unit/control-plane-restart-ui.test.js',
      },
    }
  );

  assert.equal(verificationTarget?.source, 'changed_files');
  assert.deepEqual(verificationTarget?.referencedAreas, ['control-plane-summary-ui']);
  assert.deepEqual(verificationTarget?.changedFiles, ['src/server/control-plane/control-plane-client.tsx']);
  assert.deepEqual(verificationTarget?.resolvedCommands, ['npm run test:control-plane-summary-ui']);
  assert.equal(verificationTarget?.unresolvedReason, null);
});

test('changed-file verification resolution derives typecheck from changed config files alone', () => {
  const verificationTarget = resolveVerificationCommandsFromChangedFiles(
    ['package.json'],
    {
      packageScripts: {
        typecheck: 'tsc --noEmit',
      },
    }
  );

  assert.equal(verificationTarget?.source, 'changed_files');
  assert.deepEqual(verificationTarget?.referencedAreas, ['typecheck']);
  assert.deepEqual(verificationTarget?.changedFiles, ['package.json']);
  assert.deepEqual(verificationTarget?.resolvedCommands, ['npm run typecheck']);
  assert.equal(verificationTarget?.unresolvedReason, null);
});

test('review blocker extraction resolves a directly referenced changed file into runnable verification', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please rerun focused verification for src/autonomy-v2/commands/review-followup.ts before approval.',
  }, {
    availableTestFiles: ['tests/unit/review-followup.test.ts'],
    changedFiles: ['src/autonomy-v2/commands/review-followup.ts', 'src/autonomy-v2/commands/shared-review-blockers.ts'],
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'changed_files');
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.referencedFiles, ['src/autonomy-v2/commands/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].verificationTarget?.changedFiles, ['src/autonomy-v2/commands/review-followup.ts']);
  assert.deepEqual(reviewerBlockers[0].requiredChecks, ['npm run build && node --test dist/tests/unit/review-followup.test.js']);
  assert.equal(reviewerBlockers[0].status.unresolvedReason, null);
});

test('review blocker extraction leaves ambiguous verification requests unresolved with a clear reason', () => {
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please add focused verification before approval.',
  });

  assert.equal(reviewerBlockers[0].verificationTarget?.source, 'unresolved');
  assert.deepEqual(reviewerBlockers[0].requiredChecks, []);
  assert.match(String(reviewerBlockers[0].status.unresolvedReason || ''), /no runnable command/i);
});

test('tracked review follow-up persistence keeps structured blocker details after reload', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-followup-blockers-'));
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
  const reviewDecision = {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please add a focused verification step with `npm run test:unit -- review-followup`.',
  };
  const reviewerBlockers = buildReviewerBlockersFromReview(pr, reviewDecision);
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
    id: 'architecture-agent-followup-pr-prd-conversation-architecture-agent-2',
    title: 'Address review for Conversation continuity',
    description: reviewDecision.summary,
    type: 'review_followup',
    source: 'review_followup',
    createdAt: '2026-04-21T00:20:00.000Z',
    updatedAt: '2026-04-21T00:20:00.000Z',
    reviewerBlockers,
  });

  const worktreeQueue = JSON.parse(fs.readFileSync(path.join(worktreePath, queueRelativePath), 'utf8'));
  const reloadedFollowup = worktreeQueue.tasks.find((task) => task.id === followupTask.id);
  assert.deepEqual(reloadedFollowup.checks, ['npm run test:unit -- review-followup']);
  assert.equal(reloadedFollowup.reviewerBlockers.length, 1);
  assert.equal(reloadedFollowup.reviewerBlockers[0].category, 'verification');
  assert.deepEqual(reloadedFollowup.reviewerBlockers[0].requiredChecks, ['npm run test:unit -- review-followup']);
  assert.equal(reloadedFollowup.reviewerBlockers[0].status.state, 'open');
  assert.equal(reloadedFollowup.reviewerBlockers[0].sourceReview.reviewRound, 1);
});

test('implementation task completion blocks noop follow-up while structured blockers remain unresolved', () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-noop-blockers-'));
  const queuePath = path.join(worktreePath, queueRelativePath);
  const blockerTask = buildTask({
    type: 'review_followup',
  });
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Run `npm run test:unit -- review-followup` before approval.',
  });
  blockerTask.reviewerBlockers = reviewerBlockers;
  writeJson(queuePath, buildQueue([blockerTask]));

  assert.throws(() => {
    markImplementationTaskComplete(
      worktreePath,
      buildConfig(),
      blockerTask,
      'agent/shared/architecture-agent/prd-conversation-architecture-agent',
      'noop',
      {
        changedFiles: [],
        checkResults: [],
      }
    );
  }, /reviewer blockers remain unresolved/i);

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(queue.tasks[0].status, 'active');
  assert.equal(queue.tasks[0].state, 'active');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.state, 'open');
  assert.match(String(queue.tasks[0].lastError || ''), /structured reviewer blockers remain unresolved/i);
});

test('implementation task completion records verification evidence and satisfies blocker on noop follow-up', () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-noop-evidence-'));
  const queuePath = path.join(worktreePath, queueRelativePath);
  const blockerTask = buildTask({
    type: 'review_followup',
  });
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Run `npm run test:unit -- review-followup` before approval.',
  });
  blockerTask.reviewerBlockers = reviewerBlockers;
  writeJson(queuePath, buildQueue([blockerTask]));

  markImplementationTaskComplete(
    worktreePath,
    buildConfig(),
    blockerTask,
    'agent/shared/architecture-agent/prd-conversation-architecture-agent',
    'noop',
    {
      changedFiles: [],
      checkResults: [{
        command: 'npm run test:unit -- review-followup',
        status: 'passed',
        code: 0,
      }],
    }
  );

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(queue.tasks[0].status, 'done');
  assert.equal(queue.tasks[0].completionMode, 'noop');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.state, 'satisfied');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.satisfiedByTaskId, blockerTask.id);
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.evidence[0].kind, 'command_output');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.evidence[0].command, 'npm run test:unit -- review-followup');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.lastCheckResults[0].status, 'passed');
});

test('implementation task completion records failed derived verification runs and keeps the blocker open', () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-derived-check-failed-'));
  const queuePath = path.join(worktreePath, queueRelativePath);
  const blockerTask = buildTask({
    type: 'review_followup',
  });
  blockerTask.reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Please run `tests/unit/control-plane-summary-ui.test.ts` before approval.',
  });
  writeJson(queuePath, buildQueue([blockerTask]));

  assert.throws(() => {
    markImplementationTaskComplete(
      worktreePath,
      buildConfig(),
      blockerTask,
      'agent/shared/architecture-agent/prd-conversation-architecture-agent',
      'noop',
      {
        changedFiles: [],
        checkResults: [{
          command: 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js',
          status: 'failed',
          code: 1,
          output: 'boom',
        }],
      }
    );
  }, /reviewer blockers remain unresolved/i);

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.state, 'open');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.lastCheckResults[0].status, 'failed');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.lastCheckResults[0].command, 'npm run build && node --test dist/tests/unit/control-plane-summary-ui.test.js');
});

test('implementation task completion does not satisfy a code-change blocker with unrelated file edits', () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-code-change-unrelated-'));
  const queuePath = path.join(worktreePath, queueRelativePath);
  const blockerTask = buildTask({
    type: 'review_followup',
  });
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Fix the reviewer blocker in `src/autonomy-v2/commands/gate.ts` before approval.',
  });
  blockerTask.reviewerBlockers = reviewerBlockers;
  writeJson(queuePath, buildQueue([blockerTask]));

  assert.throws(() => {
    markImplementationTaskComplete(
      worktreePath,
      buildConfig(),
      blockerTask,
      'agent/shared/architecture-agent/prd-conversation-architecture-agent',
      'code',
      {
        changedFiles: ['src/autonomy-v2/runner/workspace.ts'],
        checkResults: [],
      }
    );
  }, /reviewer blockers remain unresolved/i);

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(queue.tasks[0].status, 'active');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.state, 'open');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.evidence[0].kind, 'code_change');
  assert.equal(
    queue.tasks[0].reviewerBlockers[0].status.evidence[0].detail,
    'Matched requested files:'
  );
});

test('implementation task completion satisfies a code-change blocker when it updates the requested file', () => {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-code-change-matched-'));
  const queuePath = path.join(worktreePath, queueRelativePath);
  const blockerTask = buildTask({
    type: 'review_followup',
  });
  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Fix the reviewer blocker in `src/autonomy-v2/commands/gate.ts` before approval.',
  });
  blockerTask.reviewerBlockers = reviewerBlockers;
  writeJson(queuePath, buildQueue([blockerTask]));

  markImplementationTaskComplete(
    worktreePath,
    buildConfig(),
    blockerTask,
    'agent/shared/architecture-agent/prd-conversation-architecture-agent',
    'code',
    {
      changedFiles: ['src/autonomy-v2/commands/gate.ts', 'src/autonomy-v2/runner/workspace.ts'],
      checkResults: [],
    }
  );

  const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  assert.equal(queue.tasks[0].status, 'done');
  assert.equal(queue.tasks[0].reviewerBlockers[0].status.state, 'satisfied');
  assert.equal(
    queue.tasks[0].reviewerBlockers[0].status.evidence[0].detail,
    'Matched requested files: src/autonomy-v2/commands/gate.ts'
  );
});

test('completed lane task snapshots preserve structured reviewer blockers for recovery', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-completed-blocker-snapshot-'));
  const blockerTask = buildTask({
    type: 'review_followup',
    source: 'review_followup',
    status: 'done',
    state: 'done',
    prId: 'pr-prd-conversation-architecture-agent',
    checks: ['npm run lint'],
  });
  blockerTask.reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Run `npm run lint` before approval.',
  });

  const completedTasks = recordLaneTaskCompletion(
    rootDir,
    blockerTask,
    'agent/shared/architecture-agent/prd-conversation-architecture-agent',
    path.join(rootDir, '.autonomy', 'worktrees', 'architecture-agent', 'shared-prd-conversation-architecture-agent'),
    { ok: true, violations: [] }
  );

  assert.equal(completedTasks.length, 1);
  assert.equal(completedTasks[0].checks[0], 'npm run lint');
  assert.equal(completedTasks[0].reviewerBlockers.length, 1);
  assert.equal(completedTasks[0].reviewerBlockers[0].requiredChecks[0], 'npm run lint');
  assert.equal(completedTasks[0].reviewerBlockers[0].status.state, 'open');
  assert.equal(completedTasks[0].source, 'review_followup');
  assert.equal(completedTasks[0].prId, 'pr-prd-conversation-architecture-agent');
});

test('review:record can dismiss reviewer blockers by policy and persists the dismissal to tracked tasks', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-policy-dismissal-'));
  const agentsPath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json');
  const sprintPath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'sprint.json');
  const prsPath = path.join(rootDir, '.autonomy', 'runtime', 'state', 'prs.json');
  const branchLocksPath = path.join(rootDir, '.autonomy', 'runtime', 'state', 'branch-locks.json');
  const worktreePath = path.join(rootDir, '.autonomy', 'worktrees', 'architecture-agent', 'shared-prd-conversation-architecture-agent');
  const implementationQueuePath = path.join(worktreePath, queueRelativePath);
  const reviewerQueuePath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'reviewer.json');

  git(rootDir, ['init', '-b', 'dev']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);
  writeJson(agentsPath, buildConfig());
  writeJson(sprintPath, { sprintId: 'shared', name: 'Shared Sprint' });

  const reviewerBlockers = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Run `npm run lint` before approval.',
  });
  const blockerId = reviewerBlockers[0].id;
  const followupTask = buildTask({
    id: 'architecture-agent-followup-pr-prd-conversation-architecture-agent-1',
    type: 'review_followup',
    source: 'review_followup',
    status: 'done',
    state: 'done',
    prId: 'pr-prd-conversation-architecture-agent',
    checks: ['npm run lint'],
    reviewerBlockers,
  });
  writeJson(implementationQueuePath, buildQueue([followupTask]));
  writeJson(reviewerQueuePath, {
    agentId: 'reviewer',
    role: AGENT_ROLES.REVIEW,
    tasks: [{
      id: 'review-pr-prd-conversation-architecture-agent',
      title: 'Review conversation continuity',
      description: 'Review the follow-up.',
      agentId: 'reviewer',
      type: 'review',
      prId: 'pr-prd-conversation-architecture-agent',
      sourceTaskId: followupTask.id,
      sourceAgentId: 'architecture-agent',
      reviewRound: 2,
      status: 'queued',
      createdAt: '2026-04-21T00:30:00.000Z',
      updatedAt: '2026-04-21T00:30:00.000Z',
    }],
  });
  writeJson(prsPath, {
    pullRequests: [buildPr({
      taskId: followupTask.id,
      taskIds: [followupTask.id],
      pendingTaskIds: [],
      completedTaskIds: [followupTask.id],
      checks: ['npm run lint'],
      reviewerBlockers,
    })],
  });
  writeJson(branchLocksPath, {
    locks: [{
      taskId: followupTask.id,
      laneKey: followupTask.laneKey,
      agentId: followupTask.agentId,
      branch: 'agent/shared/architecture-agent/prd-conversation-architecture-agent',
      worktreePath,
      completedTasks: [followupTask],
      updatedAt: '2026-04-21T00:30:00.000Z',
    }],
  });
  git(rootDir, ['add', '.']);
  git(rootDir, ['commit', '-m', 'seed policy dismissal fixture']);

  await runGate(rootDir, {
    pr: 'pr-prd-conversation-architecture-agent',
    reviewer: 'reviewer',
    decision: 'approved',
    summary: 'Policy waived after external verification.',
    'dismiss-blocker': [blockerId],
    'dismiss-reason': 'policy-waived',
    json: true,
  });

  const prsState = JSON.parse(fs.readFileSync(prsPath, 'utf8'));
  assert.equal(prsState.pullRequests[0].status, 'approved');
  assert.equal(prsState.pullRequests[0].reviewerBlockers[0].status.state, 'dismissed');
  assert.equal(prsState.pullRequests[0].reviewerBlockers[0].status.dismissalReason, 'policy-waived');

  const trackedQueue = JSON.parse(fs.readFileSync(implementationQueuePath, 'utf8'));
  assert.equal(trackedQueue.tasks[0].reviewerBlockers[0].status.state, 'dismissed');
  assert.equal(trackedQueue.tasks[0].reviewerBlockers[0].status.dismissalReason, 'policy-waived');

  const branchLocks = JSON.parse(fs.readFileSync(branchLocksPath, 'utf8'));
  assert.equal(branchLocks.locks[0].completedTasks[0].reviewerBlockers[0].status.state, 'dismissed');
  assert.equal(branchLocks.locks[0].completedTasks[0].reviewerBlockers[0].status.dismissalReason, 'policy-waived');
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

test('reviewer auto-approval is blocked while structured reviewer blockers remain unresolved', async () => {
  const unresolvedBlocker = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Run `npm run test:unit -- review-followup` before approval.',
  });
  const { context, recordedReviews } = buildReviewRunnerContext(async () => ({
    decision: 'changes_requested',
    summary: 'Still asking for another review round.',
    concerns: ['Please revisit this once more.'],
  }), {
    prOverrides: {
      reviewerBlockers: unresolvedBlocker,
      reviews: [
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 1' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 2' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 3' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 4' },
      ],
      status: 'changes_requested',
    },
  });

  const result = await runReview(context);

  assert.equal(result.status, 'changes-requested');
  assert.equal(result.decision, 'changes-requested');
  assert.equal(recordedReviews.length, 1);
  assert.equal(recordedReviews[0].decision, 'changes-requested');
  assert.match(recordedReviews[0].summary, /structured reviewer blockers remain unresolved/i);
});

test('reviewer auto-approval can proceed when a blocker was dismissed by policy', async () => {
  const dismissedBlocker = buildReviewerBlockersFromReview({
    id: 'pr-prd-conversation-architecture-agent',
    reviews: [{ decision: 'changes_requested' }],
  }, {
    reviewerId: 'reviewer',
    decision: 'changes_requested',
    reviewedAt: '2026-04-21T00:20:00.000Z',
    summary: 'Run `npm run test:unit -- review-followup` before approval.',
  }).map((blocker) => ({
    ...blocker,
    status: {
      ...blocker.status,
      state: 'dismissed',
      dismissedAt: '2026-04-21T00:30:00.000Z',
      dismissalReason: 'policy-waived',
    },
  }));
  const { context, recordedReviews } = buildReviewRunnerContext(async () => ({
    decision: 'changes_requested',
    summary: 'Still asking for another review round.',
    concerns: ['Please revisit this once more.'],
  }), {
    prOverrides: {
      reviewerBlockers: dismissedBlocker,
      reviews: [
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 1' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 2' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 3' },
        { reviewerId: 'reviewer', decision: 'changes_requested', summary: 'Round 4' },
      ],
      status: 'changes_requested',
    },
  });

  const result = await runReview(context);

  assert.equal(result.status, 'approved');
  assert.equal(result.decision, 'approve');
  assert.equal(recordedReviews[0].decision, 'approve');
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
