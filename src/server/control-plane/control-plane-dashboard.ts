import type { AnyRecord, ControlPlaneConfig, ControlPlaneRepoRecord, ControlPlaneState } from '../../types.js';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import {
  buildControlPlaneHeartbeatSummary,
  summarizeControlPlaneJob,
  summarizeRepoStatus,
} from '../../autonomy-v2/control-plane/status-view.js';

interface ControlPlaneDashboard {
  repoCount: number;
  activePrdCount: number;
  queuedPrdCount: number;
  runningAgentCount: number;
  activePullRequestCount: number;
  deployableRepoCount: number;
  pendingJobCount: number;
  overallHeartbeatStatus: string;
  serverHeartbeat: AnyRecord;
  bridgeHeartbeat: AnyRecord;
  jobs: AnyRecord[];
  repos: AnyRecord[];
}

function buildControlPlaneDashboard(rootDir: string, state: ControlPlaneState): ControlPlaneDashboard {
  const config = loadControlPlaneConfig(rootDir);
  const liveDeploymentSnapshot = readLiveDeploymentSnapshot(rootDir);
  const repoConfigById = new Map(
    (config.repos || []).map((repo) => [repo.id, repo] as const)
  );
  const jobs = (state.jobs || []).slice().sort(compareJobsByFreshness);
  const repoIds = new Set<string>([
    ...Object.keys(state.repoStatuses || {}),
    ...(config.repos || []).map((repo) => repo.id),
  ]);

  const repos = Array.from(repoIds)
    .sort((left, right) => {
      const leftRank = repoSortRank(left, config);
      const rightRank = repoSortRank(right, config);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return String(left).localeCompare(String(right));
    })
    .map((repoId) => buildRepoDashboard(
      repoId,
      repoConfigById.get(repoId) || null,
      state.repoStatuses?.[repoId] || null,
      jobs,
      liveDeploymentSnapshot,
    ));

  const summarizedJobs = jobs
    .map((job) => summarizeControlPlaneJob(job, labelForRepo(job.repoId, repoConfigById)));
  const heartbeats = buildControlPlaneHeartbeatSummary(state.heartbeats || {});

  const activePrdCount = repos.filter((repo) => Boolean(repo.activePrd)).length;
  const queuedPrdCount = repos.reduce((total, repo) => total + (repo.queuedPrds || []).length, 0);
  const runningAgentCount = repos.reduce((total, repo) => {
    const agents = Array.isArray(repo.agentStatuses) ? repo.agentStatuses : [];
    return total + agents.filter((agent) => String(agent && agent.workerStatus || 'idle') === 'running').length;
  }, 0);
  const activePullRequestCount = repos.reduce((total, repo) => total + (repo.pullRequestStatuses || []).length, 0);
  const deployableRepoCount = repos.filter((repo) => Boolean(repo.deployment && (repo.deployment.hasChanges || repo.deployment.deployable))).length;
  const pendingJobCount = summarizedJobs.filter((job) => ['queued', 'claimed', 'running'].includes(String(job.status || ''))).length;

  return {
    repoCount: repos.length,
    activePrdCount,
    queuedPrdCount,
    runningAgentCount,
    activePullRequestCount,
    deployableRepoCount,
    pendingJobCount,
    overallHeartbeatStatus: heartbeats.overallStatus,
    serverHeartbeat: heartbeats.server,
    bridgeHeartbeat: heartbeats.bridge,
    jobs: summarizedJobs,
    repos,
  };
}

function buildRepoDashboard(
  repoId: string,
  repoConfig: ControlPlaneRepoRecord | null,
  repoStatus: AnyRecord | null,
  jobs: AnyRecord[],
  liveDeploymentSnapshot: AnyRecord | null
) {
  const label = String(repoConfig?.label || repoId || 'Repository');
  const description = String(repoConfig?.description || '');
  const summary = repoStatus
    ? summarizeRepoStatus(mergeDeploymentSnapshot(repoStatus, liveDeploymentSnapshot), label)
    : {
        repoId,
        label,
        description,
        updatedAt: null,
        overview: 'No status snapshot yet',
        activePrd: null,
        queuedPrds: [],
        agentStatuses: [],
        pullRequestStatuses: [],
        branchLockCount: 0,
        freshnessStatus: 'offline',
        freshnessStatusLabel: 'Offline',
        freshnessDetail: 'No status snapshot yet',
        freshnessUpdatedAt: null,
      };

  const deployJob = jobs.find((job) => job.repoId === repoId && job.type === 'deploy') || null;

  return {
    ...summary,
    repoId,
    label,
    description,
    default: Boolean(repoConfig?.default),
    updatedAt: summary.updatedAt || null,
    deploymentUrl: String(repoConfig?.deploymentUrl || '').trim() || null,
    deploymentLabel: String(repoConfig?.deploymentLabel || '').trim() || 'Deployment site',
    deployJob: deployJob ? summarizeControlPlaneJob(deployJob, label) : null,
  };
}

function mergeDeploymentSnapshot(repoStatus: AnyRecord | null, liveDeploymentSnapshot: AnyRecord | null) {
  if (!repoStatus || !liveDeploymentSnapshot) {
    return repoStatus;
  }
  const snapshot = repoStatus.snapshot || {};
  if (snapshot.deployment) {
    return repoStatus;
  }
  return {
    ...repoStatus,
    snapshot: {
      ...snapshot,
      deployment: liveDeploymentSnapshot,
    },
  };
}

function readLiveDeploymentSnapshot(rootDir: string) {
  try {
    const snapshot = buildStatusSnapshot(rootDir);
    return snapshot && snapshot.deployment ? snapshot.deployment : null;
  } catch (_) {
    return null;
  }
}

function labelForRepo(repoId: string, repoConfigById: Map<string, ControlPlaneRepoRecord>) {
  return String(repoConfigById.get(repoId)?.label || repoId || '');
}

function compareJobsByFreshness(left: AnyRecord, right: AnyRecord) {
  const leftRank = jobRank(left);
  const rightRank = jobRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const leftTime = Date.parse(String(left.updatedAt || left.createdAt || '')) || 0;
  const rightTime = Date.parse(String(right.updatedAt || right.createdAt || '')) || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return String(left.id || '').localeCompare(String(right.id || ''));
}

function jobRank(job: AnyRecord) {
  const status = String(job.status || 'queued');
  if (status === 'queued') {
    return 0;
  }
  if (status === 'claimed') {
    return 1;
  }
  if (status === 'running') {
    return 2;
  }
  if (status === 'failed') {
    return 3;
  }
  return 4;
}

function repoSortRank(repoId: string, config: ControlPlaneConfig) {
  const index = (config.repos || []).findIndex((repo) => repo.id === repoId);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

export {
  buildControlPlaneDashboard,
};
