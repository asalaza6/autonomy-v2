const HEARTBEAT_ONLINE_MS = 15000;
const HEARTBEAT_OFFLINE_MS = 45000;
const PRD_RUN_STEPS = [
  { id: 'planning', label: 'Planning' },
  { id: 'implementing', label: 'Implementing' },
  { id: 'reviewing', label: 'Reviewing' },
];

function selectActivePrd(prds: any[] = []) {
  const candidates = (prds || [])
    .filter((prd) => {
      const status = String(prd && prd.status || '');
      return !prd.isQueued && (status === 'planning' || status === 'planned');
    })
    .slice()
    .sort((left, right) => {
      const leftRank = rankPrdForStatus(left);
      const rightRank = rankPrdForStatus(right);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return compareTimestamps(right.updatedAt || right.createdAt || '', left.updatedAt || left.createdAt || '');
    });
  return candidates[0] || null;
}

function selectQueuedPrds(prds: any[] = []) {
  return (prds || [])
    .filter((prd) => prd && (prd.isQueued === true || String(prd.status || '') === 'queued'))
    .slice()
    .sort((left, right) => compareTimestamps(left.createdAt || left.updatedAt || '', right.createdAt || right.updatedAt || ''));
}

function selectPrdHistory(snapshot: any, prds: any[] = []) {
  const historyPrds = Array.isArray(snapshot && snapshot.prdHistory && snapshot.prdHistory.prds)
    ? snapshot.prdHistory.prds
    : (prds || []).filter((prd) => prd && String(prd.status || '') === 'completed');
  return historyPrds
    .slice()
    .sort((left, right) => {
      const leftTime = String(left && (left.updatedAt || left.createdAt) || '');
      const rightTime = String(right && (right.updatedAt || right.createdAt) || '');
      return compareTimestamps(rightTime, leftTime);
    });
}

function describePrd(prd: any) {
  const status = String(prd && prd.status || 'queued');
  const plannedTaskCount = Array.isArray(prd && prd.plannedTaskIds)
    ? prd.plannedTaskIds.length
    : Array.isArray(prd && prd.tasks)
      ? prd.tasks.length
      : 0;
  const completedTaskCount = Array.isArray(prd && prd.completedTaskSpecIds)
    ? prd.completedTaskSpecIds.length
    : status === 'completed'
      ? plannedTaskCount
      : 0;
  const remainingTaskCount = Math.max(plannedTaskCount - completedTaskCount, 0);
  const progressPercent = plannedTaskCount > 0
    ? Math.max(0, Math.min(100, Math.round((completedTaskCount / plannedTaskCount) * 100)))
    : status === 'completed'
      ? 100
      : 0;
  const requirementCount = Array.isArray(prd && prd.requirements) ? prd.requirements.length : 0;
  const details = [];
  let stateLabel = formatStatusLabel(status);

  if (status === 'planning') {
    stateLabel = 'Planning now';
  } else if (status === 'planned') {
    stateLabel = 'Planned and waiting to run';
  } else if (status === 'queued' || prd.isQueued === true) {
    stateLabel = 'Waiting in queue';
  } else if (status === 'completed') {
    stateLabel = 'Completed';
  } else if (status === 'failed') {
    stateLabel = 'Needs attention';
  }

  if (plannedTaskCount > 0) {
    details.push(`${plannedTaskCount} planned task${plannedTaskCount === 1 ? '' : 's'}`);
  }
  if (completedTaskCount > 0 || plannedTaskCount > 0) {
    details.push(`${completedTaskCount}/${plannedTaskCount} tasks done`);
  }
  if (requirementCount > 0) {
    details.push(`${requirementCount} requirement${requirementCount === 1 ? '' : 's'}`);
  }
  if (prd && prd.lastError) {
    details.push(`last error: ${summarizeText(prd.lastError)}`);
  }
  if (prd && prd.updatedAt) {
    details.push(`updated ${formatTimestamp(prd.updatedAt)}`);
  }

  return {
    id: String(prd && prd.id || ''),
    title: String(prd && prd.title || prd && prd.id || 'Untitled PRD'),
    status,
    stateLabel,
    detail: details.join(' | '),
    specification: prd && prd.specification ? String(prd.specification) : '',
    requirements: Array.isArray(prd && prd.requirements) ? prd.requirements.map((entry) => String(entry || '')) : [],
    tasks: Array.isArray(prd && prd.tasks)
      ? prd.tasks.map((task) => ({
        id: String(task && task.id || ''),
        title: String(task && task.title || task && task.id || 'Untitled task'),
        agentId: String(task && task.agentId || ''),
        description: task && task.description ? String(task.description) : '',
        acceptance: Array.isArray(task && task.acceptance) ? task.acceptance.map((entry) => String(entry || '')) : [],
        sprintId: task && task.sprintId ? String(task.sprintId) : '',
      }))
      : [],
    plannedTaskCount,
    completedTaskCount,
    remainingTaskCount,
    progressPercent,
    requirementCount,
    createdAt: prd && prd.createdAt ? String(prd.createdAt) : null,
    updatedAt: prd && prd.updatedAt ? String(prd.updatedAt) : null,
    isQueued: prd && prd.isQueued === true,
    archived: prd && prd.archived === true,
    archivePath: prd && prd.archivePath ? String(prd.archivePath) : null,
  };
}

