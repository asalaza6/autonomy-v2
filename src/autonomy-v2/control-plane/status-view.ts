import { extractPrdSourceChatMetadata } from './prd-source-chat.js';
import type { PrdLinkedPullRequestSummary } from '../../types.js';

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
      const openPullRequestCount = Number(prd && prd.linkedPullRequestSummary && prd.linkedPullRequestSummary.open || 0);
      return !prd.isQueued && (status === 'planning' || status === 'planned' || openPullRequestCount > 0);
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
    .sort((left, right) => {
      const priorityDelta = getPrdPriorityRank(right) - getPrdPriorityRank(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return compareTimestamps(left.createdAt || left.updatedAt || '', right.createdAt || right.updatedAt || '');
    });
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
  const structuredContent = extractStructuredPrdContent(prd);
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
  } else if (status === 'reset') {
    stateLabel = 'Reset / abandoned';
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
  if (prd && prd.priority) {
    details.push(`priority ${summarizeText(prd.priority)}`);
  }
  if (prd && prd.lastError) {
    details.push(`last error: ${summarizeText(prd.lastError)}`);
  }
  if (prd && prd.statusReason) {
    details.push(`state reason: ${summarizeText(prd.statusReason)}`);
  }
  if (status === 'reset' && prd && prd.archive && prd.archive.reason) {
    details.push(`reason: ${summarizeText(prd.archive.reason)}`);
  }
  if (prd && prd.updatedAt) {
    details.push(`updated ${formatTimestamp(prd.updatedAt)}`);
  }

  const sourceChat = extractPrdSourceChatMetadata(prd);
  const pullRequest = normalizeLinkedPullRequest(prd && prd.pullRequest);

  return {
    id: String(prd && prd.id || ''),
    title: String(prd && prd.title || prd && prd.id || 'Untitled PRD'),
    status,
    stateLabel,
    detail: details.join(' | '),
    problem: structuredContent.problem,
    specification: structuredContent.specification,
    requirements: Array.isArray(prd && prd.requirements) ? prd.requirements.map((entry) => String(entry || '')) : [],
    acceptanceCriteria: structuredContent.acceptanceCriteria,
    verification: structuredContent.verification,
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
    priority: prd && prd.priority ? String(prd.priority) : '',
    statusSource: prd && prd.statusSource ? String(prd.statusSource) : null,
    statusReason: prd && prd.statusReason ? String(prd.statusReason) : null,
    reconciliationStatus: prd && prd.reconciliationStatus ? String(prd.reconciliationStatus) : null,
    linkedPullRequestSummary: prd && prd.linkedPullRequestSummary ? { ...prd.linkedPullRequestSummary } : null,
    createdAt: prd && prd.createdAt ? String(prd.createdAt) : null,
    updatedAt: prd && prd.updatedAt ? String(prd.updatedAt) : null,
    isQueued: prd && prd.isQueued === true,
    archived: prd && prd.archived === true,
    archivePath: prd && prd.archivePath ? String(prd.archivePath) : null,
    archive: prd && prd.archive && typeof prd.archive === 'object'
      ? {
        kind: prd.archive.kind ? String(prd.archive.kind) : null,
        status: prd.archive.status ? String(prd.archive.status) : null,
        archivedAt: prd.archive.archivedAt ? String(prd.archive.archivedAt) : null,
        reason: prd.archive.reason ? String(prd.archive.reason) : null,
        fromStatus: prd.archive.fromStatus ? String(prd.archive.fromStatus) : null,
        actor: prd.archive.actor ? String(prd.archive.actor) : null,
      }
      : null,
    ...(pullRequest ? { pullRequest } : {}),
    ...(sourceChat ? { sourceChat } : {}),
  };
}

function getPrdPriorityRank(prd: any) {
  const value = String(prd && prd.priority || '').trim().toLowerCase();
  if (['highest', 'critical', 'p0', '0'].includes(value)) {
    return 400;
  }
  if (['high', 'p1', '1'].includes(value)) {
    return 300;
  }
  if (['normal', 'medium', 'p2', '2'].includes(value)) {
    return 200;
  }
  if (['low', 'p3', '3'].includes(value)) {
    return 100;
  }
  return 200;
}

