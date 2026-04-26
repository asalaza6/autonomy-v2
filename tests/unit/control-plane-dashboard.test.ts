import test from 'node:test';
import assert from 'node:assert/strict';

import { buildControlPlaneDashboard } from '../../src/server/control-plane/control-plane-dashboard.js';
import { summarizeRepoStatus } from '../../src/autonomy-v2/control-plane/status-view.js';

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
          prdHistory: {
            prds: [
              {
                id: 'prd-finished-001',
                title: 'Finished PRD',
                status: 'completed',
                specification: `Ship the completed workflow.

## Source Chat Message
Repo: alpha
Conversation: chat-1
Manager message: msg-manager
Agent message: msg-agent
Created: 2026-04-01T11:59:00.000Z`,
                requirements: ['record the PRD'],
                tasks: [
                  {
                    id: 'task-history-1',
                    title: 'Build history',
                    agentId: 'architecture-agent',
                    acceptance: ['History renders completed PRDs.'],
                  },
                ],
                createdAt: '2026-03-31T12:00:00.000Z',
                updatedAt: '2026-04-01T12:10:00.000Z',
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
              prdId: 'prd-active-001',
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
          autonomyPackage: {
            packageName: '@asalaza6/autonomy-v2',
            packageManager: 'npm',
            declaredVersion: '^1.4.45',
            installedVersion: '1.4.45',
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
  assert.equal(dashboard.repos[0].prdRun.currentStepId, 'implementing');
  assert.deepEqual(
    dashboard.repos[0].prdRun.steps.map((step) => step.state),
    ['done', 'active', 'pending']
  );
  assert.equal(dashboard.repos[0].queuedPrds[0].title, 'Queued PRD');
  assert.equal(dashboard.repos[0].prdHistory[0].title, 'Finished PRD');
  assert.match(dashboard.repos[0].prdHistory[0].specification, /Ship the completed workflow/);
  assert.deepEqual(dashboard.repos[0].prdHistory[0].sourceChat, {
    repoId: 'alpha',
    conversationId: 'chat-1',
    managerMessageId: 'msg-manager',
    agentMessageId: 'msg-agent',
    createdAt: '2026-04-01T11:59:00.000Z',
  });
  assert.equal(dashboard.repos[0].prdHistory[0].tasks[0].title, 'Build history');
  assert.equal(dashboard.repos[0].freshnessStatus, 'stale');
  assert.match(dashboard.repos[0].agentStatuses[0].detail, /planning backlog/);
  assert.equal(dashboard.repos[0].pullRequestStatuses[0].url, 'https://github.com/asalaza6/autonomy-v2/pull/7');
  assert.equal(dashboard.repos[0].deployment.statusLabel, 'Deploy available');
  assert.equal(dashboard.repos[0].versionStatus.version, '1.4.44');
  assert.equal(dashboard.repos[0].versionStatus.isNew, false);
  assert.equal(dashboard.repos[0].packageStatus.installedVersion, '1.4.45');
  assert.equal(dashboard.repos[0].packageStatus.declaredVersion, '^1.4.45');
  assert.equal(dashboard.repos[0].packageStatus.packageManager, 'npm');
  assert.equal(dashboard.repos[0].deploymentUrl, 'https://deploy.example.com');
  assert.equal(dashboard.repos[0].deployJob.title, 'Deploy dev to main');
  assert.equal(dashboard.jobs[0].statusLabel, 'Waiting to be claimed');
  assert.match(dashboard.jobs[0].detail, /created/);
});

test('status-view summaries normalize source chat metadata for PRD history', () => {
  const summary = summarizeRepoStatus({
    repoId: 'alpha',
    updatedAt: '2026-04-01T12:00:00.000Z',
    snapshot: {
      prds: {
        prds: [],
      },
      prdHistory: {
        prds: [
          {
            id: 'prd-history-source-001',
            title: 'Archived chat PRD',
            status: 'completed',
            specification: `
## Source Chat Message
- Repo: alpha
- Conversation: chat-archived
- Manager message: msg-manager-archived
- Agent message: msg-agent-archived
- Created: 2026-04-01T10:00:00.000Z
`,
            createdAt: '2026-04-01T11:00:00.000Z',
          },
        ],
      },
    },
  }, 'Alpha');

  assert.deepEqual(summary.prdHistory[0].sourceChat, {
    repoId: 'alpha',
    conversationId: 'chat-archived',
    managerMessageId: 'msg-manager-archived',
    agentMessageId: 'msg-agent-archived',
    createdAt: '2026-04-01T10:00:00.000Z',
  });
});

test('control plane dashboard keeps partially completed PRDs in implementing while their PR is active', () => {
  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        updatedAt: new Date().toISOString(),
        snapshot: {
          prds: {
            prds: [
              {
                id: 'prd-active-001',
                title: 'Active PRD',
                status: 'planned',
                isQueued: false,
                plannedTaskIds: ['task-1', 'task-2', 'task-3'],
                completedTaskSpecIds: ['task-1'],
                updatedAt: '2026-04-01T12:08:00.000Z',
              },
            ],
          },
          pullRequestStatuses: [
            {
              prId: 'pr-prd-active-001-architecture-agent',
              prdId: 'prd-active-001',
              title: 'Feature PR',
              status: 'open',
              action: 'waiting for reviewer',
              updatedAt: '2026-04-01T12:05:00.000Z',
            },
          ],
        },
      },
    },
  } as any);

  assert.equal(dashboard.repos[0].prdRun.currentStepId, 'implementing');
  assert.equal(dashboard.repos[0].prdRun.currentStepLabel, 'Implementing');
  assert.match(dashboard.repos[0].prdRun.detail, /1\/3 tasks complete/);
  assert.deepEqual(
    dashboard.repos[0].prdRun.steps.map((step) => step.state),
    ['done', 'active', 'pending']
  );
});

