import { AGENT_ROLES, TASK_TYPES, getRoleLabel } from '../agents/role-catalog.js';
import type { PullRequestRecord, TaskRecord } from './sync-types.js';

function buildStablePullRequestId(laneKey) {
  return `pr-${String(laneKey || 'lane').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}

function inferLinkedTaskType(taskId) {
  return String(taskId || '').includes('-conflict-')
    ? 'conflict_resolution'
    : 'review_followup';
}

function isPendingRuntimeTask(task) {
  if (!task) {
    return false;
  }
  return !['approved', 'merged', 'done'].includes(String(task.status || ''));
}

function findLatestReview(pr) {
  if (!pr || !Array.isArray(pr.reviews) || pr.reviews.length === 0) {
    return null;
  }
  return pr.reviews[pr.reviews.length - 1];
}

function reviewDecisionIsChangesRequested(decisionRecord) {
  return Boolean(decisionRecord && decisionRecord.decision === 'changes_requested');
}

function reviewDecisionIsApproved(decisionRecord) {
  return Boolean(decisionRecord && decisionRecord.decision === 'approved');
}

function reviewerTaskIndicatesChangesRequested(task) {
  return Boolean(task && (task.status === 'changes_requested' || task.lastDecision === 'changes_requested'));
}

function reviewerTaskIndicatesApproved(task) {
  return Boolean(task && (task.status === 'approved' || task.lastDecision === 'approved'));
}

function countCompletedLaneTasks(branchLock, laneTaskIds, maxCount) {
  if (!branchLock || !Array.isArray(branchLock.completedTasks)) {
    return 0;
  }
  return Math.min(maxCount, branchLock.completedTasks.filter((task) => task && laneTaskIds.has(task.id)).length);
}

function countCompletedTaskIds(taskIds, laneTaskIds, maxCount) {
  if (!Array.isArray(taskIds)) {
    return 0;
  }
  return Math.min(maxCount, taskIds.filter((taskId) => laneTaskIds.has(taskId)).length);
}

function getPrCommitCount(pr) {
  const count = Number(pr && (pr.commitCount || (pr.remote && pr.remote.commitCount)));
  return Number.isFinite(count) ? count : 0;
}

function reviewedCommitCountIsStale(pr, existingTask) {
  const currentCommitCount = getPrCommitCount(pr);
  const reviewedCommitCount = Number(existingTask && existingTask.reviewedCommitCount);
  if (!Number.isFinite(currentCommitCount) || currentCommitCount <= 0) {
    return false;
  }
  if (!Number.isFinite(reviewedCommitCount) || reviewedCommitCount <= 0) {
    return false;
  }
  return currentCommitCount > reviewedCommitCount;
}

function getTaskCompletionTimestamp(task) {
  const completionValue = task && (task.completedAt || task.updatedAt || task.startedAt || task.createdAt);
  const timestamp = Date.parse(String(completionValue || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function hasCompletedFollowupSinceLastReview(existingTask, linkedRuntimeTasks = []) {
  const reviewedAt = Date.parse(String(existingTask && existingTask.reviewedAt || ''));
  if (!Number.isFinite(reviewedAt) || reviewedAt <= 0) {
    return false;
  }
  return (linkedRuntimeTasks || [])
    .filter((task) => task && task.type !== TASK_TYPES.REVIEW)
    .filter((task) => !isPendingRuntimeTask(task))
    .some((task) => getTaskCompletionTimestamp(task) > reviewedAt);
}

function reviewerNeedsRefresh(pr, existingTask, linkedRuntimeTasks = []) {
  return reviewedCommitCountIsStale(pr, existingTask)
    || hasCompletedFollowupSinceLastReview(existingTask, linkedRuntimeTasks);
}

function reviewerSourceTaskIsStale(pr, existingTask) {
  const currentTaskId = String(pr && pr.taskId || '').trim();
  const reviewedTaskId = String(existingTask && existingTask.sourceTaskId || '').trim();
  return Boolean(currentTaskId && reviewedTaskId && currentTaskId !== reviewedTaskId);
}

function prIsApprovedAndOpen(pr) {
  if (!pr || String(pr.status || '') !== 'approved') {
    return false;
  }
  if (pr.mergedAt) {
    return false;
  }
  if (pr.remote && pr.remote.mergedAt) {
    return false;
  }
  return !pr.remote || String(pr.remote.state || 'open') === 'open';
}

function approvedPrNeedsReviewerRecovery(pr, existingTask) {
  if (!prIsApprovedAndOpen(pr) || !existingTask) {
    return false;
  }
  return new RegExp(`${getRoleLabel(AGENT_ROLES.REVIEW)} worker exited before completion`, 'i')
    .test(String(existingTask.lastError || ''));
}

function resolveDerivedPullRequestStatus(existingStatus, laneState, pendingTasks, pendingExtraTaskIds, existingPr, existingReviewerTask) {
  if (laneState && laneState.merged) {
    return 'merged';
  }
  if (existingPr && (existingPr.mergedAt || (existingPr.remote && existingPr.remote.mergedAt))) {
    return 'merged';
  }
  if ((pendingTasks || []).length > 0) {
    return 'building';
  }
  if ((pendingExtraTaskIds || []).length > 0) {
    return 'changes_requested';
  }
  if (existingStatus === 'conflicted') {
    return 'conflicted';
  }
  if (existingStatus === 'changes_requested'
    || reviewDecisionIsChangesRequested(findLatestReview(existingPr))
    || reviewerTaskIndicatesChangesRequested(existingReviewerTask)) {
    return 'changes_requested';
  }
  if (existingStatus === 'approved'
    || reviewDecisionIsApproved(findLatestReview(existingPr))
    || reviewerTaskIndicatesApproved(existingReviewerTask)) {
    return 'approved';
  }
  if (['changes_requested', 'approved', 'conflicted', 'building', 'open'].includes(existingStatus)) {
    return existingStatus;
  }
  return 'open';
}

function uniqueStrings(values) {
  const seen = new Set();
  return (values || []).reduce((accumulator, value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      return accumulator;
    }
    seen.add(normalized);
    accumulator.push(normalized);
    return accumulator;
  }, []);
}

function buildDerivedReviewerTask(pr: PullRequestRecord, sourceTask: TaskRecord, now: string, existingTask: TaskRecord | null = null, linkedRuntimeTasks: TaskRecord[] = []) {
  const pendingLinkedTasks = linkedRuntimeTasks.filter((task) => task && task.type !== TASK_TYPES.REVIEW && isPendingRuntimeTask(task));
  const existingStatus = existingTask && existingTask.status ? existingTask.status : '';
  const reviewerHasStaleCommitView = reviewerNeedsRefresh(pr, existingTask, linkedRuntimeTasks)
    || reviewerSourceTaskIsStale(pr, existingTask);
  const needsReviewerRecovery = approvedPrNeedsReviewerRecovery(pr, existingTask);
  let status = existingStatus || 'queued';
  if (pr.status === 'merged') {
    status = 'merged';
  } else if (reviewerHasStaleCommitView) {
    status = 'queued';
  } else if (pr.status === 'changes_requested' || pendingLinkedTasks.length > 0 || reviewerTaskIndicatesChangesRequested(existingTask)) {
    status = 'changes_requested';
  } else if ((pr.status === 'approved' || reviewerTaskIndicatesApproved(existingTask)) && needsReviewerRecovery) {
    status = 'queued';
  } else if (pr.status === 'approved' || reviewerTaskIndicatesApproved(existingTask)) {
    status = 'approved';
  }
  const record: TaskRecord = {
    id: `${getRoleLabel(AGENT_ROLES.REVIEW)}-${pr.id}`,
    title: `Review ${pr.title}`,
    description: `Review ${pr.id} for ${sourceTask.title}`,
    agentId: 'reviewer',
    type: TASK_TYPES.REVIEW,
    prId: pr.id,
    sourceTaskId: pr.taskId || sourceTask.id,
    sourceAgentId: sourceTask.agentId,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    acceptance: pr.acceptance || [],
    reviewRound: reviewerHasStaleCommitView
      ? (pr.reviews || []).length + 1
      : existingTask && existingTask.reviewRound
        ? existingTask.reviewRound
        : (pr.reviews || []).length + 1,
    status,
    createdAt: existingTask && existingTask.createdAt ? existingTask.createdAt : now,
    updatedAt: now,
  };
  ['reviewedAt', 'lastDecision', 'lastError', 'lastMergeFailureMessage', 'dispatcher', 'dispatchedAt'].forEach((field) => {
    if (existingTask && existingTask[field]) {
      record[field] = existingTask[field];
    }
  });
  if (existingTask && Number.isFinite(Number(existingTask.reviewedCommitCount))) {
    record.reviewedCommitCount = Number(existingTask.reviewedCommitCount);
  }
  return record;
}

function buildDerivedPullRequestRecord({
  existingPr,
  existingReviewerTask,
  linkedRuntimeTasks,
  remoteSpec,
  laneTasks,
  laneState,
  completedTasks,
  pendingTasks,
  integrationBranch,
  agentConfig,
  now,
  source,
}: any) {
  const laneKey = `${remoteSpec.spec.id}:${laneTasks[0].agentId}`;
  const prId = buildStablePullRequestId(laneKey);
  const baseTaskIds = laneTasks.map((task) => task.id);
  const baseTaskIdSet = new Set(baseTaskIds);
  const checks = uniqueStrings(laneTasks.flatMap((task) => [
    ...(task.checks || []),
    ...((agentConfig && agentConfig.checks) || []),
  ]));
  const acceptance = uniqueStrings(laneTasks.flatMap((task) => task.acceptance || []));
  const prForReviewState = {
    ...(existingPr || {}),
    commitCount: Number(laneState.commitCount || 0),
    remote: laneState.remote
      ? { ...laneState.remote, commitCount: Number(laneState.commitCount || 0) }
      : (existingPr && existingPr.remote) ? { ...existingPr.remote } : null,
  };
  const reviewerHasStaleCommitView = reviewedCommitCountIsStale(prForReviewState, existingReviewerTask);
  const linkedWorkTasks = (linkedRuntimeTasks || [])
    .filter((task) => task && task.type !== TASK_TYPES.REVIEW)
    .filter((task) => !(reviewerHasStaleCommitView && task.type === 'review_followup'));
  const completedLinkedWorkTaskIds = new Set(linkedWorkTasks
    .filter((task) => !isPendingRuntimeTask(task))
    .map((task) => task.id)
    .filter(Boolean));
  const completedExtraTaskIds = new Set([
    ...((existingPr && existingPr.completedTaskIds) || []).filter((taskId) => !baseTaskIdSet.has(taskId)),
    ...completedLinkedWorkTaskIds,
  ]);
  const extraTaskIds = uniqueStrings([
    ...((existingPr && existingPr.taskIds) || []).filter((taskId) => !baseTaskIdSet.has(taskId)),
    ...(linkedWorkTasks.map((task) => task.id)).filter((taskId) => !baseTaskIdSet.has(taskId)),
  ]);
  const extraPendingTaskIds = uniqueStrings([
    ...((existingPr && existingPr.pendingTaskIds) || [])
      .filter((taskId) => !baseTaskIdSet.has(taskId))
      .filter((taskId) => !completedExtraTaskIds.has(taskId)),
    ...(linkedWorkTasks.filter((task) => isPendingRuntimeTask(task)).map((task) => task.id)).filter((taskId) => !baseTaskIdSet.has(taskId)),
  ]).filter((taskId) => !(reviewerHasStaleCommitView && inferLinkedTaskType(taskId) === 'review_followup'));
  const extraCompletedTaskIds = uniqueStrings([
    ...completedExtraTaskIds,
  ]);
  const reviews = Array.isArray(existingPr && existingPr.reviews)
    ? existingPr.reviews.map((decisionRecord) => ({ ...decisionRecord }))
    : [];

  const record: PullRequestRecord = {
    id: prId,
    taskId: existingPr && existingPr.taskId ? existingPr.taskId : laneTasks[0].id,
    laneKey,
    prdId: remoteSpec.spec.id,
    sprintId: laneTasks[0].sprintId || 'shared',
    agentId: laneTasks[0].agentId,
    sourceTitle: existingPr && existingPr.sourceTitle ? existingPr.sourceTitle : source.title,
    sourceBody: existingPr && existingPr.sourceBody ? existingPr.sourceBody : source.body,
    taskIds: uniqueStrings([...baseTaskIds, ...extraTaskIds]),
    completedTaskIds: uniqueStrings([...completedTasks.map((task) => task.id), ...extraCompletedTaskIds]),
    pendingTaskIds: uniqueStrings([...pendingTasks.map((task) => task.id), ...extraPendingTaskIds]),
    acceptance,
    checks,
    commitCount: Number(laneState.commitCount || 0),
    headBranch: laneState.branch || (existingPr && existingPr.headBranch) || null,
    baseBranch: integrationBranch,
    status: resolveDerivedPullRequestStatus(
      existingPr && existingPr.status,
      laneState,
      pendingTasks,
      extraPendingTaskIds,
      existingPr,
      existingReviewerTask
    ),
    reviews,
    createdAt: existingPr && existingPr.createdAt ? existingPr.createdAt : now,
    updatedAt: now,
    remote: laneState.remote ? {
      number: laneState.remote.number,
      url: laneState.remote.url,
      state: laneState.remote.state,
      mergedAt: laneState.remote.mergedAt,
      commitCount: Number(laneState.commitCount || 0),
    } : (existingPr && existingPr.remote) ? { ...existingPr.remote } : null,
    title: existingPr && existingPr.title ? existingPr.title : `[${laneTasks[0].agentId}] ${String(source.title || '').trim()}`,
    body: existingPr && existingPr.body ? existingPr.body : source.body,
  };
  if (Array.isArray(existingPr && existingPr.scopeViolations) && existingPr.scopeViolations.length > 0) {
    record.scopeViolations = existingPr.scopeViolations.map((violation) => ({ ...violation }));
  }
  if (Array.isArray(existingPr && existingPr.conflicts) && existingPr.conflicts.length > 0) {
    record.conflicts = existingPr.conflicts.map((conflict) => ({ ...conflict }));
  }
  if (existingPr && existingPr.conflict) {
    record.conflict = { ...existingPr.conflict };
  }
  return record;
}

function sortDerivedTasks(tasks) {
  return tasks.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export {
  buildDerivedPullRequestRecord,
  buildDerivedReviewerTask,
  buildStablePullRequestId,
  countCompletedLaneTasks,
  countCompletedTaskIds,
  
  
  sortDerivedTasks,
  uniqueStrings,
};
