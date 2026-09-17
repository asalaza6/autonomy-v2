import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { executePrdPriorityUpdate, executePrdReset } from '../../src/autonomy-v2/control-plane/prd-service.js';
import { buildStatusSnapshot } from '../../src/autonomy-v2/control-plane/status-service.js';
import {
  addPrdWithTasks,
  createFixtureRepo,
  getAutonomyPathsForTest,
  git,
  initAutonomyRepo,
  readGitJson,
} from '../smoke/package-smoke.helpers.js';

test('reset archives the active PRD and clears repo-local autonomy state', () => {
  const repoDir = createFixtureRepo('autonomy-v2-prd-reset-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'init autonomy fixture']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);

  const task = {
    id: 'prd-reset-001-architecture-agent-1',
    title: 'Build reset flow',
    agentId: 'architecture-agent',
    acceptance: ['Reset flow is complete.'],
  };
  addPrdWithTasks(repoDir, 'prd-reset-001', 'Resettable PRD', [task]);
  git(repoDir, ['checkout', 'dev']);

  const reviewerQueuePath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'queues', 'reviewer.json');
  const reviewerQueue = { agentId: 'reviewer', role: 'review', tasks: [] };
  fs.mkdirSync(path.dirname(reviewerQueuePath), { recursive: true });
  reviewerQueue.tasks.push({
    id: 'review-prd-reset-001',
    title: 'Review reset flow',
    agentId: 'reviewer',
    sourceTaskId: task.id,
    prdId: 'prd-reset-001',
    prId: 'pr-prd-reset-001',
    status: 'queued',
    createdAt: '2026-04-26T08:00:00.000Z',
    updatedAt: '2026-04-26T08:00:00.000Z',
  });
  fs.writeFileSync(reviewerQueuePath, `${JSON.stringify(reviewerQueue, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'prompts/autonomous/v2/queues/reviewer.json']);
  git(repoDir, ['commit', '-m', 'add reviewer task for reset']);

  const prdStatePath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'specs', 'prd-state', 'prd-reset-001.json');
  fs.writeFileSync(prdStatePath, `${JSON.stringify({
    schemaVersion: 1,
    prdId: 'prd-reset-001',
    status: 'planned',
    plannedTaskIds: [task.id],
    createdAt: '2026-04-26T08:00:00.000Z',
    updatedAt: '2026-04-26T08:00:00.000Z',
  }, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'prompts/autonomous/v2/specs/prd-state/prd-reset-001.json']);
  git(repoDir, ['commit', '-m', 'add prd state for reset']);

  const runtimePaths = getAutonomyPathsForTest(repoDir);
  fs.writeFileSync(runtimePaths.prsState, `${JSON.stringify({
    pullRequests: [
      {
        id: 'pr-prd-reset-001',
        taskId: task.id,
        agentId: 'architecture-agent',
        laneKey: 'prd-reset-001:architecture-agent',
        prdId: 'prd-reset-001',
        status: 'open',
      },
    ],
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(runtimePaths.branchLocksState, `${JSON.stringify({
    locks: [
      {
        taskId: task.id,
        laneKey: 'prd-reset-001:architecture-agent',
        prdId: 'prd-reset-001',
        agentId: 'architecture-agent',
        branch: 'agent/reset',
        worktreePath: '/tmp/reset-worktree',
        updatedAt: '2026-04-26T08:00:00.000Z',
      },
    ],
  }, null, 2)}\n`, 'utf8');
  const runtimeStatePath = path.join(repoDir, '.autonomy', 'runtime', 'state', 'runtime.json');
  fs.writeFileSync(runtimeStatePath, `${JSON.stringify({
    workers: {
      'architecture-agent': {
        agentId: 'architecture-agent',
        status: 'running',
        pid: 999999,
      },
      reviewer: {
        agentId: 'reviewer',
        status: 'running',
        pid: 999998,
      },
    },
  }, null, 2)}\n`, 'utf8');

  const result: any = executePrdReset(repoDir, {
    'confirm-prd-id': 'prd-reset-001',
    reason: 'Manager aborted the run.',
  });

  assert.equal(result.noop, false);
  assert.equal(result.prdId, 'prd-reset-001');
  assert.equal(result.reason, 'Manager aborted the run.');
  assert.equal(typeof result.commitSha, 'string');

  assert.throws(() => git(repoDir, ['show', 'dev:prompts/autonomous/v2/specs/prds/prd-reset-001.json']));
  const archivedPrd = readGitJson(repoDir, 'dev:prompts/autonomous/v2/specs/prds/archived/prd-reset-001.json');
  assert.equal(archivedPrd.archive.kind, 'reset');
  assert.equal(archivedPrd.archive.status, 'abandoned');
  assert.equal(archivedPrd.archive.reason, 'Manager aborted the run.');

  const architectureQueue = readGitJson(repoDir, 'dev:prompts/autonomous/v2/queues/architecture-agent.json');
  const reviewerQueueAfter = readGitJson(repoDir, 'dev:prompts/autonomous/v2/queues/reviewer.json');
  assert.equal(architectureQueue.tasks.some((entry: any) => entry.prdId === 'prd-reset-001'), false);
  assert.equal(reviewerQueueAfter.tasks.some((entry: any) => entry.prdId === 'prd-reset-001'), false);
  assert.equal(fs.existsSync(prdStatePath), false);

  const prsState = JSON.parse(fs.readFileSync(runtimePaths.prsState, 'utf8'));
  const branchLocksState = JSON.parse(fs.readFileSync(runtimePaths.branchLocksState, 'utf8'));
  const runtimeState = JSON.parse(fs.readFileSync(runtimeStatePath, 'utf8'));
  assert.deepEqual(prsState.pullRequests, []);
  assert.deepEqual(branchLocksState.locks, []);
  assert.equal(runtimeState.workers['architecture-agent'].status, 'idle');
  assert.equal(runtimeState.workers['architecture-agent'].pid, null);
  assert.equal(runtimeState.workers.reviewer.status, 'idle');

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.prds.prds.some((prd: any) => prd.id === 'prd-reset-001'), false);
  assert.equal(snapshot.prdHistory.prds[0].id, 'prd-reset-001');
  assert.equal(snapshot.prdHistory.prds[0].status, 'reset');
  assert.equal(snapshot.prdHistory.prds[0].archive.kind, 'reset');
});

test('reset returns a no-op result when no active PRD exists', () => {
  const repoDir = createFixtureRepo('autonomy-v2-prd-reset-noop-');
  initAutonomyRepo(repoDir);

  const result: any = executePrdReset(repoDir, {
    'confirm-prd-id': 'prd-missing',
  });

  assert.equal(result.noop, true);
  assert.match(result.message, /No active PRD exists/);
});

test('reset can remove and archive a queued PRD', () => {
  const repoDir = createFixtureRepo('autonomy-v2-prd-reset-queued-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'init autonomy fixture']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);
  git(repoDir, ['checkout', 'dev']);

  const queuedPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'queue', 'prd-queued-reset.json');
  fs.mkdirSync(path.dirname(queuedPath), { recursive: true });
  fs.writeFileSync(queuedPath, `${JSON.stringify({
    schemaVersion: 2,
    id: 'prd-queued-reset',
    title: 'Queued reset PRD',
    createdAt: '2026-04-26T08:00:00.000Z',
    priority: 'high',
    requirements: ['Queue reset can archive this PRD.'],
  }, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'prompts/autonomous/v2/specs/prds/queue/prd-queued-reset.json']);
  git(repoDir, ['commit', '-m', 'add queued prd']);

  const result: any = executePrdReset(repoDir, {
    'confirm-prd-id': 'prd-queued-reset',
    reason: 'No longer needed.',
  });

  assert.equal(result.noop, false);
  assert.equal(result.queued, true);
  assert.equal(result.prdId, 'prd-queued-reset');
  assert.throws(() => git(repoDir, ['show', 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queued-reset.json']));
  const archivedPrd = readGitJson(repoDir, 'dev:prompts/autonomous/v2/specs/prds/archived/prd-queued-reset.json');
  assert.equal(archivedPrd.archive.kind, 'reset');
  assert.equal(archivedPrd.archive.fromStatus, 'queued');
  assert.equal(archivedPrd.archive.reason, 'No longer needed.');

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.prds.prds.some((prd: any) => prd.id === 'prd-queued-reset'), false);
  assert.equal(snapshot.prdHistory.prds[0].id, 'prd-queued-reset');
  assert.equal(snapshot.prdHistory.prds[0].status, 'reset');
});

test('priority update changes a queued PRD priority', () => {
  const repoDir = createFixtureRepo('autonomy-v2-prd-priority-queued-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'init autonomy fixture']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);
  git(repoDir, ['checkout', 'dev']);

  const queuedPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'queue', 'prd-priority-update.json');
  fs.mkdirSync(path.dirname(queuedPath), { recursive: true });
  fs.writeFileSync(queuedPath, `${JSON.stringify({
    schemaVersion: 2,
    id: 'prd-priority-update',
    title: 'Priority update PRD',
    createdAt: '2026-04-26T08:00:00.000Z',
    priority: 'low',
    requirements: ['Queue priority can change.'],
  }, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'prompts/autonomous/v2/specs/prds/queue/prd-priority-update.json']);
  git(repoDir, ['commit', '-m', 'add queued prd']);

  const result = executePrdPriorityUpdate(repoDir, {
    'prd-id': 'prd-priority-update',
    priority: 'highest',
    reason: 'Customer escalation.',
  });

  assert.equal(result.prdId, 'prd-priority-update');
  assert.equal(result.previousPriority, 'low');
  assert.equal(result.priority, 'highest');
  const queuedPrd = readGitJson(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-priority-update.json');
  assert.equal(queuedPrd.priority, 'highest');
  const snapshot = buildStatusSnapshot(repoDir);
  const summarized = snapshot.prds.prds.find((prd: any) => prd.id === 'prd-priority-update');
  assert.equal(summarized.priority, 'highest');
});

test('reset targets the same planned PRD the manager shows when a newer failed PRD also exists', () => {
  const repoDir = createFixtureRepo('autonomy-v2-prd-reset-selection-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'init autonomy fixture']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);

  const task = {
    id: 'prd-reset-planned-001-architecture-agent-1',
    title: 'Build reset flow',
    agentId: 'architecture-agent',
    acceptance: ['Reset flow is complete.'],
  };
  addPrdWithTasks(repoDir, 'prd-reset-planned-001', 'Planned PRD', [task]);
  git(repoDir, ['checkout', 'dev']);

  const plannedStatePath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'specs', 'prd-state', 'prd-reset-planned-001.json');
  fs.writeFileSync(plannedStatePath, `${JSON.stringify({
    schemaVersion: 1,
    prdId: 'prd-reset-planned-001',
    status: 'planned',
    plannedTaskIds: [task.id],
    createdAt: '2026-04-26T08:00:00.000Z',
    updatedAt: '2026-04-26T08:00:00.000Z',
  }, null, 2)}\n`, 'utf8');

  const failedSpecPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'prd-reset-failed-001.json');
  fs.writeFileSync(failedSpecPath, `${JSON.stringify({
    id: 'prd-reset-failed-001',
    title: 'Failed PRD',
    createdAt: '2026-04-26T09:00:00.000Z',
    requirements: [],
    tasks: [],
  }, null, 2)}\n`, 'utf8');
  const failedStatePath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'specs', 'prd-state', 'prd-reset-failed-001.json');
  fs.writeFileSync(failedStatePath, `${JSON.stringify({
    schemaVersion: 1,
    prdId: 'prd-reset-failed-001',
    status: 'failed',
    createdAt: '2026-04-26T09:00:00.000Z',
    updatedAt: '2026-04-26T09:30:00.000Z',
    lastError: 'planning failed',
  }, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'prompts/autonomous/v2/specs/prds/prd-reset-failed-001.json', 'prompts/autonomous/v2/specs/prd-state/prd-reset-failed-001.json', 'prompts/autonomous/v2/specs/prd-state/prd-reset-planned-001.json']);
  git(repoDir, ['commit', '-m', 'add planned and failed prds for reset selection']);

  const result = executePrdReset(repoDir, {
    'confirm-prd-id': 'prd-reset-planned-001',
  });

  assert.equal(result.noop, false);
  assert.equal(result.prdId, 'prd-reset-planned-001');
  assert.throws(() => git(repoDir, ['show', 'dev:prompts/autonomous/v2/specs/prds/prd-reset-planned-001.json']));
  const archivedPlannedPrd = readGitJson(repoDir, 'dev:prompts/autonomous/v2/specs/prds/archived/prd-reset-planned-001.json');
  assert.equal(archivedPlannedPrd.archive.kind, 'reset');
  const failedPrd = readGitJson(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-reset-failed-001.json');
  assert.equal(failedPrd.id, 'prd-reset-failed-001');
});