test('restart job summaries preserve target PID evidence for the dashboard model', () => {
  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {
      server: {
        kind: 'server',
        updatedAt: '2026-04-22T01:06:00.000Z',
      },
      bridge: {
        kind: 'bridge',
        updatedAt: '2026-04-22T01:06:30.000Z',
      },
    },
    jobs: [
      {
        id: 'job-restart-001',
        type: 'restart',
        repoId: 'alpha',
        payload: {
          repoId: 'alpha',
        },
        status: 'completed',
        createdAt: '2026-04-22T01:00:00.000Z',
        updatedAt: '2026-04-22T01:06:30.000Z',
        completedAt: '2026-04-22T01:06:30.000Z',
        result: {
          restartStatus: {
            status: 'restarted',
            completedAt: '2026-04-22T01:06:30.000Z',
            server: {
              target: 'server',
              status: 'restarted',
              mode: 'default',
              preRestartPid: 123,
              postRestartPid: 456,
              recordedAt: '2026-04-22T01:00:00.000Z',
              completedAt: '2026-04-22T01:06:10.000Z',
            },
            controlBridge: {
              target: 'controlBridge',
              status: 'skipped',
              mode: 'default',
              reason: 'missing-metadata',
              recordedAt: '2026-04-22T01:00:01.000Z',
              completedAt: '2026-04-22T01:06:20.000Z',
            },
          },
        },
      },
    ],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        updatedAt: '2026-04-22T01:06:30.000Z',
        snapshot: {
          prds: {
            prds: [],
          },
        },
      },
    },
  } as any);

  const restartJob = dashboard.repos[0].restartJob;
  assert.ok(restartJob);
  assert.match(restartJob.detail, /server pid 123 -> 456/);
  assert.match(restartJob.detail, /bridge skipped \(missing metadata\) \| pid missing/);
  assert.equal(restartJob.restartEvidence.status, 'restarted');
  assert.equal(restartJob.restartEvidence.targets[0].preRestartPid, 123);
  assert.equal(restartJob.restartEvidence.targets[0].postRestartPid, 456);
  assert.equal(restartJob.restartEvidence.targets[0].pidChanged, true);
  assert.equal(restartJob.restartEvidence.targets[1].reason, 'missing-metadata');
  assert.equal(restartJob.restartEvidence.targets[1].postRestartPid, null);
});

