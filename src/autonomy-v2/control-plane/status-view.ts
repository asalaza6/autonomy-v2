const HEARTBEAT_ONLINE_MS = 15000;
const HEARTBEAT_OFFLINE_MS = 45000;

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

function describePrd(prd: any) {
  const status = String(prd && prd.status || 'queued');
  const plannedTaskCount = Array.isArray(prd && prd.plannedTaskIds) ? prd.plannedTaskIds.length : 0;
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
    plannedTaskCount,
    requirementCount,
    updatedAt: prd && prd.updatedAt ? String(prd.updatedAt) : null,
    isQueued: prd && prd.isQueued === true,
  };
}

function summarizeControlPlaneJob(job: any, repoLabel = '') {
  const status = String(job && job.status || 'queued');
  const jobType = String(job && job.type || 'prd:add');
  const statusLabelMap: Record<string, string> = {
    queued: 'Waiting to be claimed',
    claimed: 'Claimed by the bridge',
    running: 'Running on the local repo',
    completed: 'Completed and committed',
    failed: 'Failed',
  };
  const details = [];
  if (repoLabel) {
    details.push(repoLabel);
  }
  if (status === 'failed' && job && job.error) {
    details.push(`error: ${summarizeText(job.error)}`);
  } else if (status === 'completed' && jobType === 'deploy' && job && job.result) {
    details.push(`merged ${job.result.sourceBranch || 'dev'} into ${job.result.targetBranch || 'main'}`);
  } else if (status === 'completed' && job && job.result && job.result.prdId) {
    details.push(`PRD ${job.result.prdId} committed`);
  } else if (job && job.claimedAt) {
    details.push(`claimed ${formatTimestamp(job.claimedAt)}`);
  } else if (job && job.createdAt) {
    details.push(`created ${formatTimestamp(job.createdAt)}`);
  }

  return {
    id: String(job && job.id || ''),
    repoId: String(job && job.repoId || ''),
    repoLabel: repoLabel || String(job && job.repoId || ''),
    title: jobType === 'deploy'
      ? `Deploy ${String(job && job.result && job.result.sourceBranch || job && job.payload && job.payload.sourceBranch || 'dev')} to ${String(job && job.result && job.result.targetBranch || job && job.payload && job.payload.targetBranch || 'main')}`
      : String(job && job.payload && job.payload.title || job && job.id || 'Untitled job'),
    status,
    statusLabel: statusLabelMap[status] || formatStatusLabel(status),
    detail: details.join(' | '),
    createdAt: job && job.createdAt ? String(job.createdAt) : null,
    updatedAt: job && job.updatedAt ? String(job.updatedAt) : null,
  };
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
  const queuedPrds = selectQueuedPrds(prds).map(describePrd);
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
    activePrd: activePrd ? describePrd(activePrd) : null,
    queuedPrds,
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
