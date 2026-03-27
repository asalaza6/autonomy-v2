import fs from 'fs';
import { AGENT_ROLES, TASK_TYPES, getRoleAgentLabel, getRoleLabel, isPmRole, isReviewRole } from '../../agents/role-catalog.js';
import type { AnyRecord } from '../types.js';
import { getTaskQueue, readImplementationQueueSnapshot, filterCompletedImplementationQueueTasks, getImplementationTaskState, isTerminalTaskStatus } from './shared-queues.js';
import { resolveImplementationBranchRef } from './shared-lanes.js';
import { buildTaskLaneKey, buildWorktreePath } from './shared-repo.js';
import { normalizeLaneKey } from './shared-core.js';

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
      return buildReviewAgentStatus(agent, queue, worker, prById);
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
  const resolvedQueueState = resolveImplementationStatusQueue(rootDir, config, branchLocksState, agent, queue);
  const tasks = (resolvedQueueState.queue && resolvedQueueState.queue.tasks) || [];
  const activeTask = selectImplementationTaskForStatus(tasks);
  const extraCount = countAdditionalPendingTasks(tasks, activeTask && activeTask.id);
  const branch = resolvedQueueState.branch || (activeTask ? resolveTaskBranch(activeTask, prById, branchLockByLane) : null);

  let detail = 'no queued tasks';
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
  };
}

function resolveImplementationStatusQueue(rootDir, config, branchLocksState, agent, fallbackQueue) {
  const branchQueueState = readLatestImplementationBranchQueue(rootDir, config, branchLocksState, agent, fallbackQueue);
  if (branchQueueState) {
    return branchQueueState;
  }
  return {
    queue: filterCompletedImplementationQueueTasks(fallbackQueue, branchLocksState, agent.id),
    branch: null,
    worktreePath: null,
  };
}

function readLatestImplementationBranchQueue(rootDir, config, branchLocksState, agent, fallbackQueue) {
  const agentId = agent.id;
  const locks = ((branchLocksState && branchLocksState.locks) || [])
    .filter((lock) => lock && lock.agentId === agentId)
    .slice()
    .sort((left, right) => {
      return (Date.parse(right && right.updatedAt || '') || 0) - (Date.parse(left && left.updatedAt || '') || 0);
    });

  for (const lock of locks) {
    const queueState = readImplementationQueueSnapshot(rootDir, config, agentId, {
      branch: lock.branch || null,
      worktreePath: lock.worktreePath || null,
    });
    if (!queueState) {
      continue;
    }
    const pendingTasks = (queueState.tasks || []).filter((task) => !isTerminalTaskStatus(getImplementationTaskState(task)));
    if (pendingTasks.length > 0) {
      return {
        queue: queueState,
        branch: lock.branch || null,
        worktreePath: lock.worktreePath,
      };
    }
  }

  const branchTasks = (fallbackQueue && Array.isArray(fallbackQueue.tasks) ? fallbackQueue.tasks : [])
    .filter((task) => !isTerminalTaskStatus(getImplementationTaskState(task)))
    .slice()
    .sort((left, right) => {
      const rankDiff = rankImplementationTaskForStatus(left) - rankImplementationTaskForStatus(right);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    });

  for (const task of branchTasks) {
    const branch = resolveImplementationBranchRef(rootDir, config, branchLocksState, task.agentId, buildTaskLaneKey(task), {
      task,
    });
    if (!branch) {
      continue;
    }
    const queueState = readImplementationQueueSnapshot(rootDir, config, agentId, {
      branch,
      worktreePath: buildWorktreePath(rootDir, config, task),
    });
    if (!queueState) {
      continue;
    }
    const pendingTasks = (queueState.tasks || []).filter((candidate) => !isTerminalTaskStatus(getImplementationTaskState(candidate)));
    if (pendingTasks.length > 0) {
      return {
        queue: queueState,
        branch,
        worktreePath: fs.existsSync(buildWorktreePath(rootDir, config, task))
          ? buildWorktreePath(rootDir, config, task)
          : null,
      };
    }
  }

  return null;
}

function buildReviewAgentStatus(agent, queue, worker, prById) {
  const tasks = queue.tasks || [];
  const assignedTask = tasks.find((task) => task.status === 'assigned') || null;
  const queuedTask = tasks.find((task) => task.status === 'queued') || null;
  const blockedTask = tasks.find((task) => task.status === 'changes_requested') || null;
  const failedTask = tasks.find((task) => task.status === 'failed') || null;
  const extraCount = countAdditionalPendingTasks(
    tasks.filter((task) => ['assigned', 'queued', 'changes_requested', 'failed'].includes(task.status)),
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