test('control plane dashboard distinguishes active review from approved merge states', () => {
  const buildDashboardForPullRequest = (pullRequestStatus: any) => buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        updatedAt: new Date().toISOString(),
        snapshot: {
          prds: {
            prds: [
              {
                id: 'prd-active-001',
                title: 'Active PRD',
                status: 'planned',
                isQueued: false,
                plannedTaskIds: ['task-1'],
                completedTaskSpecIds: ['task-1'],
                updatedAt: '2026-04-01T12:08:00.000Z',
              },
            ],
          },
          pullRequestStatuses: [
            {
              prId: 'pr-prd-active-001-architecture-agent',
              prdId: 'prd-active-001',
              title: 'Feature PR',
              updatedAt: '2026-04-01T12:05:00.000Z',
              ...pullRequestStatus,
            },
          ],
        },
      },
    },
  } as any);

  const activeReview = buildDashboardForPullRequest({
    status: 'open',
    statusLabel: 'review active',
    action: 'waiting for reviewer',
  });
  const approvedWaiting = buildDashboardForPullRequest({
    status: 'approved',
    statusLabel: 'approved waiting merge',
    mergeState: 'waiting',
    action: 'approved, waiting for merge diagnosis',
  });
  const blockedMerge = buildDashboardForPullRequest({
    status: 'approved',
    statusLabel: 'blocked from merge',
    mergeState: 'blocked',
    action: 'blocked from merge: failed checks: npm run typecheck',
  });

  assert.match(activeReview.repos[0].prdRun.detail, /Review is active on 1 pull request/);
  assert.match(approvedWaiting.repos[0].prdRun.detail, /1 approved PR waiting for merge/);
  assert.match(approvedWaiting.repos[0].overview, /1 approved PR waiting merge/);
  assert.match(blockedMerge.repos[0].prdRun.detail, /1 approved PR blocked from merge/);
  assert.match(blockedMerge.repos[0].overview, /1 PR blocked from merge/);
});

test('control plane dashboard ignores active pull requests from other PRDs for the run step', () => {
  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [],
    repoStatuses: {
      alpha: {
        repoId: 'alpha',
        label: 'Alpha',
        updatedAt: new Date().toISOString(),
        snapshot: {
          prds: {
            prds: [
              {
                id: 'prd-active-001',
                title: 'Active PRD',
                status: 'planned',
                isQueued: false,
                updatedAt: '2026-04-01T12:08:00.000Z',
              },
            ],
          },
          pullRequestStatuses: [
            {
              prId: 'pr-prd-other-architecture-agent',
              prdId: 'prd-other',
              title: 'Other PRD PR',
              status: 'open',
              action: 'waiting for reviewer',
              updatedAt: '2026-04-01T12:05:00.000Z',
            },
          ],
        },
      },
    },
  } as any);

  assert.equal(dashboard.repos[0].prdRun.currentStepId, 'implementing');
  assert.deepEqual(
    dashboard.repos[0].prdRun.steps.map((step) => step.state),
    ['done', 'active', 'pending']
  );
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

test('control plane dashboard marks same-package deploys as new when the build commit changes', () => {
  const dashboard = buildControlPlaneDashboard('/tmp/hosted-control-plane', {
    schemaVersion: 1,
    heartbeats: {},
    jobs: [
      {
        id: 'job-deploy-new-build',
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
            currentVersion: '1.4.44+build.109.abc123abc123',
            previousVersion: '1.4.44+build.104.def456def456',
            sourceVersion: '1.4.44+build.109.abc123abc123',
            targetVersion: '1.4.44+build.104.def456def456',
            packageVersion: '1.4.44',
            previousPackageVersion: '1.4.44',
            sourcePackageVersion: '1.4.44',
            targetPackageVersion: '1.4.44',
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
          },
        },
      },
    },
  } as any);

  assert.equal(dashboard.repos[0].versionStatus.version, '1.4.44+build.109.abc123abc123');
  assert.equal(dashboard.repos[0].versionStatus.previousVersion, '1.4.44+build.104.def456def456');
  assert.equal(dashboard.repos[0].versionStatus.packageVersion, '1.4.44');
  assert.equal(dashboard.repos[0].versionStatus.isNew, true);
  assert.match(dashboard.repos[0].versionStatus.detail, /publish version 1\.4\.44/);
});
