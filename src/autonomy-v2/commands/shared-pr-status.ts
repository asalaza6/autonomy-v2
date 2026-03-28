import { AGENT_ROLES, TASK_TYPES, getRoleAgentLabel, getRoleLabel } from '../../agents/role-catalog.js';
import { normalizeLaneKey } from './shared-core.js';
import { isTerminalTaskStatus, getImplementationTaskState } from './shared-queues.js';

function buildPullRequestStatusSummaries({ taskQueues, prs, runtime, branchLocks }) {
  const workerByAgentId = new Map(Object.entries(((runtime && runtime.workers) || {})));
  const branchLockByLane = new Map(
    ((branchLocks && branchLocks.locks) || [])
      .map((lock) => [normalizeLaneKey(lock), lock])
      .filter(([laneKey]) => laneKey)
  );
  const tasksByPrId = new Map();
  listTasks(taskQueues).forEach((task) => {
    if (!task || !task.prId) {
      return;
    }
    const linked = tasksByPrId.get(task.prId) || [];
    linked.push(task);
    tasksByPrId.set(task.prId, linked);
  });

  return ((prs && prs.pullRequests) || [])
    .filter((pr) => isActivePullRequest(pr))
    .sort(comparePullRequestStatuses)
    .map((pr) => {
      const linkedTasks = tasksByPrId.get(pr.id) || [];
      const reviewTask = linkedTasks.find((task) => task.type === TASK_TYPES.REVIEW) || null;
      const implementationTask = selectImplementationTaskForStatus(
        linkedTasks.filter((task) => task.type !== TASK_TYPES.REVIEW)
      );
      return {
        prId: pr.id,
        number: pr.remote && pr.remote.number ? Number(pr.remote.number) : null,
        title: pr.title || pr.id,
        status: String(pr.status || 'open'),
        branch: pr.headBranch || resolveTaskBranch(implementationTask, new Map(), branchLockByLane) || null,
        action: describePullRequestAction(pr, reviewTask, implementationTask, workerByAgentId),
        url: pr.remote && pr.remote.url ? pr.remote.url : null,
        updatedAt: pr.updatedAt || '',
      };
    });
}

function listTasks(taskQueues) {
  return Object.values(taskQueues).flatMap((queue: any) => queue.tasks || []);
}

function isActivePullRequest(pr) {
  if (!pr) {
    return false;
  }
  if (String(pr.status || '') === 'merged') {
    return false;
  }
  if (pr.remote && pr.remote.mergedAt) {
    return false;
  }
  return true;
}

