import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildControlPlaneDashboard } from '../../src/server/control-plane/control-plane-dashboard.js';
import { createFixtureRepo, git, initAutonomyRepo } from '../smoke/package-smoke.helpers.js';

test('control plane dashboard summarizes active PRDs, queued PRDs, agents, and jobs in plain language', () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-dashboard-');
  initAutonomyRepo(repoDir);
  fs.mkdirSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json'), JSON.stringify({
    schemaVersion: 1,
    repos: [
      {
        id: 'default',
        label: 'Current workspace',
        default: true,
        deploymentUrl: 'https://deploy.example.com',
        deploymentLabel: 'Production site',
      },
    ],
  }, null, 2));

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
        type: 'deploy',
        repoId: 'default',
        payload: {
          repoId: 'default',
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
          deployment: {
            sourceBranch: 'dev',
            targetBranch: 'main',
            sourceAheadBy: 2,
            targetAheadBy: 0,
            branchesAligned: false,
            hasChanges: true,
            deployable: true,
            status: 'pending',
            statusLabel: 'Deploy available',
            detail: 'dev is 2 commits ahead of main',
          },
          branchLockCount: 1,
        },
      },
    },
  } as any);

  assert.equal(dashboard.repoCount, 1);
  assert.equal(dashboard.activePrdCount, 1);
  assert.equal(dashboard.queuedPrdCount, 1);
  assert.equal(dashboard.deployableRepoCount, 1);
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
  assert.equal(dashboard.repos[0].deployment.statusLabel, 'Deploy available');
  assert.equal(dashboard.repos[0].deploymentUrl, 'https://deploy.example.com');
  assert.equal(dashboard.repos[0].deployJob.title, 'Deploy dev to main');
  assert.equal(dashboard.jobs[0].statusLabel, 'Waiting to be claimed');
  assert.match(dashboard.jobs[0].detail, /created/);
});

test('control plane dashboard backfills deployment status when the stored snapshot is stale', () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-dashboard-backfill-');
  initAutonomyRepo(repoDir);

  git(repoDir, ['checkout', 'dev']);
  fs.writeFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'deploy.js'), 'export const deployed = true;\n', 'utf8');
  git(repoDir, ['add', 'src/apps/fixture/deploy.js']);
  git(repoDir, ['commit', '-m', 'advance dev']);

  fs.mkdirSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json'), JSON.stringify({
    schemaVersion: 1,
    repos: [
      {
        id: 'default',
        label: 'Current workspace',
        default: true,
        deploymentUrl: 'https://deploy.example.com',
        deploymentLabel: 'Production site',
      },
    ],
  }, null, 2));

  const dashboard = buildControlPlaneDashboard(repoDir, {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [],
    repoStatuses: {
      default: {
        repoId: 'default',
        updatedAt: new Date(Date.now() - 20000).toISOString(),
        snapshot: {
          prds: { prds: [] },
          agentStatuses: [],
          pullRequestStatuses: [],
          branchLockCount: 0,
        },
      },
    },
  } as any);

  assert.equal(dashboard.deployableRepoCount, 1);
  assert.equal(dashboard.repos[0].deployment.statusLabel, 'Deploy available');
  assert.match(dashboard.repos[0].overview, /Deploy: Deploy available/);
});