function buildPrdRunSummary(activePrd: any, queuedPrds: any[] = [], pullRequestStatuses: any[] = []) {
  const prdPullRequestStatuses = selectPullRequestStatusesForPrd(activePrd, pullRequestStatuses);
  const currentStepId = resolvePrdRunStep(activePrd, queuedPrds, prdPullRequestStatuses);
  const currentStepIndex = PRD_RUN_STEPS.findIndex((step) => step.id === currentStepId);
  const steps = PRD_RUN_STEPS.map((step, index) => ({
    ...step,
    state: resolvePrdStepState(currentStepId, currentStepIndex, index),
    detail: describePrdRunStep(step.id, activePrd, prdPullRequestStatuses),
  }));
  return {
    currentStepId,
    currentStepLabel: formatPrdRunStepLabel(currentStepId),
    detail: describePrdRun(activePrd, queuedPrds, prdPullRequestStatuses),
    steps,
  };
}

function resolvePrdRunStep(activePrd: any, queuedPrds: any[] = [], pullRequestStatuses: any[] = []) {
  if (!activePrd) {
    return queuedPrds.length > 0 ? 'queued' : 'idle';
  }
  const status = String(activePrd.status || '');
  if (status === 'planning') {
    return 'planning';
  }
  if (status === 'completed') {
    return 'finished';
  }
  if (status === 'failed') {
    return Number(activePrd.plannedTaskCount || 0) > 0 ? 'implementing' : 'planning';
  }
  const plannedTaskCount = Number(activePrd.plannedTaskCount || 0);
  const completedTaskCount = Number(activePrd.completedTaskCount || 0);
  if (plannedTaskCount > 0 && completedTaskCount < plannedTaskCount) {
    return 'implementing';
  }
  if (plannedTaskCount > 0 && completedTaskCount >= plannedTaskCount) {
    return 'reviewing';
  }
  if (pullRequestStatuses.length > 0) {
    return 'reviewing';
  }
  if (status === 'planned' || plannedTaskCount > 0) {
    return 'implementing';
  }
  return 'planning';
}

function selectPullRequestStatusesForPrd(activePrd: any, pullRequestStatuses: any[] = []) {
  const prdId = String(activePrd && activePrd.id || '').trim();
  if (!prdId) {
    return [];
  }
  return (pullRequestStatuses || []).filter((prStatus) => pullRequestStatusMatchesPrd(prStatus, prdId));
}

function pullRequestStatusMatchesPrd(prStatus: any, prdId: string) {
  const explicitPrdId = String(prStatus && prStatus.prdId || '').trim();
  if (explicitPrdId) {
    return explicitPrdId === prdId;
  }

  const prId = String(prStatus && prStatus.prId || '').trim();
  const prdSlug = slugifyIdentifier(prdId);
  return Boolean(prdSlug && (prId === `pr-${prdSlug}` || prId.startsWith(`pr-${prdSlug}-`)));
}

