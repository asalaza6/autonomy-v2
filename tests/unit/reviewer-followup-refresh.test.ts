import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDerivedReviewerTask } from '../../src/sync/derived-pr.js';

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
  } as any, []);

  assert.equal(reviewerTask.status, 'queued');
  assert.equal(reviewerTask.reviewRound, 2);
  assert.equal(reviewerTask.sourceTaskId, 'architecture-agent-followup-pr-mobile-size1-architecture-agent-1');
});