function normalizeLinkedPullRequest(value: unknown): PrdLinkedPullRequestSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as PrdLinkedPullRequestSummary;
  const url = String(record.url || '').trim();
  const number = Number(record.number);
  const normalized: PrdLinkedPullRequestSummary = {};
  if (Number.isFinite(number) && number > 0) {
    normalized.number = number;
  }
  if (url) {
    normalized.url = url;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function extractStructuredPrdContent(prd: any) {
  const specification = prd && prd.specification ? String(prd.specification) : '';
  const sections = parseStructuredPrdSections(specification);
  return {
    problem: cleanStructuredText(prd && prd.problem) || cleanStructuredText(sections.problem?.join('\n\n')) || '',
    specification,
    acceptanceCriteria: normalizeStructuredList(
      Array.isArray(prd && prd.acceptanceCriteria) ? prd.acceptanceCriteria : sections.acceptanceCriteria
    ),
    verification: normalizeStructuredList(
      Array.isArray(prd && prd.verification) ? prd.verification : sections.verification
    ),
  };
}

function parseStructuredPrdSections(specification: string) {
  const text = String(specification || '');
  if (!text.trim()) {
    return {};
  }

  const sections: Record<string, string[]> = {};
  let currentSection = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const headingMatch = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      currentSection = normalizeStructuredSectionHeading(headingMatch[1]);
      if (currentSection && !sections[currentSection]) {
        sections[currentSection] = [];
      }
      continue;
    }
    if (!currentSection) {
      continue;
    }
    sections[currentSection].push(rawLine);
  }
  return sections;
}

function normalizeStructuredSectionHeading(value: string) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (normalized === 'problem') {
    return 'problem';
  }
  if (normalized === 'acceptance criteria') {
    return 'acceptanceCriteria';
  }
  if (normalized === 'verification') {
    return 'verification';
  }
  return '';
}

function cleanStructuredText(value: unknown) {
  return String(value || '').trim();
}

function normalizeStructuredList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
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

function selectActivePullRequestStatusForPrd(activePrd: any, pullRequestStatuses: any[] = [], queuedPrds: any[] = []) {
  const prdPullRequestStatuses = selectPullRequestStatusesForPrd(activePrd, pullRequestStatuses)
    .filter((pullRequestStatus) => hasValidPullRequestUrl(pullRequestStatus && pullRequestStatus.url));
  if (!activePrd || prdPullRequestStatuses.length === 0) {
    return null;
  }

  const currentStepId = resolvePrdRunStep(activePrd, queuedPrds, prdPullRequestStatuses);
  if (currentStepId !== 'implementing' && currentStepId !== 'reviewing') {
    return null;
  }

  return prdPullRequestStatuses
    .slice()
    .sort((left, right) => compareActivePullRequestStatuses(left, right, currentStepId))[0] || null;
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

function compareActivePullRequestStatuses(left: any, right: any, currentStepId: string) {
  const leftRank = rankActivePullRequestStatus(left, currentStepId);
  const rightRank = rankActivePullRequestStatus(right, currentStepId);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  const leftTime = Date.parse(String(left && left.updatedAt || '')) || 0;
  const rightTime = Date.parse(String(right && right.updatedAt || '')) || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }

  const leftNumber = Number(left && left.number) || 0;
  const rightNumber = Number(right && right.number) || 0;
  if (leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }

  return String(left && left.prId || '').localeCompare(String(right && right.prId || ''));
}

function rankActivePullRequestStatus(pullRequestStatus: any, currentStepId: string) {
  const kind = pullRequestStatusKind(pullRequestStatus);
  if (kind === 'review-active') {
    return 0;
  }
  if (currentStepId === 'reviewing' && kind === 'merge-blocked') {
    return 1;
  }
  if (currentStepId === 'reviewing' && kind === 'approved-waiting') {
    return 2;
  }
  if (currentStepId === 'implementing' && kind === 'merge-blocked') {
    return 3;
  }
  if (currentStepId === 'implementing' && kind === 'approved-waiting') {
    return 4;
  }
  return 9;
}