function slugifyIdentifier(value: string) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolvePrdStepState(currentStepId: string, currentStepIndex: number, stepIndex: number) {
  if (currentStepId === 'finished') {
    return 'done';
  }
  if (currentStepIndex < 0) {
    return 'pending';
  }
  if (stepIndex < currentStepIndex) {
    return 'done';
  }
  if (stepIndex === currentStepIndex) {
    return 'active';
  }
  return 'pending';
}

function describePrdRun(activePrd: any, queuedPrds: any[] = [], pullRequestStatuses: any[] = []) {
  if (!activePrd) {
    if (queuedPrds.length > 0) {
      return `${queuedPrds.length} PRD${queuedPrds.length === 1 ? '' : 's'} waiting to start.`;
    }
    return 'No active PRD is working through tasks right now.';
  }
  const currentStepId = resolvePrdRunStep(activePrd, queuedPrds, pullRequestStatuses);
  if (currentStepId === 'planning') {
    return 'Planning is turning the PRD into implementation tasks.';
  }
  if (currentStepId === 'implementing') {
    const totalTasks = Number(activePrd.plannedTaskCount || 0);
    const completedTasks = Number(activePrd.completedTaskCount || 0);
    return totalTasks > 0
      ? `Implementation is running: ${completedTasks}/${totalTasks} tasks complete.`
      : 'Implementation is waiting for planned tasks.';
  }
  if (currentStepId === 'reviewing') {
    return pullRequestStatuses.length > 0
      ? `Review is active on ${pullRequestStatuses.length} pull request${pullRequestStatuses.length === 1 ? '' : 's'}.`
      : 'Implementation tasks are complete and review is next.';
  }
  if (currentStepId === 'finished') {
    return 'This PRD finished and is ready for history.';
  }
  return activePrd.detail || activePrd.stateLabel || 'PRD status is unavailable.';
}

function describePrdRunStep(stepId: string, activePrd: any, pullRequestStatuses: any[] = []) {
  if (stepId === 'planning') {
    if (activePrd && String(activePrd.status || '') === 'planning') {
      return 'In progress';
    }
    return activePrd ? 'Complete' : 'Waiting';
  }
  if (stepId === 'implementing') {
    const totalTasks = Number(activePrd && activePrd.plannedTaskCount || 0);
    const completedTasks = Number(activePrd && activePrd.completedTaskCount || 0);
    if (totalTasks > 0) {
      return `${completedTasks}/${totalTasks} tasks`;
    }
    return activePrd ? 'Waiting for tasks' : 'Waiting';
  }
  if (stepId === 'reviewing') {
    if (pullRequestStatuses.length > 0) {
      return `${pullRequestStatuses.length} active PR${pullRequestStatuses.length === 1 ? '' : 's'}`;
    }
    return activePrd && String(activePrd.status || '') === 'completed' ? 'Complete' : 'Waiting';
  }
  return '';
}

function formatPrdRunStepLabel(stepId: string) {
  if (stepId === 'queued') {
    return 'Queued';
  }
  if (stepId === 'idle') {
    return 'Idle';
  }
  if (stepId === 'finished') {
    return 'Finished';
  }
  const step = PRD_RUN_STEPS.find((entry) => entry.id === stepId);
  return step ? step.label : formatStatusLabel(stepId);
}

