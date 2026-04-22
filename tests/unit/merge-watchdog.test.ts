import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  approvedPullRequestIsDue,
  buildUnreviewedHeadMergeDiagnosis,
  classifyMergeFailureMessage,
  formatMergeFailureReason,
  reviewedCommitCountCoversPullRequestHead,
  runApprovedPrMergeWatchdog,
  selectApprovedMergeWatchdogCandidate,
  shouldRetryApprovedPrMerge,
} from '../../src/autonomy-v2/commands/merge-watchdog.js';
import { evaluateMerge } from '../../src/autonomy-v2/commands/shared-repo.js';
import { getAutonomyPaths, readJson, writeJson } from '../../src/autonomy-v2/commands/shared-core.js';
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

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createWatchdogRepo(pr: any, reviewTask: any) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-merge-watchdog-'));
  git(rootDir, ['init', '-b', 'dev']);
  git(rootDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(rootDir, ['config', 'user.name', 'Autonomy Test']);

  const paths = getAutonomyPaths(rootDir);
  const implementationQueuePath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'queues', 'architecture-agent.json');
  const reviewerQueueRelativePath = 'prompts/autonomous/v2/queues/reviewer.json';
  const reviewerQueuePath = path.join(rootDir, reviewerQueueRelativePath);
  const gitIdentity = {
    name: 'Autonomy Test',
    email: 'autonomy-test@example.com',
  };
  writeJson(paths.agentsConfig, {
    schemaVersion: 1,
    integrationBranch: 'dev',
    agents: [
      {
        id: 'architecture-agent',
        role: 'implementation',
        systemPrompt: 'Architecture agent',
        gitIdentity,
        taskQueue: 'prompts/autonomous/v2/queues/architecture-agent.json',
        checks: ['npm run typecheck'],
      },
      {
        id: 'reviewer',
        role: 'review',
        systemPrompt: 'Reviewer agent',
        gitIdentity,
        taskQueue: reviewerQueueRelativePath,
      },
    ],
  });
  writeJson(paths.sprintConfig, { sprintId: 'test' });
  writeJson(implementationQueuePath, {
    schemaVersion: 1,
    agentId: 'architecture-agent',
    role: 'implementation',
    tasks: [],
  });
  writeJson(reviewerQueuePath, {
    agentId: 'reviewer',
    role: 'review',
    tasks: [reviewTask],
  });
  writeJson(paths.prsState, { pullRequests: [pr] });
  writeJson(paths.branchLocksState, { locks: [] });

  git(rootDir, ['add', 'prompts']);
  git(rootDir, ['commit', '-m', 'seed autonomy state']);
  return { rootDir, paths, reviewerQueueRelativePath };
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
  assert.equal(diagnosis?.requeueReview, true);
  assert.match(diagnosis?.reason || '', /review must cover the latest head before merge/);
});

test('approved PR merge watchdog requeues stale approved heads before automatic merge', () => {
  const pr = buildApprovedPr({
    commitCount: 3,
    remote: null,
  });
  const reviewTask = buildApprovedReviewTask({
    reviewRound: 1,
    reviewedCommitCount: 2,
  });
  const { rootDir, paths, reviewerQueueRelativePath } = createWatchdogRepo(pr, reviewTask);

  const result = runApprovedPrMergeWatchdog(rootDir, {
    now: '2026-04-22T00:01:00.000Z',
    timeoutMs: 0,
    retryMs: 0,
  }) as any;

  assert.equal(result.merged, false);
  assert.equal(result.diagnosis.code, 'unreviewed_head');
  assert.equal(result.diagnosis.commitCount, 3);
  assert.equal(result.diagnosis.reviewedCommitCount, 2);

  const persistedPrs = readJson(paths.prsState) as any;
  const persistedPr = persistedPrs.pullRequests[0];
  assert.equal(persistedPr.mergeState, 'blocked');
  assert.equal(persistedPr.mergeBlockedCode, 'unreviewed_head');
  assert.match(persistedPr.mergeBlockedReason, /approval reviewed 2/);

  const reviewerQueue = JSON.parse(git(rootDir, ['show', `dev:${reviewerQueueRelativePath}`]));
  const persistedReviewTask = reviewerQueue.tasks[0];
  assert.equal(persistedReviewTask.status, 'queued');
  assert.equal(persistedReviewTask.reviewRound, 2);
  assert.equal(persistedReviewTask.lastMergeFailureCode, 'unreviewed_head');
  assert.match(persistedReviewTask.lastMergeFailureMessage, /approval reviewed 2/);
});

test('approved PR merge watchdog records in-flight attempts before merge execution', () => {
  const pr = buildApprovedPr({
    commitCount: 1,
    remote: null,
  });
  const reviewTask = buildApprovedReviewTask({
    reviewedCommitCount: 1,
  });
  const { rootDir, paths } = createWatchdogRepo(pr, reviewTask);
  let attempts = 0;
  let duplicateRun: any = null;

  const result = runApprovedPrMergeWatchdog(rootDir, {
    now: '2026-04-22T00:01:00.000Z',
    timeoutMs: 0,
    retryMs: 0,
    inFlightLeaseMs: 60_000,
    attemptMerge: () => {
      attempts += 1;
      const persistedDuringAttempt = readJson(paths.prsState) as any;
      assert.equal(
        persistedDuringAttempt.pullRequests[0].mergeWatchdog.inFlightAttemptKey,
        'pr-approved-merge-watchdog:1:local_merge_ready'
      );

      duplicateRun = runApprovedPrMergeWatchdog(rootDir, {
        now: '2026-04-22T00:01:00.000Z',
        timeoutMs: 0,
        retryMs: 0,
        inFlightLeaseMs: 60_000,
        attemptMerge: () => {
          attempts += 1;
          return { merged: false, message: 'duplicate attempt', code: 'merge_rejected' };
        },
      }) as any;

      return {
        merged: false,
        message: 'Required status check "typecheck" is expected.',
        code: 'pending_checks',
      };
    },
  }) as any;

  assert.equal(attempts, 1);
  assert.equal(duplicateRun?.checked, 1);
  assert.equal(duplicateRun?.merged, false);
  assert.equal(result.diagnosis.code, 'pending_checks');

  const persistedPrs = readJson(paths.prsState) as any;
  const persistedPr = persistedPrs.pullRequests[0];
  assert.equal(persistedPr.mergeBlockedCode, 'pending_checks');
  assert.equal(persistedPr.mergeWatchdog.lastAttemptKey, 'pr-approved-merge-watchdog:1:local_merge_ready');
  assert.equal(persistedPr.mergeWatchdog.inFlightAttemptKey, undefined);
});

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
  assert.equal(
    classifyMergeFailureMessage('PR head has 3 commits, but approval reviewed 2; review must cover the latest head before merge'),
    'unreviewed_head'
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
