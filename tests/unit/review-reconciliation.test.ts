import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPullRequestStatusSummaries } from '../../src/autonomy-v2/commands/shared-pr-status.js';
import { getPullRequestStateReconciliation, reconcilePullRequestRecord } from '../../src/sync/review-reconciliation.js';

test('remote open PR remains canonical open when linked local tasks are terminal', () => {
  const implementationTasks = [
    {
      id: 'task-1',
      prId: 'pr-1',
      prdId: 'prd-1',
      agentId: 'architecture-agent',
      status: 'done',
    },
  ];
  const pr = reconcilePullRequestRecord({
    id: 'pr-1',
    prdId: 'prd-1',
    agentId: 'architecture-agent',
    status: 'changes_requested',
    taskIds: ['task-1'],
    completedTaskIds: ['task-1'],
    pendingTaskIds: [],
    updatedAt: '2026-04-26T10:00:00.000Z',
    remote: {
      number: 28,
      url: 'https://github.com/example/repo/pull/28',
      state: 'open',
    },
  }, implementationTasks, '2026-04-26T10:05:00.000Z');

  assert.equal(pr.status, 'changes_requested');
  assert.equal(pr.reconciliation.canonicalState, 'open');
  assert.equal(pr.reconciliation.canonicalSource, 'remote');
  assert.equal(pr.reconciliation.inferredState, 'merged');
  assert.equal(pr.reconciliation.reconciliationStatus, 'stale');

  const summaries = buildPullRequestStatusSummaries({
    taskQueues: {
      'architecture-agent': {
        agentId: 'architecture-agent',
        role: 'implementation',
        tasks: implementationTasks,
      },
    },
    prs: { pullRequests: [pr] },
    runtime: { workers: {} },
    branchLocks: { locks: [] },
  }) as any[];

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].number, 28);
  assert.equal(summaries[0].canonicalState, 'open');
  assert.equal(summaries[0].reconciliationStatus, 'stale');
});

test('remote closed PR is canonical closed', () => {
  const reconciled = reconcilePullRequestRecord({
    id: 'pr-closed',
    status: 'open',
    remote: {
      number: 12,
      state: 'closed',
      url: 'https://github.com/example/repo/pull/12',
    },
  }, [], '2026-04-26T10:05:00.000Z');

  assert.equal(reconciled.status, 'closed');
  assert.equal(reconciled.reconciliation.canonicalState, 'closed');
  assert.equal(reconciled.reconciliation.canonicalSource, 'remote');
});

test('remote merged PR is canonical merged', () => {
  const reconciled = reconcilePullRequestRecord({
    id: 'pr-merged',
    status: 'approved',
    remote: {
      number: 13,
      state: 'closed',
      mergedAt: '2026-04-26T10:03:00.000Z',
      url: 'https://github.com/example/repo/pull/13',
    },
  }, [], '2026-04-26T10:05:00.000Z');

  assert.equal(reconciled.status, 'merged');
  assert.equal(reconciled.mergedAt, '2026-04-26T10:03:00.000Z');
  assert.equal(reconciled.reconciliation.canonicalState, 'merged');
  assert.equal(reconciled.reconciliation.canonicalSource, 'remote');
});

test('missing canonical remote state for a known GitHub PR surfaces validation error instead of inferred merged', () => {
  const pr = {
    id: 'pr-inferred',
    status: 'changes_requested',
    taskIds: ['task-1'],
    completedTaskIds: ['task-1'],
    pendingTaskIds: [],
    remote: {
      number: 41,
      url: 'https://github.com/example/repo/pull/41',
    },
  };
  const implementationTasks = [
    {
      id: 'task-1',
      prId: 'pr-inferred',
      prdId: 'prd-1',
      agentId: 'architecture-agent',
      status: 'done',
    },
  ];

  const reconciliation = getPullRequestStateReconciliation(pr, implementationTasks);
  const reconciled = reconcilePullRequestRecord(pr, implementationTasks, '2026-04-26T10:05:00.000Z');

  assert.equal(reconciliation.canonicalState, 'validation-error');
  assert.equal(reconciliation.canonicalSource, 'validation');
  assert.equal(reconciliation.reconciliationStatus, 'validation-error');
  assert.equal(reconciliation.inferredState, 'merged');
  assert.equal(reconciled.status, 'validation_error');
});
