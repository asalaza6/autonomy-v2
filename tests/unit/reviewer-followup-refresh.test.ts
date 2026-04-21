import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDerivedReviewerTask } from '../../src/sync/derived-pr.js';
import { reconcileReviewTaskRecord } from '../../src/sync/review-reconciliation.js';

test('derived reviewer task requeues when a completed review follow-up updates the PR after changes requested', () => {
  const now = '2026-04-07T07:13:53.000Z';
  const reviewerTask = buildDerivedReviewerTask({
    id: 'pr-mobile-size1-architecture-agent',
    taskId: 'architecture-agent-followup-pr-mobile-size1-architecture-agent-1',
    title: '[architecture-agent] Implement mobile-size1',
    headBranch: 'agent/multi-agent-mvp/architecture-agent/mobile-size1-architecture-agent',
    baseBranch: 'dev',
    acceptance: ['Task complete'],
    status: 'changes_requested',
    updatedAt: '2026-04-07T07:13:21.363Z',
    reviews: [
      {
        reviewerId: 'reviewer',
        decision: 'changes_requested',
        reviewedAt: '2026-04-07T07:11:52.503Z',
      },
    ],
    pendingTaskIds: [],
    completedTaskIds: [
      'mobile-size1-architecture-agent-1',
      'architecture-agent-followup-pr-mobile-size1-architecture-agent-1',
    ],
  } as any, {
    id: 'mobile-size1-architecture-agent-1',
    title: 'Implement mobile-size1',
    agentId: 'architecture-agent',
  } as any, now, {
    id: 'review-pr-mobile-size1-architecture-agent',
    prId: 'pr-mobile-size1-architecture-agent',
    sourceTaskId: 'architecture-agent-followup-pr-mobile-size1-architecture-agent-1',
    sourceAgentId: 'architecture-agent',
    reviewRound: 2,
    status: 'changes_requested',
    reviewedAt: '2026-04-07T07:11:52.503Z',
    lastDecision: 'changes_requested',
    updatedAt: '2026-04-07T07:11:52.503Z',
    conversationReferences: {
      'agent:reviewer': {
        conversationId: 'review-session-original',
        agentId: 'reviewer',
        role: 'review',
      },
    },
  } as any, []);

  assert.equal(reviewerTask.status, 'queued');
  assert.equal(reviewerTask.reviewRound, 2);
  assert.equal(reviewerTask.sourceTaskId, 'architecture-agent-followup-pr-mobile-size1-architecture-agent-1');
  assert.equal(reviewerTask.conversationReferences['agent:reviewer'].conversationId, 'review-session-original');
});

test('review reconciliation resolves stale changes-requested tasks when PR changes are already applied', () => {
  const now = '2026-04-21T08:00:00.000Z';
  const pr = {
    id: 'pr-prd-when-prds-run-the-d8bef0-architecture-agent',
    taskId: 'architecture-agent-followup-pr-prd-when-prds-run-the-d8bef0-architecture-agent-4',
    agentId: 'architecture-agent',
    status: 'changes_requested',
    taskIds: [
      'prd-when-prds-run-the-d8bef0-architecture-agent-1',
      'architecture-agent-followup-pr-prd-when-prds-run-the-d8bef0-architecture-agent-4',
    ],
    completedTaskIds: [
      'prd-when-prds-run-the-d8bef0-architecture-agent-1',
      'architecture-agent-followup-pr-prd-when-prds-run-the-d8bef0-architecture-agent-4',
    ],
    pendingTaskIds: [],
  } as any;
  const reviewTask = {
    id: `review-${pr.id}`,
    prId: pr.id,
    agentId: 'reviewer',
    type: 'review',
    status: 'changes_requested',
    sourceAgentId: 'architecture-agent',
    sourceTaskId: 'architecture-agent-followup-pr-prd-when-prds-run-the-d8bef0-architecture-agent-4',
    lastDecision: 'approved',
    lastMergeFailureMessage: 'Merge blocked.',
  } as any;
  const reconciled = reconcileReviewTaskRecord(reviewTask, {
    pullRequestsById: new Map([[pr.id, pr]]),
    implementationTasks: [
      {
        id: 'prd-when-prds-run-the-d8bef0-architecture-agent-1',
        agentId: 'architecture-agent',
        status: 'done',
      },
      {
        id: 'architecture-agent-followup-pr-prd-when-prds-run-the-d8bef0-architecture-agent-4',
        agentId: 'architecture-agent',
        status: 'done',
        prId: pr.id,
      },
    ] as any[],
    now,
  });

  assert.equal(reconciled.status, 'merged');
  assert.equal(reconciled.mergedAt, now);
  assert.equal(reconciled.lastMergeFailureMessage, undefined);
});

test('review reconciliation preserves actionable changes-requested follow-up work', () => {
  const now = '2026-04-21T08:00:00.000Z';
  const pr = {
    id: 'pr-open-review-followup',
    taskId: 'architecture-agent-followup-pr-open-review-followup-1',
    agentId: 'architecture-agent',
    status: 'changes_requested',
    pendingTaskIds: ['architecture-agent-followup-pr-open-review-followup-1'],
    completedTaskIds: ['prd-open-review-followup-architecture-agent-1'],
    remote: {
      state: 'open',
    },
  } as any;
  const reviewTask = {
    id: `review-${pr.id}`,
    prId: pr.id,
    agentId: 'reviewer',
    type: 'review',
    status: 'changes_requested',
    sourceAgentId: 'architecture-agent',
    sourceTaskId: 'architecture-agent-followup-pr-open-review-followup-1',
  } as any;
  const reconciled = reconcileReviewTaskRecord(reviewTask, {
    pullRequestsById: new Map([[pr.id, pr]]),
    implementationTasks: [
      {
        id: 'architecture-agent-followup-pr-open-review-followup-1',
        agentId: 'architecture-agent',
        status: 'queued',
        prId: pr.id,
      },
    ] as any[],
    now,
  });

  assert.equal(reconciled.status, 'changes_requested');
  assert.equal(reconciled.mergedAt, undefined);
});
