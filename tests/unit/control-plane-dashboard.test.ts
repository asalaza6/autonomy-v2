import test from 'node:test';
import assert from 'node:assert/strict';

import { buildControlPlaneDashboard } from '../../src/server/control-plane/control-plane-dashboard.js';

test('control plane dashboard summarizes discovered repos, jobs, and metadata in plain language', () => {
  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
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
        repoId: 'alpha',
        payload: {
          repoId: 'alpha',
        },
        status: 'queued',
        createdAt: '2026-04-01T12:00:00.000Z',
        updatedAt: '2026-04-01T12:00:00.000Z',
      },
    ],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        description: 'Primary app',
        deploymentUrl: 'https://deploy.example.com',
        deploymentLabel: 'Production site',
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
                plannedTaskIds: ['task-1', 'task-2', 'task-3'],
                completedTaskSpecIds: ['task-1'],
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
              url: 'https://github.com/asalaza6/autonomy-v2/pull/7',
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
            version: {
              currentVersion: '1.4.44',
              previousVersion: null,
              sourceVersion: '1.4.45',
              targetVersion: '1.4.44',
              isNewVersion: false,
            },
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
  assert.equal(dashboard.repos[0].activePrd.plannedTaskCount, 3);
  assert.equal(dashboard.repos[0].activePrd.completedTaskCount, 1);
  assert.equal(dashboard.repos[0].activePrd.remainingTaskCount, 2);
  assert.equal(dashboard.repos[0].activePrd.progressPercent, 33);
  assert.equal(dashboard.repos[0].queuedPrds[0].title, 'Queued PRD');
  assert.equal(dashboard.repos[0].freshnessStatus, 'stale');
  assert.match(dashboard.repos[0].agentStatuses[0].detail, /planning backlog/);
  assert.equal(dashboard.repos[0].pullRequestStatuses[0].url, 'https://github.com/asalaza6/autonomy-v2/pull/7');
  assert.equal(dashboard.repos[0].deployment.statusLabel, 'Deploy available');
  assert.equal(dashboard.repos[0].versionStatus.version, '1.4.44');
  assert.equal(dashboard.repos[0].versionStatus.isNew, false);
  assert.equal(dashboard.repos[0].deploymentUrl, 'https://deploy.example.com');
  assert.equal(dashboard.repos[0].deployJob.title, 'Deploy dev to main');
  assert.equal(dashboard.jobs[0].statusLabel, 'Waiting to be claimed');
  assert.match(dashboard.jobs[0].detail, /created/);
});

test('control plane dashboard retains offline repos that were previously discovered', () => {
  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [],
    repoStatuses: {
      beta: {
        repoId: 'beta',
        label: 'Beta',
        description: 'Offline repo',
        updatedAt: new Date(Date.now() - 60000).toISOString(),
        snapshot: {
          prds: { prds: [] },
          agentStatuses: [],
          pullRequestStatuses: [],
          branchLockCount: 0,
        },
      },
    },
  } as any);

  assert.equal(dashboard.repoCount, 1);
  assert.equal(dashboard.repos[0].label, 'Beta');
  assert.equal(dashboard.repos[0].freshnessStatus, 'offline');
  assert.match(dashboard.repos[0].overview, /No active PRD yet/);
});

test('control plane dashboard marks deploy-created versions that are newer than the known version', () => {
  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [
      {
        id: 'job-deploy-completed',
        type: 'deploy',
        repoId: 'alpha',
        payload: {
          repoId: 'alpha',
        },
        status: 'completed',
        createdAt: '2026-04-01T12:00:00.000Z',
        updatedAt: '2026-04-01T12:02:00.000Z',
        result: {
          sourceBranch: 'dev',
          targetBranch: 'main',
          version: {
            currentVersion: '1.4.45',
            previousVersion: '1.4.44',
            sourceVersion: '1.4.45',
            targetVersion: '1.4.44',
            isNewVersion: true,
          },
        },
      },
    ],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        updatedAt: new Date().toISOString(),
        snapshot: {
          prds: { prds: [] },
          deployment: {
            status: 'aligned',
            statusLabel: 'Ready',
            version: {
              currentVersion: '1.4.44',
              previousVersion: null,
              sourceVersion: '1.4.44',
              targetVersion: '1.4.44',
              isNewVersion: false,
            },
          },
        },
      },
    },
  } as any);

  assert.equal(dashboard.repos[0].versionStatus.version, '1.4.45');
  assert.equal(dashboard.repos[0].versionStatus.previousVersion, '1.4.44');
  assert.equal(dashboard.repos[0].versionStatus.isNew, true);
  assert.equal(dashboard.repos[0].versionStatus.source, 'deploy');
});

test('control plane dashboard displays current version without a new marker when deploy version is not newer', () => {
  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [
      {
        id: 'job-deploy-same-version',
        type: 'deploy',
        repoId: 'alpha',
        payload: {
          repoId: 'alpha',
        },
        status: 'completed',
        createdAt: '2026-04-01T12:00:00.000Z',
        updatedAt: '2026-04-01T12:02:00.000Z',
        result: {
          version: {
            currentVersion: '1.4.44',
            previousVersion: '1.4.44',
            sourceVersion: '1.4.44',
            targetVersion: '1.4.44',
            isNewVersion: false,
          },
        },
      },
    ],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        updatedAt: new Date().toISOString(),
        snapshot: {
          prds: { prds: [] },
          deployment: {
            status: 'aligned',
            statusLabel: 'Ready',
            version: {
              currentVersion: '1.4.44',
              previousVersion: null,
              sourceVersion: '1.4.44',
              targetVersion: '1.4.44',
              isNewVersion: false,
            },
          },
        },
      },
    },
  } as any);

  assert.equal(dashboard.repos[0].versionStatus.version, '1.4.44');
  assert.equal(dashboard.repos[0].versionStatus.isNew, false);
  assert.equal(dashboard.repos[0].versionStatus.source, 'deploy');
});
