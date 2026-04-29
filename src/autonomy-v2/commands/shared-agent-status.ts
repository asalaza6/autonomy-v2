import { AGENT_ROLES, getRoleAgentLabel, getRoleLabel, isPmRole, isReviewRole } from '../../agents/role-catalog.js';
import type { AnyRecord } from '../autonomy-types.js';
import { getTaskQueue, filterCompletedImplementationQueueTasks, getImplementationTaskState, isTerminalTaskStatus, listTasks as listQueueTasks } from './shared-queues.js';
import { normalizeLaneKey } from './shared-core.js';
import { reviewTaskHasActionableImplementationWork } from '../../sync/review-reconciliation.js';
import { resolveImplementationQueueContext } from '../../server/orchestrator/queues.js';

function buildAgentStatusSummaries({ rootDir, config, taskQueues, prs, branchLocks, runtime, prds }) {
  const prById = new Map((prs.pullRequests || []).map((pr) => [pr.id, pr]));
  const branchLockByLane = new Map(
    (branchLocks.locks || [])
      .map((lock) => [normalizeLaneKey(lock), lock])
      .filter(([laneKey]) => laneKey)
  );

  return (config.agents || []).map((agent) => {
    const queue = getTaskQueue(taskQueues, config, agent.id);
    const worker = ((runtime && runtime.workers) || {})[agent.id] || {
      agentId: agent.id,
      status: 'idle',
      pid: null,
    };
    if (isPmRole(agent.role)) {
      return buildPmAgentStatus(agent, worker, prds);
    }
    if (isReviewRole(agent.role)) {
      return buildReviewAgentStatus(agent, queue, worker, prById, listQueueTasks(taskQueues));
    }
    return buildImplementationAgentStatus(rootDir, config, branchLocks, agent, queue, worker, prById, branchLockByLane);
  });
}

function buildPmAgentStatus(agent, worker, prds) {
  const pendingPrds = (prds.prds || []).filter((prd) => ['planned', 'queued', 'planning'].includes(prd.status));
  let detail = 'no PRDs awaiting planning';
  if (pendingPrds.length > 0) {
    const label = `${pendingPrds.length} PRD${pendingPrds.length === 1 ? '' : 's'} awaiting planning`;
    detail = worker.status === 'running'
      ? `planning backlog (${label})`
      : label;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }
  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
  };
}

function buildImplementationAgentStatus(rootDir, config, branchLocksState, agent, queue, worker, prById, branchLockByLane) {
  const resolvedQueueState = resolveImplementationQueueContext(rootDir, config, branchLocksState, agent, queue);
  const trackedQueue = filterCompletedImplementationQueueTasks(queue, branchLocksState, agent.id);
  const tasks = (resolvedQueueState.queue && resolvedQueueState.queue.tasks) || [];
  const trackedTasks = (trackedQueue && trackedQueue.tasks) || [];
  const activeTask = selectImplementationTaskForStatus(tasks);
  const extraCount = countAdditionalPendingTasks(tasks, activeTask && activeTask.id);
  const branch = resolvedQueueState.branch || (activeTask ? resolveTaskBranch(activeTask, prById, branchLockByLane) : null);
  const queueIssue = buildImplementationQueueIssue(trackedTasks, tasks, worker);

  let detail = queueIssue
    ? `[${queueIssue.code}] ${queueIssue.message}`
    : 'no queued tasks';
  if (activeTask) {
    const taskState = getImplementationTaskState(activeTask);
    const prefix = worker.status === 'running'
      ? (taskState === 'active'
        ? 'working on'
        : 'starting')
      : taskState === 'active'
        ? 'current task'
        : (activeTask.type === 'review_followup' ? `queued ${getRoleLabel(AGENT_ROLES.REVIEW)} follow-up` : 'next task');
    detail = `${prefix} ${describeImplementationTask(activeTask)}`;
  }
  if (extraCount > 0) {
    detail = `${detail} | ${extraCount} more queued`;
  }
  if (branch) {
    detail = `${detail} | branch=${branch}`;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }

  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
    activeTaskId: activeTask ? activeTask.id : null,
    branch,
    queueIssueCode: queueIssue ? queueIssue.code : null,
  };
}

function buildImplementationQueueIssue(trackedTasks, resolvedTasks, worker) {
  const pendingTrackedTasks = (trackedTasks || []).filter((task) => !isTerminalTaskStatus(getImplementationTaskState(task)));
  if (pendingTrackedTasks.length === 0) {
    return null;
  }
  const pendingResolvedTasks = (resolvedTasks || []).filter((task) => !isTerminalTaskStatus(getImplementationTaskState(task)));
  if (pendingResolvedTasks.length > 0) {
    return null;
  }

  const noopReason = String(worker && worker.lastResult && worker.lastResult.reason || '').trim();
  const lastError = String(worker && worker.lastError || '').trim();
  if (noopReason === 'no_queued_task') {
    return {
      code: 'pickup_error',
      message: `tracked queue still contains ${pendingTrackedTasks.length} queued task${pendingTrackedTasks.length === 1 ? '' : 's'}, but worker pickup reported no queued task`,
    };
  }
  if (/worker process exited before reporting result/i.test(lastError)) {
    return {
      code: 'stale_worker',
      message: `tracked queue still contains ${pendingTrackedTasks.length} queued task${pendingTrackedTasks.length === 1 ? '' : 's'}, but the last worker exited before pickup completed`,
    };
  }
  return {
    code: 'queue_reconciliation_error',
    message: `tracked queue still contains ${pendingTrackedTasks.length} queued task${pendingTrackedTasks.length === 1 ? '' : 's'}, but runtime queue reconstruction found no runnable work`,
  };
}

