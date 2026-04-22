import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approvedPullRequestIsDue,
  buildUnreviewedHeadMergeDiagnosis,
  classifyMergeFailureMessage,
  formatMergeFailureReason,
  reviewedCommitCountCoversPullRequestHead,
  selectApprovedMergeWatchdogCandidate,
  shouldRetryApprovedPrMerge,
} from '../../src/autonomy-v2/commands/merge-watchdog.js';
import {
  buildPullRequestStatusSummaries,
  formatPullRequestStatusLine,
} from '../../src/autonomy-v2/commands/shared-pr-status.js';

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

test('approved PR merge watchdog waits for approval timeout and retry windows', () => {
  const pr = buildApprovedPr();
  const reviewTask = buildApprovedReviewTask();

  assert.equal(
    approvedPullRequestIsDue(pr, reviewTask, '2026-04-22T00:00:20.000Z', 30_000, 60_000),
    false
  );
  assert.equal(
    approvedPullRequestIsDue(pr, reviewTask, '2026-04-22T00:00:31.000Z', 30_000, 60_000),
    true
  );

  pr.mergeWatchdog = {
    lastCheckedAt: '2026-04-22T00:00:40.000Z',
  };
  assert.equal(
    approvedPullRequestIsDue(pr, reviewTask, '2026-04-22T00:01:20.000Z', 30_000, 60_000),
    false
  );
  assert.equal(
    approvedPullRequestIsDue(pr, reviewTask, '2026-04-22T00:01:41.000Z', 30_000, 60_000),
    true
  );
});

test('approved PR merge watchdog selects the oldest due approved PR', () => {
  const newerPr = buildApprovedPr({
    id: 'pr-newer',
    updatedAt: '2026-04-22T00:05:00.000Z',
    reviews: [{ decision: 'approved', reviewedAt: '2026-04-22T00:05:00.000Z' }],
  });
  const olderPr = buildApprovedPr({
    id: 'pr-older',
    updatedAt: '2026-04-22T00:01:00.000Z',
    reviews: [{ decision: 'approved', reviewedAt: '2026-04-22T00:01:00.000Z' }],
  });

  const candidate = selectApprovedMergeWatchdogCandidate({
    pullRequests: [newerPr, olderPr],
    reviewTasks: [
      buildApprovedReviewTask({ prId: 'pr-newer' }),
      buildApprovedReviewTask({ prId: 'pr-older' }),
    ],
    now: '2026-04-22T00:06:00.000Z',
    timeoutMs: 30_000,
    retryMs: 60_000,
  });

  assert.equal(candidate.pr.id, 'pr-older');
});

test('approved PR merge watchdog blocks heads that changed after approval', () => {
  const pr = buildApprovedPr({
    commitCount: 2,
    remote: {
      number: 17,
      state: 'open',
      url: 'https://github.com/asalaza6/autonomy-v2/pull/17',
      commitCount: 3,
      sha: 'head-after-approval',
    },
  });
  const reviewTask = buildApprovedReviewTask({ reviewedCommitCount: 2 });

  assert.equal(reviewedCommitCountCoversPullRequestHead(pr, reviewTask), false);
  assert.equal(shouldRetryApprovedPrMerge(pr, reviewTask), false);

  const diagnosis = buildUnreviewedHeadMergeDiagnosis(pr, reviewTask, {
    canMerge: true,
    headSha: 'head-after-approval',
  });

  assert.equal(diagnosis?.mergeState, 'blocked');
  assert.equal(diagnosis?.canMerge, false);
  assert.equal(diagnosis?.code, 'unreviewed_head');
  assert.equal(diagnosis?.headSha, 'head-after-approval');
  assert.match(diagnosis?.reason || '', /review must cover the latest head before merge/);
});

test('merge failure classifier identifies specific blocked and waiting reasons', () => {
  assert.equal(classifyMergeFailureMessage('Merge conflict in package.json'), 'conflicts');
  assert.equal(classifyMergeFailureMessage('Required status check "typecheck" is expected.'), 'pending_checks');
  assert.equal(classifyMergeFailureMessage('Required status check "typecheck" failed.'), 'failed_checks');
  assert.equal(classifyMergeFailureMessage('Base branch was modified. Review and try again.'), 'stale_branch');
  assert.equal(classifyMergeFailureMessage('Protected branch update failed for refs/heads/dev.'), 'branch_protection');
  assert.equal(
    formatMergeFailureReason('conflicts', 'remote rejected the merge'),
    'merge conflicts block this PR'
  );
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