function hasValidPullRequestUrl(value: unknown) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return false;
  }
  try {
    const parsedUrl = new URL(rawValue);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
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
    const reviewActiveCount = countPullRequestStatusesByKind(pullRequestStatuses, 'review-active');
    const approvedWaitingCount = countPullRequestStatusesByKind(pullRequestStatuses, 'approved-waiting');
    const blockedMergeCount = countPullRequestStatusesByKind(pullRequestStatuses, 'merge-blocked');
    if (reviewActiveCount > 0) {
      return `Review is active on ${reviewActiveCount} pull request${reviewActiveCount === 1 ? '' : 's'}.`;
    }
    if (blockedMergeCount > 0) {
      return `${blockedMergeCount} approved PR${blockedMergeCount === 1 ? '' : 's'} blocked from merge.`;
    }
    if (approvedWaitingCount > 0) {
      return `${approvedWaitingCount} approved PR${approvedWaitingCount === 1 ? '' : 's'} waiting for merge.`;
    }
    return 'Implementation tasks are complete and review is next.';
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
    const reviewActiveCount = countPullRequestStatusesByKind(pullRequestStatuses, 'review-active');
    const approvedWaitingCount = countPullRequestStatusesByKind(pullRequestStatuses, 'approved-waiting');
    const blockedMergeCount = countPullRequestStatusesByKind(pullRequestStatuses, 'merge-blocked');
    if (reviewActiveCount > 0) {
      return `${reviewActiveCount} active review PR${reviewActiveCount === 1 ? '' : 's'}`;
    }
    if (blockedMergeCount > 0) {
      return `${blockedMergeCount} blocked merge PR${blockedMergeCount === 1 ? '' : 's'}`;
    }
    if (approvedWaitingCount > 0) {
      return `${approvedWaitingCount} approved PR${approvedWaitingCount === 1 ? '' : 's'} waiting`;
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
  const restartEvidence = jobType === 'restart' ? buildRestartEvidence(job) : null;
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
    const updateCommand = job.result.updateCommand || {};
    const updateMode = updateCommand.mode === 'custom' ? 'custom command' : 'default install';
    details.push(`${updateMode}: ${job.result.installedVersion || job.result.newDeclaredVersion || 'latest'}`);
    if (job.result.commitSha) {
      details.push(`committed ${String(job.result.commitSha).slice(0, 12)}`);
    }
    if (job.result.pushMessage) {
      details.push(String(job.result.pushMessage));
    } else if (job.result.commit && job.result.commit.reason) {
      details.push(`commit ${String(job.result.commit.reason)}`);
    }
  } else if (status === 'completed' && jobType === 'restart' && job && job.result) {
    const restartStatus = job.result.restartStatus && job.result.restartStatus.status
      ? job.result.restartStatus.status
      : 'skipped';
    details.push(`restart ${restartStatus}`);
    const restartDetail = summarizeRestartTargets(restartEvidence);
    if (restartDetail) {
      details.push(restartDetail);
    }
  } else if (status === 'completed' && jobType === 'prd:reset' && job && job.result) {
    if (job.result.noop) {
      details.push(String(job.result.message || 'No active PRD to reset.'));
    } else {
      details.push(`PRD ${job.result.prdId || 'unknown'} reset`);
      if (job.result.reason) {
        details.push(`reason: ${summarizeText(job.result.reason)}`);
      }
    }
  } else if (status === 'completed' && jobType === 'prd:priority' && job && job.result) {
    details.push(`PRD ${job.result.prdId || 'unknown'} priority ${job.result.priority || 'updated'}`);
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
    ...(restartEvidence ? { restartEvidence } : {}),
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
  if (jobType === 'restart') {
    return {
      queued: 'Waiting to restart',
      claimed: 'Restart claimed by bridge',
      running: 'Restarting services',
      completed: 'Restart recorded',
      failed: 'Restart failed',
    };
  }
  if (jobType === 'prd:reset') {
    return {
      queued: 'Waiting to reset PRDs',
      claimed: 'Reset claimed by bridge',
      running: 'Resetting PRD state',
      completed: 'PRD reset recorded',
      failed: 'Reset failed',
    };
  }
  if (jobType === 'prd:priority') {
    return {
      queued: 'Waiting to update priority',
      claimed: 'Priority update claimed by bridge',
      running: 'Updating priority',
      completed: 'Priority updated',
      failed: 'Priority update failed',
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

function summarizeRestartTargets(restartEvidence: any) {
  const targets = Array.isArray(restartEvidence && restartEvidence.targets) ? restartEvidence.targets : [];
  return targets
    .map((target) => String(target && target.compactLabel || '').trim())
    .filter(Boolean)
    .join(', ');
}

function buildRestartEvidence(job: any) {
  const restartStatus = job && job.result && job.result.restartStatus && typeof job.result.restartStatus === 'object'
    ? job.result.restartStatus
    : {};
  const completedAt = String(restartStatus.completedAt || job && (job.completedAt || job.updatedAt) || '').trim() || null;
  const targets = ['server', 'controlBridge']
    .map((target) => buildRestartTargetEvidence(target, restartStatus && restartStatus[target], completedAt))
    .filter(Boolean);
  if (targets.length === 0 && !String(restartStatus.status || '').trim()) {
    return null;
  }
  const restartedTargets = targets.filter((target) => target.status === 'restarted');
  const pidChangedTargets = restartedTargets.filter((target) => target.pidChanged === true);
  return {
    status: String(restartStatus.status || 'skipped').trim() || 'skipped',
    statusLabel: formatRestartStatusLabel(String(restartStatus.status || 'skipped').trim() || 'skipped'),
    completedAt,
    helperStatus: String(restartStatus.helperStatus || '').trim() || null,
    targets,
    compactSummary: targets.map((target) => target.compactLabel).filter(Boolean).join(', '),
    allTargetsRelaunched: targets.length > 0 && targets.every((target) => target.status === 'restarted'),
    allTargetsChangedPid: targets.length > 0 && targets.every((target) => target.pidChanged === true),
    relaunchedTargetCount: restartedTargets.length,
    pidChangedTargetCount: pidChangedTargets.length,
  };
}

function buildRestartTargetEvidence(target: string, raw: any, fallbackCompletedAt: string | null) {
  const status = String(raw && raw.status || '').trim();
  if (!status) {
    return null;
  }
  const label = target === 'controlBridge' ? 'bridge' : 'server';
  const mode = String(raw && raw.mode || '').trim() || null;
  const reason = String(raw && raw.reason || '').trim() || null;
  const preRestartPid = normalizeOptionalNumber(raw && (raw.preRestartPid ?? raw.pid));
  const postRestartPid = normalizeOptionalNumber(raw && raw.postRestartPid);
  const recordedAt = String(raw && raw.recordedAt || '').trim() || null;
  const completedAt = String(raw && raw.completedAt || fallbackCompletedAt || '').trim() || null;
  const pidChanged = preRestartPid !== null && postRestartPid !== null ? preRestartPid !== postRestartPid : null;
  return {
    target,
    label,
    status,
    statusLabel: formatRestartStatusLabel(status),
    reason,
    reasonLabel: reason ? formatRestartReason(reason) : null,
    mode,
    modeLabel: mode ? formatStatusLabel(mode) : null,
    command: String(raw && raw.command || '').trim() || null,
    cwd: String(raw && raw.cwd || '').trim() || null,
    preRestartPid,
    postRestartPid,
    recordedAt,
    completedAt,
    error: String(raw && raw.error || '').trim() || null,
    pidChanged,
    compactLabel: buildRestartCompactLabel(label, status, reason, preRestartPid, postRestartPid),
  };
}

function buildRestartCompactLabel(
  label: string,
  status: string,
  reason: string | null,
  preRestartPid: number | null,
  postRestartPid: number | null
) {
  if (status === 'restarted') {
    return `${label} pid ${formatPidValue(preRestartPid)} -> ${formatPidValue(postRestartPid)}`;
  }
  const lifecycle = preRestartPid === null ? 'pid missing' : `pid ${preRestartPid}`;
  return `${label} ${formatRestartStatusLabel(status).toLowerCase()}${reason ? ` (${formatRestartReason(reason)})` : ''} | ${lifecycle}`;
}

function formatRestartStatusLabel(status: string) {
  if (status === 'restarted') {
    return 'Restarted';
  }
  if (status === 'relaunch-failed') {
    return 'Relaunch failed';
  }
  if (status === 'stale-pid') {
    return 'Stale PID';
  }
  return formatStatusLabel(status);
}

function formatRestartReason(reason: string) {
  if (reason === 'missing-metadata') {
    return 'missing metadata';
  }
  if (reason === 'default-lifecycle-metadata') {
    return 'default lifecycle metadata';
  }
  if (reason === 'after-job-completion') {
    return 'after job completion';
  }
  if (reason === 'post-restart-pid-unavailable') {
    return 'post-restart pid unavailable';
  }
  return formatStatusLabel(reason);
}

function formatPidValue(pid: number | null) {
  return pid === null ? 'missing' : String(pid);
}

function normalizeOptionalNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function formatControlPlaneJobTitle(job: any, jobType: string) {
  if (jobType === 'deploy') {
    return `Deploy ${String(job && job.result && job.result.sourceBranch || job && job.payload && job.payload.sourceBranch || 'dev')} to ${String(job && job.result && job.result.targetBranch || job && job.payload && job.payload.targetBranch || 'main')}`;
  }
  if (jobType === 'package:update') {
    return 'Update Autonomy v2 package';
  }
  if (jobType === 'restart') {
    return 'Restart Autonomy v2 services';
  }
  if (jobType === 'prd:reset') {
    return 'Reset PRD state';
  }
  if (jobType === 'prd:priority') {
    return `Update PRD priority: ${String(job && job.payload && (job.payload.prdId || job.payload.id) || job && job.id || 'queued PRD')}`;
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
  const lastPrdPromotion = buildLastPrdPromotionSummary(snapshot.runtime && snapshot.runtime.lastPrdPromotion, prds);
  const agentStatuses = Array.isArray(snapshot.agentStatuses) ? snapshot.agentStatuses : [];
  const pullRequestStatuses = Array.isArray(snapshot.pullRequestStatuses) ? snapshot.pullRequestStatuses : [];
  const runningAgents = agentStatuses.filter((agent) => String(agent && agent.workerStatus || 'idle') === 'running').length;
  const freshness = buildHeartbeatSummary(repoStatus && repoStatus.updatedAt, repoLabel || 'Repository');
  const deployment = snapshot.deployment || null;
  const repoAssistant = snapshot.repoAssistant || null;
  const githubAccess = repoAssistant && typeof repoAssistant === 'object' ? repoAssistant.github || null : null;

  const overviewParts = [];
  overviewParts.push(activePrd ? `Active PRD: ${activePrd.title}` : 'No active PRD yet');
  overviewParts.push(queuedPrds.length > 0
    ? `${queuedPrds.length} queued PRD${queuedPrds.length === 1 ? '' : 's'}`
    : 'No queued PRDs');
  if (lastPrdPromotion) {
    overviewParts.push(`Auto-promoted ${lastPrdPromotion.title}`);
  }
  if (runningAgents > 0) {
    overviewParts.push(`${runningAgents} agent${runningAgents === 1 ? '' : 's'} running`);
  }
  if (pullRequestStatuses.length > 0) {
    const reviewActiveCount = countPullRequestStatusesByKind(pullRequestStatuses, 'review-active');
    const approvedWaitingCount = countPullRequestStatusesByKind(pullRequestStatuses, 'approved-waiting');
    const blockedMergeCount = countPullRequestStatusesByKind(pullRequestStatuses, 'merge-blocked');
    if (reviewActiveCount > 0) {
      overviewParts.push(`${reviewActiveCount} active review PR${reviewActiveCount === 1 ? '' : 's'}`);
    }
    if (approvedWaitingCount > 0) {
      overviewParts.push(`${approvedWaitingCount} approved PR${approvedWaitingCount === 1 ? '' : 's'} waiting merge`);
    }
    if (blockedMergeCount > 0) {
      overviewParts.push(`${blockedMergeCount} PR${blockedMergeCount === 1 ? '' : 's'} blocked from merge`);
    }
  }
  if (deployment && deployment.statusLabel) {
    overviewParts.push(`Deploy: ${deployment.statusLabel}`);
  }
  if (githubAccess && githubAccess.statusLabel) {
    overviewParts.push(`GitHub: ${githubAccess.statusLabel}`);
  }

  return {
    repoId: String(repoStatus && repoStatus.repoId || ''),
    label: repoLabel || String(repoStatus && repoStatus.repoId || ''),
    description: '',
    updatedAt: repoStatus && repoStatus.updatedAt ? String(repoStatus.updatedAt) : null,
    overview: overviewParts.join(' | '),
    activePrd: activePrdSummary,
    queuedPrds,
    lastPrdPromotion,
    prdRun: buildPrdRunSummary(activePrdSummary, queuedPrds, pullRequestStatuses),
    prdHistory,
    agentStatuses,
    pullRequestStatuses,
    deployment,
    repoAssistant,
    branchLockCount: Number(snapshot.branchLockCount || 0),
    freshnessStatus: freshness.status,
    freshnessStatusLabel: freshness.statusLabel,
    freshnessDetail: freshness.detail,
    freshnessUpdatedAt: freshness.updatedAt,
  };
}

function buildLastPrdPromotionSummary(lastPrdPromotion: any, prds: any[] = []) {
  if (!lastPrdPromotion || !lastPrdPromotion.id) {
    return null;
  }
  const promotedPrd = (prds || []).find((prd) => String(prd && prd.id || '') === String(lastPrdPromotion.id)) || null;
  const title = String(
    lastPrdPromotion.title
    || (promotedPrd && promotedPrd.title)
    || lastPrdPromotion.id
    || 'Queued PRD'
  );
  return {
    id: String(lastPrdPromotion.id),
    title,
    source: lastPrdPromotion.source ? String(lastPrdPromotion.source) : null,
    destination: lastPrdPromotion.destination ? String(lastPrdPromotion.destination) : null,
    promotedAt: lastPrdPromotion.promotedAt ? String(lastPrdPromotion.promotedAt) : null,
    trigger: lastPrdPromotion.trigger ? String(lastPrdPromotion.trigger) : 'automatic-queue-promotion',
    detail: `Automatically promoted from queue${title ? `: ${title}` : ''}.`,
  };
}

function countPullRequestStatusesByKind(pullRequestStatuses: any[] = [], kind: string) {
  return (pullRequestStatuses || []).filter((pullRequestStatus) => pullRequestStatusKind(pullRequestStatus) === kind).length;
}

function pullRequestStatusKind(pullRequestStatus: any) {
  const statusLabel = String(pullRequestStatus && pullRequestStatus.statusLabel || '').toLowerCase();
  const mergeState = String(pullRequestStatus && pullRequestStatus.mergeState || '').toLowerCase();
  const status = String(pullRequestStatus && pullRequestStatus.status || '').toLowerCase();
  if (statusLabel === 'blocked from merge' || mergeState === 'blocked') {
    return 'merge-blocked';
  }
  if (statusLabel === 'approved waiting merge' || status === 'approved' || mergeState === 'waiting') {
    return 'approved-waiting';
  }
  return 'review-active';
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
  selectActivePullRequestStatusForPrd,
  buildLastPrdPromotionSummary,
  selectQueuedPrds,
  summarizeControlPlaneJob,
  summarizeRepoStatus,
};