function comparePullRequestStatuses(left, right) {
  const leftTime = Date.parse(left && left.updatedAt || '') || 0;
  const rightTime = Date.parse(right && right.updatedAt || '') || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const leftNumber = Number(left && left.remote && left.remote.number) || 0;
  const rightNumber = Number(right && right.remote && right.remote.number) || 0;
  if (leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function describePullRequestAction(pr, reviewTask, implementationTask, workerByAgentId) {
  if (implementationTask) {
    return describePullRequestImplementationAction(
      implementationTask,
      workerByAgentId.get(implementationTask.agentId) || null
    );
  }
  if (reviewTask) {
    return describePullRequestReviewAction(pr, reviewTask, workerByAgentId.get('reviewer') || null);
  }
  if (String(pr.status || '') === 'changes_requested') {
    return `waiting for ${pr.agentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to respond to ${getRoleLabel(AGENT_ROLES.REVIEW)}`;
  }
  if (String(pr.status || '') === 'approved') {
    return 'approved, waiting for merge';
  }
  if (String(pr.status || '') === 'conflicted') {
    return `waiting for ${pr.agentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to resolve merge conflict`;
  }
  return 'waiting for reviewer';
}

function describePullRequestImplementationAction(task, worker) {
  const agentId = task.agentId || `${AGENT_ROLES.IMPLEMENTATION}-agent`;
  const taskState = getImplementationTaskState(task);
  const isRunning = Boolean(
    worker
      && worker.status === 'running'
      && taskState === 'active'
  );
  if (task.type === 'review_followup') {
    return isRunning
      ? `${agentId} responding to ${getRoleLabel(AGENT_ROLES.REVIEW)}`
      : `waiting for ${agentId} to respond to ${getRoleLabel(AGENT_ROLES.REVIEW)}`;
  }
  if (task.type === 'conflict_resolution') {
    return isRunning
      ? `${agentId} resolving merge conflict`
      : `waiting for ${agentId} to resolve merge conflict`;
  }
  return isRunning
    ? `${agentId} updating the PR`
    : `waiting for ${agentId}`;
}

function describePullRequestReviewAction(pr, reviewTask, reviewerWorker) {
  if (reviewTask.status === 'assigned') {
    return reviewerWorker && reviewerWorker.status === 'running'
      ? `${getRoleLabel(AGENT_ROLES.REVIEW)}er ${getRoleLabel(AGENT_ROLES.REVIEW)}ing`
      : `${getRoleLabel(AGENT_ROLES.REVIEW)}er assigned`;
  }
  if (reviewTask.status === 'queued') {
    if (String(pr.status || '') === 'approved') {
      return reviewerWorker && reviewerWorker.status === 'running'
        ? `${getRoleLabel(AGENT_ROLES.REVIEW)}er retrying merge`
        : `waiting for ${getRoleLabel(AGENT_ROLES.REVIEW)}er merge follow-up`;
    }
    return reviewerWorker && reviewerWorker.status === 'running'
      ? `${getRoleLabel(AGENT_ROLES.REVIEW)}er ${getRoleLabel(AGENT_ROLES.REVIEW)}ing`
      : `waiting for ${getRoleLabel(AGENT_ROLES.REVIEW)}er`;
  }
  if (reviewTask.status === 'changes_requested') {
    return `waiting for ${reviewTask.sourceAgentId || pr.agentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to respond to ${getRoleLabel(AGENT_ROLES.REVIEW)}`;
  }
  if (reviewTask.status === 'blocked_conflict') {
    return `waiting for ${reviewTask.sourceAgentId || pr.agentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to resolve merge conflict`;
  }
  if (reviewTask.status === 'approved') {
    return 'approved, waiting for merge';
  }
  return `${getRoleLabel(AGENT_ROLES.REVIEW)} status: ${formatStatusLabel(reviewTask.status)}`;
}

function formatPullRequestStatusLine(prStatus) {
  const numberLabel = prStatus.number ? `PR #${prStatus.number}` : `PR ${prStatus.prId}`;
  return `${numberLabel} | ${formatStatusLabel(prStatus.status)} | ${prStatus.title} | ${prStatus.action}`;
}

function formatStatusLabel(status) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

function selectImplementationTaskForStatus(tasks) {
  const pendingTasks = (tasks || []).filter((task) => !isTerminalTaskStatus(task.status));
  if (pendingTasks.length === 0) {
    return null;
  }
  return pendingTasks
    .slice()
    .sort((left, right) => {
      const rankDiff = rankImplementationTaskForStatus(left) - rankImplementationTaskForStatus(right);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    })[0];
}

function rankImplementationTaskForStatus(task) {
  const taskState = getImplementationTaskState(task);
  if (taskState === 'active') {
    return 0;
  }
  if (taskState === 'queued') {
    return task.type === 'review_followup'
      ? 1
      : task.type === 'conflict_resolution'
        ? 2
        : 3;
  }
  if (task.type === 'review_followup') {
    return 4;
  }
  if (task.type === 'conflict_resolution') {
    return 5;
  }
  return 10;
}

function resolveTaskBranch(task, prById, branchLockByLane) {
  if (task && task.branch) {
    return task.branch;
  }
  if (task && task.execution && task.execution.branch) {
    return task.execution.branch;
  }
  if (task && task.laneKey && branchLockByLane.has(task.laneKey)) {
    return branchLockByLane.get(task.laneKey).branch || null;
  }
  if (task && task.prId && prById.has(task.prId)) {
    return prById.get(task.prId).headBranch || null;
  }
  return null;
}

export { buildPullRequestStatusSummaries, formatPullRequestStatusLine };
