import test from 'node:test';
import assert from 'node:assert/strict';

import { buildControlPlaneDashboard } from '../../src/server/control-plane/control-plane-dashboard.js';
import { createFixtureRepo, initAutonomyRepo } from '../smoke/package-smoke.helpers.js';

test('control plane dashboard summarizes active PRDs, queued PRDs, agents, and jobs in plain language', () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-dashboard-');
  initAutonomyRepo(repoDir);

  const dashboard = buildControlPlaneDashboard(repoDir, {
    schemaVersion: 1,
    heartbeats: {
      server: {
        kind: 'server',
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      },
      bridge: {
        kind: 'bridge',
        updatedAt: new Date(Date.now() - 20000).toISOString(),
      },
    },
    jobs: [
      {
        id: 'job-001',
        type: 'prd:add',
        repoId: 'default',
        payload: {
          repoId: 'default',
          id: 'prd-bridge-001',
          title: 'Bridge job PRD',
          specification: 'Queued from the control plane.',
          requirements: [],
          taskSpecs: [],
        },
        status: 'queued',
        createdAt: '2026-04-01T12:00:00.000Z',
        updatedAt: '2026-04-01T12:00:00.000Z',
      },
    ],
    repoStatuses: {
      default: {
        repoId: 'default',
        updatedAt: new Date(Date.now() - 20000).toISOString(),
        snapshot: {
          prds: {
            prds: [
              {
                id: 'prd-active-001',
                title: 'Active PRD',
                status: 'planned',
                isQueued: false,
                requirements: ['one', 'two'],
                plannedTaskIds: ['task-1'],
                updatedAt: '2026-04-01T12:08:00.000Z',
              },
              {
                id: 'prd-queued-001',
                title: 'Queued PRD',
                status: 'queued',
                isQueued: true,
                requirements: ['one'],
                updatedAt: '2026-04-01T12:09:00.000Z',
              },
            ],
          },
          agentStatuses: [
            {
              agentId: 'planner',
              role: 'pm',
              workerStatus: 'running',
              pid: 1234,
              detail: 'planning backlog (1 PRD awaiting planning)',
            },
            {
              agentId: 'builder',
              role: 'implementation',
              workerStatus: 'idle',
              pid: null,
              detail: 'next task task "Build" (task-1)',
            },
          ],
          pullRequestStatuses: [
            {
              prId: 'pr-1',
              number: 7,
              title: 'Feature PR',
              status: 'open',
              action: 'waiting for reviewer',
              branch: 'dev',
              updatedAt: '2026-04-01T12:05:00.000Z',
            },
          ],
          branchLockCount: 1,
        },
      },
    },
  } as any);

  assert.equal(dashboard.repoCount, 1);
  assert.equal(dashboard.activePrdCount, 1);
  assert.equal(dashboard.queuedPrdCount, 1);
  assert.equal(dashboard.pendingJobCount, 1);
  assert.equal(dashboard.overallHeartbeatStatus, 'stale');
  assert.equal(dashboard.serverHeartbeat.status, 'online');
  assert.equal(dashboard.bridgeHeartbeat.status, 'stale');
  assert.match(dashboard.repos[0].overview, /Active PRD/);
  assert.match(dashboard.repos[0].overview, /queued PRD/i);
  assert.equal(dashboard.repos[0].activePrd.title, 'Active PRD');
  assert.equal(dashboard.repos[0].queuedPrds[0].title, 'Queued PRD');
  assert.equal(dashboard.repos[0].freshnessStatus, 'stale');
  assert.match(dashboard.repos[0].agentStatuses[0].detail, /planning backlog/);
  assert.equal(dashboard.jobs[0].statusLabel, 'Waiting to be claimed');
  assert.match(dashboard.jobs[0].detail, /created/);
});
