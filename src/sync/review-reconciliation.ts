import type { AnyRecord } from './sync-types.js';

const TERMINAL_TASK_STATUSES = new Set(['approved', 'merged', 'done']);
const ACTIVE_PULL_REQUEST_STATUSES = new Set(['open', 'building', 'changes_requested', 'approved', 'conflicted']);

function normalizeString(value) {
  return String(value || '').trim();
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map(normalizeString).filter(Boolean)));
}

function getTaskStatus(task) {
  return normalizeString(task && (task.state || task.status));
}

function isTerminalTask(task) {
  return TERMINAL_TASK_STATUSES.has(getTaskStatus(task));
}

function isReviewTask(task) {
  return normalizeString(task && task.type) === 'review';
}

function resolveRemotePullRequestState(pr: AnyRecord | null | undefined) {
  if (!pr) {
    return null;
  }
  if (pr.remote && (pr.remote.mergedAt || pr.remote.merged_at)) {
    return {
      state: 'merged',
      source: 'remote',
      reason: 'remote.mergedAt',
    };
  }
  const remoteState = normalizeString(pr.remote && pr.remote.state).toLowerCase();
  if (remoteState === 'open' || remoteState === 'closed') {
    return {
      state: remoteState,
      source: 'remote',
      reason: `remote.state=${remoteState}`,
    };
  }
  return null;
}

function inferLocalPullRequestState(pr: AnyRecord | null | undefined, implementationTasks: AnyRecord[] = []) {
  if (!pr) {
    return null;
  }
  const status = normalizeString(pr.status).toLowerCase();
  if (status === 'merged' || pr.mergedAt) {
    return {
      state: 'merged',
      source: 'inferred',
      reason: status === 'merged' ? 'stored.status=merged' : 'stored.mergedAt',
    };
  }
  if (status === 'closed') {
    return {
      state: 'closed',
      source: 'inferred',
      reason: 'stored.status=closed',
    };
  }
  if (pullRequestChangesAlreadyApplied(pr, implementationTasks)) {
    return {
      state: 'merged',
      source: 'inferred',
      reason: 'linked implementation tasks are terminal',
    };
  }
  if (!status || ACTIVE_PULL_REQUEST_STATUSES.has(status)) {
    return {
      state: 'open',
      source: 'inferred',
      reason: status ? `stored.status=${status}` : 'default-open',
    };
  }
  return null;
}

function getPullRequestStateReconciliation(pr: AnyRecord | null | undefined, implementationTasks: AnyRecord[] = []) {
  const remote = resolveRemotePullRequestState(pr);
  const inferred = inferLocalPullRequestState(pr, implementationTasks);

  if (remote) {
    const drifted = Boolean(inferred && inferred.state && inferred.state !== remote.state);
    return {
      canonicalState: remote.state,
      canonicalSource: 'remote',
      canonicalReason: remote.reason,
      inferredState: inferred && inferred.state ? inferred.state : null,
      inferredReason: inferred && inferred.reason ? inferred.reason : null,
      reconciliationStatus: drifted ? 'stale' : 'remote',
      drifted,
      driftReason: drifted
        ? `remote ${remote.state} disagrees with local inference ${inferred && inferred.state}`
        : null,
    };
  }

  const canonical = inferred || {
    state: 'open',
    source: 'inferred',
    reason: 'remote state unavailable',
  };
  return {
    canonicalState: canonical.state,
    canonicalSource: 'inferred',
    canonicalReason: canonical.reason,
    inferredState: inferred && inferred.state ? inferred.state : canonical.state,
    inferredReason: inferred && inferred.reason ? inferred.reason : canonical.reason,
    reconciliationStatus: 'inferred',
    drifted: false,
    driftReason: null,
  };
}

function resolveOpenWorkflowStatus(pr: AnyRecord | null | undefined) {
  const status = normalizeString(pr && pr.status).toLowerCase();
  return ACTIVE_PULL_REQUEST_STATUSES.has(status) ? status : 'open';
}

