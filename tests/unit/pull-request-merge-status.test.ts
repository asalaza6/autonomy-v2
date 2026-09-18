import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMerge } from '../../src/autonomy-v2/commands/shared-repo.js';
import { buildPullRequestStatusSummaries, formatPullRequestStatusLine } from '../../src/autonomy-v2/commands/shared-pr-status.js';

function buildApprovedPr(overrides = {}) {
  return {
    id: 'pr-approved-merge-watchdog',
    taskId: 'task-approved-merge-watchdog',
    agentId: 'architecture-agent',
    status: 'approved',
    title: 'Approved merge watchdog',
    headBranch: 'agent/watchdog',
    baseBranch: 'dev',
    reviews: [
      {
        reviewerId: 'reviewer',
        decision: 'approved',
        reviewedAt: '2026-04-22T00:00:00.000Z',
      },
    ],
    updatedAt: '2026-04-22T00:00:00.000Z',
    remote: {
      number: 17,
      state: 'open',
      url: 'https://github.com/asalaza6/autonomy-v2/pull/17',
    },
    ...overrides,
  } as any;
}

function buildApprovedReviewTask(overrides = {}) {
  return {
    id: 'review-pr-approved-merge-watchdog',
    prId: 'pr-approved-merge-watchdog',
    agentId: 'reviewer',
    type: 'review',
    status: 'approved',
    lastDecision: 'approved',
    reviewedAt: '2026-04-22T00:00:00.000Z',
    updatedAt: '2026-04-22T00:00:00.000Z',
    ...overrides,
  } as any;
}

test('merge evaluation blocks approved PRs beyond the reviewed commit count', () => {
  const pr = buildApprovedPr({
    commitCount: 3,
    remote: {
      number: 17,
      state: 'open',
      url: 'https://github.com/asalaza6/autonomy-v2/pull/17',
      commitCount: 3,
      sha: 'head-after-approval',
    },
  });
  const reviewerTask = buildApprovedReviewTask({ reviewedCommitCount: 2 });

  const evaluation = evaluateMerge({
    config: {
      integrationBranch: 'dev',
      blockedBranches: [],
      mergeActors: ['reviewer'],
      mergeStrategy: 'merge',
    },
    pr,
    actor: { id: 'reviewer', role: 'review' },
    reviewerTask,
  }) as any;

  assert.equal(evaluation.ok, false);
  assert.match(evaluation.reasons.join('\n'), /approval reviewed 2/);
  assert.match(evaluation.reasons.join('\n'), /latest head before merge/);
});

test('pull request status summaries distinguish review, waiting merge, and blocked merge states', () => {
  const taskQueues = {
    reviewer: {
      agentId: 'reviewer',
      role: 'review',
      tasks: [
        buildApprovedReviewTask({ prId: 'pr-review-active', status: 'queued', lastDecision: undefined }),
        buildApprovedReviewTask({ prId: 'pr-approved-waiting' }),
        buildApprovedReviewTask({
          prId: 'pr-blocked',
          lastMergeFailureCode: 'failed_checks',
          lastMergeFailureMessage: 'failed checks: npm run typecheck',
        }),
      ],
    },
  } as any;
  const prs = {
    pullRequests: [
      buildApprovedPr({ id: 'pr-review-active', status: 'open' }),
      buildApprovedPr({ id: 'pr-approved-waiting', mergeState: 'waiting' }),
      buildApprovedPr({
        id: 'pr-blocked',
        mergeState: 'blocked',
        mergeBlockedCode: 'failed_checks',
        mergeBlockedReason: 'failed checks: npm run typecheck',
      }),
    ],
  } as any;

  const summaries = buildPullRequestStatusSummaries({
    taskQueues,
    prs,
    runtime: { workers: {} },
    branchLocks: { locks: [] },
  }) as any[];
  const byId = new Map<string, any>(summaries.map((summary) => [summary.prId, summary]));

  assert.equal(byId.get('pr-review-active')?.statusLabel, 'review active');
  assert.equal(byId.get('pr-approved-waiting')?.statusLabel, 'approved waiting merge');
  assert.equal(byId.get('pr-blocked')?.statusLabel, 'blocked from merge');
  assert.match(byId.get('pr-blocked')?.action || '', /failed checks: npm run typecheck/);
  assert.match(formatPullRequestStatusLine(byId.get('pr-blocked')), /blocked from merge/);
});