function buildReviewAgentStatus(agent, queue, worker, prById, allTasks) {
  const tasks = queue.tasks || [];
  const implementationTasks = (allTasks || []).filter((task) => task && task.type !== 'review');
  const assignedTask = tasks.find((task) => task.status === 'assigned') || null;
  const queuedTask = tasks.find((task) => task.status === 'queued') || null;
  const blockedTask = tasks.find((task) => {
    const pr = task && task.prId ? prById.get(task.prId) || null : null;
    return task.status === 'changes_requested'
      && reviewTaskHasActionableImplementationWork(task, pr, implementationTasks);
  }) || null;
  const failedTask = tasks.find((task) => task.status === 'failed') || null;
  const pendingReviewTasks = tasks.filter((task) => {
    if (!task || ['assigned', 'queued', 'failed'].includes(task.status)) {
      return Boolean(task);
    }
    if (task.status !== 'changes_requested') {
      return false;
    }
    const pr = task.prId ? prById.get(task.prId) || null : null;
    return reviewTaskHasActionableImplementationWork(task, pr, implementationTasks);
  });
  const extraCount = countAdditionalPendingTasks(
    pendingReviewTasks,
    (assignedTask || queuedTask || blockedTask || failedTask || {}).id
  );

  let detail = `no ${getRoleLabel(AGENT_ROLES.REVIEW)} tasks`;
  if (worker.status === 'running' && (assignedTask || queuedTask)) {
    detail = `${assignedTask ? `${getRoleLabel(AGENT_ROLES.REVIEW)}ing` : `starting ${getRoleLabel(AGENT_ROLES.REVIEW)} of`} ${describeReviewTask(assignedTask || queuedTask, prById)}`;
  } else if (queuedTask) {
    detail = `next ${getRoleLabel(AGENT_ROLES.REVIEW)} ${describeReviewTask(queuedTask, prById)}`;
  } else if (blockedTask) {
    const pr = blockedTask.prId ? prById.get(blockedTask.prId) : null;
    detail = `waiting for ${blockedTask.sourceAgentId || getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} to address ${describeReviewTarget(pr, blockedTask.prId)}`;
  } else if (failedTask) {
    detail = `failed ${getRoleLabel(AGENT_ROLES.REVIEW)} ${describeReviewTask(failedTask, prById)}`;
  }
  if (extraCount > 0) {
    detail = `${detail} | ${extraCount} more pending`;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }

  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
    activeTaskId: assignedTask ? assignedTask.id : queuedTask ? queuedTask.id : null,
  };
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

function countAdditionalPendingTasks(tasks, primaryTaskId) {
  const pendingCount = (tasks || []).filter((task) => !isTerminalTaskStatus(task.status)).length;
  if (!primaryTaskId) {
    return pendingCount;
  }
  return Math.max(0, pendingCount - 1);
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

function describeImplementationTask(task) {
  const typeLabel = task.type === 'review_followup'
    ? `${getRoleLabel(AGENT_ROLES.REVIEW)} follow-up`
    : task.type === 'conflict_resolution'
      ? 'conflict resolution'
      : 'task';
  return `${typeLabel} "${task.title}" (${task.id})`;
}

function describeReviewTask(task, prById) {
  const pr = task && task.prId ? prById.get(task.prId) : null;
  return `${describeReviewTarget(pr, task && task.prId)} from ${task && task.sourceAgentId ? task.sourceAgentId : 'unknown source'}`;
}

function describeReviewTarget(pr, fallbackPrId) {
  const prLabel = pr && pr.remote && pr.remote.number
    ? `PR #${pr.remote.number}`
    : `PR ${fallbackPrId || (pr && pr.id) || 'unknown'}`;
  const prTitle = pr && pr.title ? pr.title : '';
  return prTitle ? `${prLabel} "${prTitle}"` : prLabel;
}

function summarizeStatusText(value, maxLength = 120) {
  const summary = String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
  if (summary.length <= maxLength) {
    return summary;
  }
  return `${summary.slice(0, maxLength - 1)}…`;
}

function formatAgentStatusLine(agentStatus: AnyRecord, options: AnyRecord = {}) {
  const parts = [
    agentStatus.agentId,
    agentStatus.role,
    agentStatus.workerStatus,
  ];
  if (options.includePid === true) {
    parts.push(`pid=${agentStatus.pid || '-'}`);
  }
  if (agentStatus.detail) {
    parts.push(agentStatus.detail);
  }
  return parts.join(' | ');
}

export { buildAgentStatusSummaries, formatAgentStatusLine };