function isPullRequestMerged(pr: AnyRecord | null | undefined, implementationTasks: AnyRecord[] = []) {
  return getPullRequestStateReconciliation(pr, implementationTasks).canonicalState === 'merged';
}

function isPullRequestClosed(pr: AnyRecord | null | undefined, implementationTasks: AnyRecord[] = []) {
  return getPullRequestStateReconciliation(pr, implementationTasks).canonicalState === 'closed';
}

function isPullRequestResolved(pr: AnyRecord | null | undefined, implementationTasks: AnyRecord[] = []) {
  const canonicalState = getPullRequestStateReconciliation(pr, implementationTasks).canonicalState;
  return canonicalState === 'merged' || canonicalState === 'closed';
}

function isPullRequestActive(pr: AnyRecord | null | undefined, implementationTasks: AnyRecord[] = []) {
  return getPullRequestStateReconciliation(pr, implementationTasks).canonicalState === 'open';
}

function taskMatchesPullRequest(task: AnyRecord | null | undefined, pr: AnyRecord | null | undefined) {
  if (!task || !pr || isReviewTask(task)) {
    return false;
  }
  const taskId = normalizeString(task.id);
  const prTaskIds = new Set(normalizeStringList(pr.taskIds));
  const prId = normalizeString(pr.id);
  const laneKey = normalizeString(pr.laneKey);
  const prdId = normalizeString(pr.prdId);
  return Boolean(
    (prId && normalizeString(task.prId) === prId)
      || (taskId && prTaskIds.has(taskId))
      || (laneKey && normalizeString(task.laneKey) === laneKey)
      || (prdId && normalizeString(task.prdId) === prdId && normalizeString(task.agentId) === normalizeString(pr.agentId))
  );
}

function listImplementationTasksForPullRequest(pr: AnyRecord | null | undefined, implementationTasks: AnyRecord[] = []) {
  return (implementationTasks || []).filter((task) => taskMatchesPullRequest(task, pr));
}

function getTaskById(tasks: AnyRecord[] = []) {
  return new Map((tasks || [])
    .filter((task) => task && task.id)
    .map((task) => [normalizeString(task.id), task]));
}

function pullRequestChangesAlreadyApplied(pr: AnyRecord | null | undefined, implementationTasks: AnyRecord[] = []) {
  if (!pr) {
    return false;
  }
  if (normalizeString(pr.status) === 'merged' || pr.mergedAt || (pr.remote && (pr.remote.mergedAt || pr.remote.merged_at))) {
    return true;
  }

  const taskById = getTaskById(implementationTasks);
  const pendingTaskIds = normalizeStringList(pr.pendingTaskIds);
  const hasUnresolvedPendingTask = pendingTaskIds.some((taskId) => {
    const task = taskById.get(taskId);
    return !task || !isTerminalTask(task);
  });
  if (hasUnresolvedPendingTask) {
    return false;
  }

  const completedTaskIds = new Set(normalizeStringList(pr.completedTaskIds));
  const taskIds = normalizeStringList(pr.taskIds);
  if (taskIds.length > 0) {
    return taskIds.every((taskId) => {
      const task = taskById.get(taskId);
      return completedTaskIds.has(taskId) || Boolean(task && isTerminalTask(task));
    });
  }

  const linkedTasks = listImplementationTasksForPullRequest(pr, implementationTasks);
  return linkedTasks.length > 0 && linkedTasks.every(isTerminalTask);
}

function reviewTaskHasActionableImplementationWork(
  reviewTask: AnyRecord | null | undefined,
  pr: AnyRecord | null | undefined,
  implementationTasks: AnyRecord[] = []
) {
  if (!reviewTask) {
    return false;
  }
  const prId = normalizeString(reviewTask.prId || (pr && pr.id));
  const pendingTaskIds = new Set(normalizeStringList(pr && pr.pendingTaskIds));
  const sourceTaskId = normalizeString(reviewTask.sourceTaskId);
  const linkedTasks = (implementationTasks || []).filter((task) => {
    if (!task || isReviewTask(task)) {
      return false;
    }
    const taskId = normalizeString(task.id);
    return Boolean(
      (prId && normalizeString(task.prId) === prId)
        || (taskId && pendingTaskIds.has(taskId))
        || (sourceTaskId && taskId === sourceTaskId)
        || taskMatchesPullRequest(task, pr)
    );
  });

  if (linkedTasks.some((task) => !isTerminalTask(task))) {
    return true;
  }
  if (pendingTaskIds.size > 0) {
    const terminalTaskIds = new Set(linkedTasks.filter(isTerminalTask).map((task) => normalizeString(task.id)));
    return Array.from(pendingTaskIds).some((taskId) => !terminalTaskIds.has(taskId));
  }
  return false;
}

