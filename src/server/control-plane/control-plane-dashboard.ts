import type { AnyRecord, ControlPlaneConfig, ControlPlaneRepoRecord, ControlPlaneState } from '../../types.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import { summarizeControlPlaneJob, summarizeRepoStatus } from '../../autonomy-v2/control-plane/status-view.js';

interface ControlPlaneDashboard {
  repoCount: number;
  activePrdCount: number;
  queuedPrdCount: number;
  runningAgentCount: number;
  activePullRequestCount: number;
  pendingJobCount: number;
  jobs: AnyRecord[];
  repos: AnyRecord[];
}

function buildControlPlaneDashboard(rootDir: string, state: ControlPlaneState): ControlPlaneDashboard {
  const config = loadControlPlaneConfig(rootDir);
  const repoConfigById = new Map(
    (config.repos || []).map((repo) => [repo.id, repo] as const)
  );
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
    .map((repoId) => buildRepoDashboard(repoId, repoConfigById.get(repoId) || null, state.repoStatuses?.[repoId] || null));

  const jobs = (state.jobs || [])
    .slice()
    .sort(compareJobsByFreshness)
    .map((job) => summarizeControlPlaneJob(job, labelForRepo(job.repoId, repoConfigById)));

  const activePrdCount = repos.filter((repo) => Boolean(repo.activePrd)).length;
  const queuedPrdCount = repos.reduce((total, repo) => total + (repo.queuedPrds || []).length, 0);
  const runningAgentCount = repos.reduce((total, repo) => {
    const agents = Array.isArray(repo.agentStatuses) ? repo.agentStatuses : [];
    return total + agents.filter((agent) => String(agent && agent.workerStatus || 'idle') === 'running').length;
  }, 0);
  const activePullRequestCount = repos.reduce((total, repo) => total + (repo.pullRequestStatuses || []).length, 0);
  const pendingJobCount = jobs.filter((job) => ['queued', 'claimed', 'running'].includes(String(job.status || ''))).length;

  return {
    repoCount: repos.length,
    activePrdCount,
    queuedPrdCount,
    runningAgentCount,
    activePullRequestCount,
    pendingJobCount,
    jobs,
    repos,
  };
}

function buildRepoDashboard(
  repoId: string,
  repoConfig: ControlPlaneRepoRecord | null,
  repoStatus: AnyRecord | null
) {
  const label = String(repoConfig?.label || repoId || 'Repository');
  const description = String(repoConfig?.description || '');
  const summary = repoStatus
    ? summarizeRepoStatus(repoStatus, label)
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
      };

  return {
    ...summary,
    repoId,
    label,
    description,
    default: Boolean(repoConfig?.default),
    updatedAt: summary.updatedAt || null,
  };
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