function summarizeControlPlaneJob(job: any, repoLabel = '') {
  const status = String(job && job.status || 'queued');
  const jobType = String(job && job.type || 'prd:add');
  const statusLabelMap: Record<string, string> = buildJobStatusLabelMap(jobType);
  const details = [];
  if (repoLabel) {
    details.push(repoLabel);
  }
  if (status === 'failed' && job && job.error) {
    details.push(`error: ${summarizeText(job.error)}`);
  } else if (status === 'completed' && jobType === 'agent:chat' && job && job.result) {
    details.push('agent replied');
  } else if (status === 'completed' && jobType === 'deploy' && job && job.result) {
    details.push(`merged ${job.result.sourceBranch || 'dev'} into ${job.result.targetBranch || 'main'}`);
  } else if (status === 'completed' && jobType === 'package:update' && job && job.result) {
    details.push(`installed ${job.result.installedVersion || job.result.newDeclaredVersion || 'latest'}`);
  } else if (status === 'completed' && job && job.result && job.result.prdId) {
    details.push(`PRD ${job.result.prdId} committed`);
  } else if (job && job.claimedAt) {
    details.push(`claimed ${formatTimestamp(job.claimedAt)}`);
  } else if (job && job.createdAt) {
    details.push(`created ${formatTimestamp(job.createdAt)}`);
  }

  return {
    id: String(job && job.id || ''),
    type: jobType,
    repoId: String(job && job.repoId || ''),
    repoLabel: repoLabel || String(job && job.repoId || ''),
    title: formatControlPlaneJobTitle(job, jobType),
    status,
    statusLabel: statusLabelMap[status] || formatStatusLabel(status),
    detail: details.join(' | '),
    createdAt: job && job.createdAt ? String(job.createdAt) : null,
    updatedAt: job && job.updatedAt ? String(job.updatedAt) : null,
  };
}

function buildJobStatusLabelMap(jobType: string): Record<string, string> {
  if (jobType === 'agent:chat') {
    return {
      queued: 'Waiting for bridge reply',
      claimed: 'Bridge is drafting reply',
      running: 'Bridge is drafting reply',
      completed: 'Reply delivered',
      failed: 'Failed',
    };
  }
  if (jobType === 'package:update') {
    return {
      queued: 'Waiting to update',
      claimed: 'Update claimed by bridge',
      running: 'Updating package',
      completed: 'Package updated',
      failed: 'Update failed',
    };
  }
  return {
    queued: 'Waiting to be claimed',
    claimed: 'Claimed by the bridge',
    running: 'Running on the local repo',
    completed: jobType === 'deploy' ? 'Deploy completed' : 'Completed and committed',
    failed: 'Failed',
  };
}

function formatControlPlaneJobTitle(job: any, jobType: string) {
  if (jobType === 'deploy') {
    return `Deploy ${String(job && job.result && job.result.sourceBranch || job && job.payload && job.payload.sourceBranch || 'dev')} to ${String(job && job.result && job.result.targetBranch || job && job.payload && job.payload.targetBranch || 'main')}`;
  }
  if (jobType === 'package:update') {
    return 'Update Autonomy v2 package';
  }
  if (jobType === 'agent:chat') {
    return `Repo chat: ${summarizeText(job && job.payload && job.payload.prompt || job && job.id || 'message')}`;
  }
  return String(job && job.payload && job.payload.title || job && job.id || 'Untitled job');
}

function buildHeartbeatSummary(updatedAt: string | null | undefined, label: string, nowMs = Date.now()) {
  const timestamp = String(updatedAt || '').trim();
  if (!timestamp) {
    return {
      label,
      status: 'offline',
      statusLabel: 'Offline',
      detail: 'No heartbeat yet',
      updatedAt: null,
      ageMs: null,
    };
  }

  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return {
      label,
      status: 'offline',
      statusLabel: 'Offline',
      detail: `Invalid heartbeat time: ${timestamp}`,
      updatedAt: timestamp,
      ageMs: null,
    };
  }

  const ageMs = Math.max(0, nowMs - parsed);
  const status = ageMs <= HEARTBEAT_ONLINE_MS
    ? 'online'
    : ageMs <= HEARTBEAT_OFFLINE_MS
      ? 'stale'
      : 'offline';
  const statusLabel = status === 'online'
    ? 'Online'
    : status === 'stale'
      ? 'Stale'
      : 'Offline';

  return {
    label,
    status,
    statusLabel,
    detail: ageMs === 0
      ? 'Seen just now'
      : `Last seen ${formatHeartbeatAge(ageMs)} ago`,
    updatedAt: timestamp,
    ageMs,
  };
}

function buildControlPlaneHeartbeatSummary(heartbeats: any = {}, nowMs = Date.now()) {
  const server = buildHeartbeatSummary(heartbeats.server && heartbeats.server.updatedAt, 'Server', nowMs);
  const bridge = buildHeartbeatSummary(heartbeats.bridge && heartbeats.bridge.updatedAt, 'Bridge', nowMs);
  const overallStatus = [server.status, bridge.status].includes('offline')
    ? 'offline'
    : [server.status, bridge.status].includes('stale')
      ? 'stale'
      : 'online';
  const statusLabel = overallStatus === 'online'
    ? 'Healthy'
    : overallStatus === 'stale'
      ? 'Stale'
      : 'Offline';

  return {
    overallStatus,
    statusLabel,
    server,
    bridge,
  };
}

