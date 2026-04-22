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

function isPullRequestMerged(pr: AnyRecord | null | undefined) {
  return Boolean(
    pr
      && (
        normalizeString(pr.status) === 'merged'
        || pr.mergedAt
        || (pr.remote && (pr.remote.mergedAt || pr.remote.merged_at))
      )
  );
}

function isPullRequestClosed(pr: AnyRecord | null | undefined) {
  if (!pr || isPullRequestMerged(pr)) {
    return false;
  }
  const status = normalizeString(pr.status).toLowerCase();
  const remoteState = normalizeString(pr.remote && pr.remote.state).toLowerCase();
  return status === 'closed' || remoteState === 'closed';
}

function isPullRequestResolved(pr: AnyRecord | null | undefined) {
  return isPullRequestMerged(pr) || isPullRequestClosed(pr);
}

function isPullRequestActive(pr: AnyRecord | null | undefined) {
  if (!pr || isPullRequestResolved(pr)) {
    return false;
  }
  const remoteState = normalizeString(pr.remote && pr.remote.state).toLowerCase();
  if (remoteState) {
    return remoteState === 'open';
  }
  const status = normalizeString(pr.status).toLowerCase();
  return !status || ACTIVE_PULL_REQUEST_STATUSES.has(status);
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
  if (isPullRequestMerged(pr)) {
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
  if (hasActionableWork && isPullRequestActive(pr)) {
    return false;
  }
  if (isPullRequestResolved(pr)) {
    return true;
  }
  if (!pr) {
    return !hasActionableWork;
  }
  if (pullRequestChangesAlreadyApplied(pr, implementationTasks) && !hasActionableWork) {
    return true;
  }
  return !isPullRequestActive(pr) && !hasActionableWork;
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
  if (isPullRequestMerged(pr)) {
    return normalizeString(pr.status) === 'merged'
      ? pr
      : {
          ...pr,
          status: 'merged',
          mergedAt: resolveMergedAt({}, pr, now),
          updatedAt: now,
        };
  }
  if (isPullRequestClosed(pr)) {
    return normalizeString(pr.status) === 'closed'
      ? pr
      : {
          ...pr,
          status: 'closed',
          updatedAt: now,
        };
  }
  if (normalizeString(pr.status) === 'changes_requested'
    && pullRequestChangesAlreadyApplied(pr, implementationTasks)) {
    return {
      ...pr,
      status: 'merged',
      mergedAt: resolveMergedAt({}, pr, now),
      updatedAt: now,
    };
  }
  return pr;
}

export {
  isPullRequestActive,
  isPullRequestResolved,
  pullRequestChangesAlreadyApplied,
  reconcilePullRequestRecord,
  reconcileReviewTaskRecord,
  reviewTaskHasActionableImplementationWork,
  reviewTaskShouldBeResolved,
};
