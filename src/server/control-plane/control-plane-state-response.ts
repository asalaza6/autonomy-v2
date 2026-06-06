import type { AnyRecord, ControlPlaneState } from '../../types.js';
import { buildControlPlaneDashboard } from './control-plane-dashboard.js';

function buildStateApiResponse(
  rootDir: string,
  state: ControlPlaneState,
  controlSession: { sessionId?: string; sessionLabel?: string },
  searchParams: URLSearchParams,
) {
  const includes = parseStateIncludes(searchParams);
  const fullDashboard = buildControlPlaneDashboard(rootDir, state, controlSession);
  const dashboard = wantsDetailedStateDashboard(includes)
    ? fullDashboard
    : compactControlPlaneDashboard(fullDashboard);
  if (includes.has('all') || includes.has('full') || includes.has('raw') || includes.has('state')) {
    return {
      ...state,
      dashboard: fullDashboard,
    };
  }

  const response: Record<string, unknown> = { dashboard };
  if (includes.has('jobs')) {
    response.jobs = state.jobs || [];
  }
  if (includes.has('repoStatuses') || includes.has('repo-statuses')) {
    response.repoStatuses = state.repoStatuses || {};
  }
  if (includes.has('conversations')) {
    response.conversations = state.conversations || {};
  }
  if (includes.has('managedProcesses') || includes.has('managed-processes')) {
    response.managedProcesses = state.managedProcesses || {};
  }
  if (includes.has('controlOwnership') || includes.has('control-ownership')) {
    response.controlOwnership = state.controlOwnership || {};
  }
  if (includes.has('heartbeats')) {
    response.heartbeats = state.heartbeats || {};
  }
  return response;
}

function wantsDetailedStateDashboard(includes: Set<string>) {
  return includes.has('details') || includes.has('detail') || includes.has('dashboard');
}

function compactControlPlaneDashboard(dashboard: AnyRecord) {
  const repos = Array.isArray(dashboard && dashboard.repos) ? dashboard.repos : [];
  const jobs = Array.isArray(dashboard && dashboard.jobs) ? dashboard.jobs : [];
  return {
    repoCount: dashboard.repoCount,
    activePrdCount: dashboard.activePrdCount,
    queuedPrdCount: dashboard.queuedPrdCount,
    runningAgentCount: dashboard.runningAgentCount,
    activePullRequestCount: dashboard.activePullRequestCount,
    deployableRepoCount: dashboard.deployableRepoCount,
    pendingJobCount: dashboard.pendingJobCount,
    overallHeartbeatStatus: dashboard.overallHeartbeatStatus,
    serverHeartbeat: dashboard.serverHeartbeat,
    bridgeHeartbeat: dashboard.bridgeHeartbeat,
    jobs: jobs.slice(0, 20).map(compactDashboardJob),
    totalJobCount: jobs.length,
    repos: repos.map(compactDashboardRepo),
  };
}

function compactDashboardRepo(repo: AnyRecord) {
  const queuedPrds = Array.isArray(repo && repo.queuedPrds) ? repo.queuedPrds : [];
  const prdHistory = Array.isArray(repo && repo.prdHistory) ? repo.prdHistory : [];
  const agentStatuses = Array.isArray(repo && repo.agentStatuses) ? repo.agentStatuses : [];
  const customAgents = Array.isArray(repo && repo.customAgents) ? repo.customAgents : [];
  const pullRequestStatuses = Array.isArray(repo && repo.pullRequestStatuses) ? repo.pullRequestStatuses : [];
  return {
    repoId: repo.repoId,
    label: repo.label,
    description: repo.description,
    updatedAt: repo.updatedAt,
    overview: repo.overview,
    activePrd: compactDashboardPrd(repo.activePrd),
    queuedPrds: queuedPrds.map(compactDashboardPrd),
    queuedPrdCount: queuedPrds.length,
    prdHistoryCount: prdHistory.length,
    lastPrdPromotion: compactLastPrdPromotion(repo.lastPrdPromotion),
    prdRun: repo.prdRun || null,
    customAgents: customAgents.map(compactCustomAgent),
    agentStatuses: agentStatuses.map(compactAgentStatus),
    runningAgentCount: agentStatuses.filter((agent) => String(agent && agent.workerStatus || '') === 'running').length,
    pullRequestStatuses: pullRequestStatuses.map(compactPullRequestStatus),
    activePullRequestCount: pullRequestStatuses.length,
    deployment: compactDeployment(repo.deployment),
    deploymentUrl: repo.deploymentUrl || null,
    deploymentLabel: repo.deploymentLabel || null,
    deployJob: compactDashboardJob(repo.deployJob),
    prdResetJob: compactDashboardJob(repo.prdResetJob),
    packageUpdateJob: compactDashboardJob(repo.packageUpdateJob),
    healthScoreJob: compactDashboardJob(repo.healthScoreJob),
    healthScore: repo.healthScore || null,
    restartJob: compactDashboardJob(repo.restartJob),
    bridgeHeartbeat: repo.bridgeHeartbeat || null,
    managedProcesses: repo.managedProcesses || {},
    controlAccess: repo.controlAccess || null,
    controlOwner: repo.controlOwner || null,
    versionStatus: repo.versionStatus || null,
    packageStatus: repo.packageStatus || null,
    repoAssistant: compactRepoAssistant(repo.repoAssistant),
    branchLockCount: repo.branchLockCount,
    freshnessStatus: repo.freshnessStatus,
    freshnessStatusLabel: repo.freshnessStatusLabel,
    freshnessDetail: repo.freshnessDetail,
    freshnessUpdatedAt: repo.freshnessUpdatedAt,
  };
}