function reviewTaskShouldBeResolved(
  reviewTask: AnyRecord | null | undefined,
  pr: AnyRecord | null | undefined,
  implementationTasks: AnyRecord[] = []
) {
  if (!reviewTask || normalizeString(reviewTask.status) !== 'changes_requested') {
    return false;
  }
  const hasActionableWork = reviewTaskHasActionableImplementationWork(reviewTask, pr, implementationTasks);
  if (hasActionableWork && isPullRequestActive(pr, implementationTasks)) {
    return false;
  }
  if (isPullRequestResolved(pr, implementationTasks)) {
    return true;
  }
  if (!pr) {
    return !hasActionableWork;
  }
  if (pullRequestChangesAlreadyApplied(pr, implementationTasks) && !hasActionableWork) {
    return true;
  }
  return !isPullRequestActive(pr, implementationTasks) && !hasActionableWork;
}

function resolveMergedAt(reviewTask: AnyRecord, pr: AnyRecord | null | undefined, now: string) {
  return normalizeString(
    (pr && (pr.mergedAt || (pr.remote && (pr.remote.mergedAt || pr.remote.merged_at))))
      || reviewTask.mergedAt
      || now
  );
}

function reconcileReviewTaskRecord(
  reviewTask: AnyRecord,
  {
    pullRequestsById,
    implementationTasks = [],
    now,
  }: {
    pullRequestsById?: Map<string, AnyRecord>;
    implementationTasks?: AnyRecord[];
    now: string;
  }
) : AnyRecord {
  const pr = pullRequestsById && reviewTask.prId ? pullRequestsById.get(String(reviewTask.prId)) || null : null;
  if (!reviewTaskShouldBeResolved(reviewTask, pr, implementationTasks)) {
    return reviewTask;
  }
  const record: AnyRecord = {
    ...reviewTask,
    status: 'merged',
    mergedAt: resolveMergedAt(reviewTask, pr, now),
    updatedAt: now,
  };
  delete record.lastError;
  delete record.lastMergeFailureCode;
  delete record.lastMergeFailureMessage;
  return record;
}

function reconcilePullRequestRecord(pr: AnyRecord, implementationTasks: AnyRecord[] = [], now: string) {
  if (!pr) {
    return pr;
  }
  const reconciliation = getPullRequestStateReconciliation(pr, implementationTasks);
  const nextRecord: AnyRecord = {
    ...pr,
    reconciliation,
  };
  if (reconciliation.canonicalState === 'merged') {
    nextRecord.status = 'merged';
    nextRecord.mergedAt = resolveMergedAt({}, pr, now);
    nextRecord.updatedAt = now;
    return nextRecord;
  }
  if (reconciliation.canonicalState === 'closed') {
    nextRecord.status = 'closed';
    nextRecord.updatedAt = now;
    delete nextRecord.mergedAt;
    return nextRecord;
  }
  nextRecord.status = resolveOpenWorkflowStatus(pr);
  if (normalizeString(nextRecord.status) !== normalizeString(pr.status)) {
    nextRecord.updatedAt = now;
  }
  delete nextRecord.mergedAt;
  return nextRecord;
}

export {
  getPullRequestStateReconciliation,
  isPullRequestActive,
  isPullRequestResolved,
  pullRequestChangesAlreadyApplied,
  reconcilePullRequestRecord,
  reconcileReviewTaskRecord,
  reviewTaskHasActionableImplementationWork,
  reviewTaskShouldBeResolved,
};