function summarizeRepoStatus(repoStatus: any, repoLabel = '') {
  const snapshot = (repoStatus && repoStatus.snapshot) || {};
  const prds = Array.isArray(snapshot.prds && snapshot.prds.prds) ? snapshot.prds.prds : [];
  const activePrd = selectActivePrd(prds);
  const activePrdSummary = activePrd ? describePrd(activePrd) : null;
  const queuedPrds = selectQueuedPrds(prds).map(describePrd);
  const prdHistory = selectPrdHistory(snapshot, prds).map(describePrd);
  const agentStatuses = Array.isArray(snapshot.agentStatuses) ? snapshot.agentStatuses : [];
  const pullRequestStatuses = Array.isArray(snapshot.pullRequestStatuses) ? snapshot.pullRequestStatuses : [];
  const runningAgents = agentStatuses.filter((agent) => String(agent && agent.workerStatus || 'idle') === 'running').length;
  const freshness = buildHeartbeatSummary(repoStatus && repoStatus.updatedAt, repoLabel || 'Repository');
  const deployment = snapshot.deployment || null;

  const overviewParts = [];
  overviewParts.push(activePrd ? `Active PRD: ${activePrd.title}` : 'No active PRD yet');
  overviewParts.push(queuedPrds.length > 0
    ? `${queuedPrds.length} queued PRD${queuedPrds.length === 1 ? '' : 's'}`
    : 'No queued PRDs');
  if (runningAgents > 0) {
    overviewParts.push(`${runningAgents} agent${runningAgents === 1 ? '' : 's'} running`);
  }
  if (pullRequestStatuses.length > 0) {
    overviewParts.push(`${pullRequestStatuses.length} active PR${pullRequestStatuses.length === 1 ? '' : 's'}`);
  }
  if (deployment && deployment.statusLabel) {
    overviewParts.push(`Deploy: ${deployment.statusLabel}`);
  }

  return {
    repoId: String(repoStatus && repoStatus.repoId || ''),
    label: repoLabel || String(repoStatus && repoStatus.repoId || ''),
    description: '',
    updatedAt: repoStatus && repoStatus.updatedAt ? String(repoStatus.updatedAt) : null,
    overview: overviewParts.join(' | '),
    activePrd: activePrdSummary,
    queuedPrds,
    prdRun: buildPrdRunSummary(activePrdSummary, queuedPrds, pullRequestStatuses),
    prdHistory,
    agentStatuses,
    pullRequestStatuses,
    deployment,
    branchLockCount: Number(snapshot.branchLockCount || 0),
    freshnessStatus: freshness.status,
    freshnessStatusLabel: freshness.statusLabel,
    freshnessDetail: freshness.detail,
    freshnessUpdatedAt: freshness.updatedAt,
  };
}

function formatStatusLabel(status: string) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

function summarizeText(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || 'unknown time');
  }
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function compareTimestamps(left: string, right: string) {
  return (Date.parse(left || '') || 0) - (Date.parse(right || '') || 0);
}

function formatHeartbeatAge(ageMs: number) {
  if (!Number.isFinite(ageMs) || ageMs < 1000) {
    return '0s';
  }

  const totalSeconds = Math.floor(ageMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) {
    return `${seconds}s`;
  }
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function rankPrdForStatus(prd: any) {
  const status = String(prd && prd.status || '');
  if (status === 'planning') {
    return 0;
  }
  if (status === 'planned') {
    return 1;
  }
  return 10;
}

export {
  buildControlPlaneHeartbeatSummary,
  buildHeartbeatSummary,
  describePrd,
  formatStatusLabel,
  formatTimestamp,
  selectActivePrd,
  selectQueuedPrds,
  summarizeControlPlaneJob,
  summarizeRepoStatus,
};