function compactCustomAgent(agent: AnyRecord) {
  return {
    runtimeKey: agent.runtimeKey,
    agentId: agent.agentId,
    kind: agent.kind,
    configSource: agent.configSource,
    configEnabled: agent.configEnabled,
    defaultEnabled: agent.defaultEnabled,
    enabledOverride: typeof agent.enabledOverride === 'boolean' ? agent.enabledOverride : null,
    enabledSource: agent.enabledSource,
    enabled: agent.enabled !== false,
    status: agent.status,
    running: agent.running === true,
    pid: agent.pid ?? null,
    phase: agent.phase || null,
    target: agent.target || null,
    workspacePath: agent.workspacePath || null,
    intervalSeconds: typeof agent.intervalSeconds === 'number' ? agent.intervalSeconds : null,
    offsetSeconds: typeof agent.offsetSeconds === 'number' ? agent.offsetSeconds : null,
    lastPollAt: agent.lastPollAt || null,
    lastDecision: agent.lastDecision || null,
    lastDecisionReason: agent.lastDecisionReason || null,
    lastError: agent.lastError || null,
    conversationMode: agent.conversationMode || null,
    conversationKey: agent.conversationKey || null,
    conversationId: agent.conversationId || null,
    tools: agent.tools || {},
    decisionSource: agent.decisionSource || null,
    lifecycle: agent.lifecycle || {},
    detail: agent.detail,
  };
}

function compactDashboardPrd(prd: AnyRecord | null | undefined) {
  if (!prd) {
    return null;
  }
  return {
    id: prd.id,
    title: prd.title,
    status: prd.status,
    stateLabel: prd.stateLabel,
    detail: prd.detail,
    plannedTaskCount: prd.plannedTaskCount,
    completedTaskCount: prd.completedTaskCount,
    remainingTaskCount: prd.remainingTaskCount,
    progressPercent: prd.progressPercent,
    requirementCount: prd.requirementCount,
    priority: prd.priority,
    statusSource: prd.statusSource,
    statusReason: prd.statusReason,
    reconciliationStatus: prd.reconciliationStatus,
    linkedPullRequestSummary: prd.linkedPullRequestSummary || null,
    createdAt: prd.createdAt,
    updatedAt: prd.updatedAt,
    isQueued: prd.isQueued,
    archived: prd.archived,
    archivePath: prd.archivePath,
    pullRequest: prd.pullRequest || null,
    sourceChat: prd.sourceChat || null,
  };
}

function compactLastPrdPromotion(promotion: AnyRecord | null | undefined) {
  if (!promotion) {
    return null;
  }
  return {
    id: promotion.id,
    title: promotion.title,
    promotedAt: promotion.promotedAt,
    trigger: promotion.trigger,
    detail: promotion.detail,
  };
}

function compactAgentStatus(agent: AnyRecord) {
  return {
    agentId: agent.agentId,
    role: agent.role,
    workerStatus: agent.workerStatus,
    pid: agent.pid ?? null,
    detail: agent.detail,
    activeTaskId: agent.activeTaskId ?? null,
    branch: agent.branch ?? null,
  };
}

function compactPullRequestStatus(status: AnyRecord) {
  return {
    id: status.id,
    title: status.title,
    status: status.status,
    statusLabel: status.statusLabel,
    detail: status.detail,
    url: status.url,
    number: status.number,
    branch: status.branch,
    prdId: status.prdId,
    updatedAt: status.updatedAt,
  };
}

function compactDeployment(deployment: AnyRecord | null | undefined) {
  if (!deployment) {
    return null;
  }
  return {
    sourceBranch: deployment.sourceBranch,
    targetBranch: deployment.targetBranch,
    sourceAheadBy: deployment.sourceAheadBy,
    targetAheadBy: deployment.targetAheadBy,
    branchesAligned: deployment.branchesAligned,
    hasChanges: deployment.hasChanges,
    deployable: deployment.deployable,
    status: deployment.status,
    statusLabel: deployment.statusLabel,
    detail: deployment.detail,
    version: compactDeploymentVersion(deployment.version),
  };
}

function compactDeploymentVersion(version: AnyRecord | null | undefined) {
  if (!version) {
    return null;
  }
  return {
    currentVersion: version.currentVersion,
    sourceVersion: version.sourceVersion,
    targetVersion: version.targetVersion,
    isNewVersion: version.isNewVersion,
    packageVersion: version.packageVersion,
    sourcePackageVersion: version.sourcePackageVersion,
    targetPackageVersion: version.targetPackageVersion,
    sourceBuildNumber: version.sourceBuildNumber,
    targetBuildNumber: version.targetBuildNumber,
  };
}

function compactRepoAssistant(repoAssistant: AnyRecord | null | undefined) {
  if (!repoAssistant || typeof repoAssistant !== 'object') {
    return null;
  }
  return {
    github: repoAssistant.github && typeof repoAssistant.github === 'object'
      ? {
        status: repoAssistant.github.status,
        statusLabel: repoAssistant.github.statusLabel,
        detail: repoAssistant.github.detail,
      }
      : null,
  };
}

function compactDashboardJob(job: AnyRecord | null | undefined) {
  if (!job) {
    return null;
  }
  return {
    id: job.id,
    type: job.type,
    repoId: job.repoId,
    repoLabel: job.repoLabel,
    title: job.title,
    status: job.status,
    statusLabel: job.statusLabel,
    detail: job.detail,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result || null,
  };
}

function parseStateIncludes(searchParams: URLSearchParams) {
  const includes = new Set<string>();
  searchParams.getAll('include').forEach((value) => {
    String(value || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => includes.add(entry));
  });
  if (['1', 'true', 'yes'].includes(String(searchParams.get('full') || '').trim().toLowerCase())) {
    includes.add('full');
  }
  return includes;
}

export {
  buildStateApiResponse,
};
