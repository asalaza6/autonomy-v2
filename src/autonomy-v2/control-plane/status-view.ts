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
    title: String(job && job.payload && job.payload.title || job && job.id || 'Untitled job'),
    status,
    statusLabel: statusLabelMap[status] || formatStatusLabel(status),
    detail: details.join(' | '),
    createdAt: job && job.createdAt ? String(job.createdAt) : null,
    updatedAt: job && job.updatedAt ? String(job.updatedAt) : null,
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
    branchLockCount: Number(snapshot.branchLockCount || 0),
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
  describePrd,
  formatStatusLabel,
  formatTimestamp,
  selectActivePrd,
  selectQueuedPrds,
  summarizeControlPlaneJob,
  summarizeRepoStatus,
};
