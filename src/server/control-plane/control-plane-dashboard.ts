import type { AnyRecord, ControlPlaneRepoRecord, ControlPlaneState } from '../../types.js';
import { normalizeRepoRecord } from './control-plane-validation.js';
import {
  buildControlPlaneHeartbeatSummary,
  summarizeControlPlaneJob,
  summarizeRepoStatus,
} from '../../autonomy-v2/control-plane/status-view.js';
import { isVersionNewer, normalizeVersionString } from '../../autonomy-v2/commands/deploy-version.js';

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
  const repoConfigById = new Map(
    Object.values(state.repoStatuses || {})
      .map((repo) => normalizeRepoRecord(repo))
      .filter(isRepoRecord)
      .map((repo) => [repo.repoId, repo] as const)
  );
  const jobs = (state.jobs || []).slice().sort(compareJobsByFreshness);
  const repoIds = new Set<string>([
    ...Object.keys(state.repoStatuses || {}),
  ]);

  const repos: AnyRecord[] = Array.from(repoIds)
    .sort((left, right) => {
      const leftLabel = String(repoConfigById.get(left)?.label || left || '');
      const rightLabel = String(repoConfigById.get(right)?.label || right || '');
      return leftLabel.localeCompare(rightLabel);
    })
    .map((repoId) => buildRepoDashboard(
      repoId,
      repoConfigById.get(repoId) || null,
      state.repoStatuses?.[repoId] || null,
      jobs,
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
): AnyRecord {
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
    updatedAt: summary.updatedAt || null,
    deploymentUrl: String(repoConfig?.deploymentUrl || '').trim() || null,
    deploymentLabel: String(repoConfig?.deploymentLabel || '').trim() || 'Deployment site',
    deployJob: deployJob ? summarizeControlPlaneJob(deployJob, label) : null,
    versionStatus: buildRepoVersionStatus(repoId, repoStatus, jobs),
  };
}

function buildRepoVersionStatus(repoId: string, repoStatus: AnyRecord | null, jobs: AnyRecord[]) {
  const latestDeployVersion = selectLatestDeployVersion(repoId, jobs);
  if (latestDeployVersion && latestDeployVersion.currentVersion) {
    const version = normalizeVersionString(latestDeployVersion.currentVersion);
    const previousVersion = normalizeVersionString(latestDeployVersion.previousVersion);
    const packageVersion = normalizeVersionString(
      latestDeployVersion.packageVersion || latestDeployVersion.sourcePackageVersion
    );
    const isNew = latestDeployVersion.isNewVersion === true
      || versionsDiffer(version, previousVersion)
      || isVersionNewer(packageVersion || version, latestDeployVersion.previousPackageVersion || previousVersion);
    return {
      version,
      previousVersion,
      isNew,
      source: 'deploy',
      packageVersion,
      detail: buildVersionDetail({
        isNew,
        previousVersion,
        packageVersion,
        source: 'deploy',
      }),
    };
  }

  const snapshotVersion = normalizeVersionString(
    repoStatus
      && repoStatus.snapshot
      && repoStatus.snapshot.deployment
      && repoStatus.snapshot.deployment.version
      && repoStatus.snapshot.deployment.version.currentVersion
  );
  const snapshotPackageVersion = normalizeVersionString(
    repoStatus
      && repoStatus.snapshot
      && repoStatus.snapshot.deployment
      && repoStatus.snapshot.deployment.version
      && repoStatus.snapshot.deployment.version.packageVersion
  );
  return {
    version: snapshotVersion,
    previousVersion: null,
    isNew: false,
    source: snapshotVersion ? 'snapshot' : 'unavailable',
    packageVersion: snapshotPackageVersion,
    detail: snapshotVersion
      ? buildVersionDetail({
        isNew: false,
        previousVersion: null,
        packageVersion: snapshotPackageVersion,
        source: 'snapshot',
      })
      : 'Version unavailable',
  };
}

function selectLatestDeployVersion(repoId: string, jobs: AnyRecord[]) {
  const deployJobs = jobs
    .filter((job) => (
      String(job && job.repoId || '') === repoId
      && String(job && job.type || '') === 'deploy'
      && String(job && job.status || '') === 'completed'
      && job
      && job.result
      && job.result.version
    ))
    .slice()
    .sort(compareJobsByUpdatedTime);
  return deployJobs.length > 0 ? deployJobs[0].result.version : null;
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

function compareJobsByUpdatedTime(left: AnyRecord, right: AnyRecord) {
  const leftTime = Date.parse(String(left.updatedAt || left.completedAt || left.createdAt || '')) || 0;
  const rightTime = Date.parse(String(right.updatedAt || right.completedAt || right.createdAt || '')) || 0;
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

function versionsDiffer(left: string | null, right: string | null) {
  return Boolean(left && right && left !== right);
}

function buildVersionDetail({ isNew, previousVersion, packageVersion, source }: {
  isNew: boolean;
  previousVersion: string | null;
  packageVersion: string | null;
  source: string;
}) {
  const parts = [];
  if (isNew && previousVersion) {
    parts.push(`Created during deploy from ${previousVersion}`);
  } else if (source === 'deploy') {
    parts.push('Current deploy build');
  } else {
    parts.push('Current build');
  }
  if (packageVersion) {
    parts.push(`publish version ${packageVersion}`);
  }
  return parts.join('; ');
}

function isRepoRecord(repo: ControlPlaneRepoRecord | null): repo is ControlPlaneRepoRecord {
  return Boolean(repo && repo.repoId);
}

export {
  buildControlPlaneDashboard,
};
