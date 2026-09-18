import fs from 'fs';
import { gitRefExists, readImplementationQueueSnapshot } from './orchestrator-git.js';
import {
  buildTaskBranchName,
  buildTaskLaneKey,
  buildWorktreePath,
  compareImplementationTaskPriority,
  implementationTaskNeedsDispatch,
  isPendingImplementationTask,
  listTasks,
  normalizeNonEmptyString,
} from './helpers.js';

function completedImplementationTaskIds(branchLocks, agentId) {
  return new Set(
    ((branchLocks && branchLocks.locks) || [])
      .filter((lock) => lock && lock.agentId === agentId)
      .flatMap((lock) => ((lock && lock.completedTasks) || []).map((task) => task.id))
      .filter(Boolean)
  );
}

function filterCompletedImplementationTasks(queue, branchLocks, agentId) {
  const completedIds = completedImplementationTaskIds(branchLocks, agentId);
  return {
    ...(queue || {}),
    tasks: listTasks(queue).filter((task) => !completedIds.has(task.id)),
  };
}

function findBranchLockByLane(branchLocks, agentId, laneKey) {
  return ((branchLocks && branchLocks.locks) || []).find((lock) => {
    return lock && lock.agentId === agentId && (lock.laneKey || lock.taskId) === laneKey;
  }) || null;
}

function findTaskById(queue, taskId) {
  return listTasks(queue).find((candidate) => candidate && candidate.id === taskId) || null;
}

function resolveImplementationQueueContext(rootDir, config, branchLocks, agent, fallbackQueue) {
  const locks = ((branchLocks && branchLocks.locks) || [])
    .filter((lock) => lock && lock.agentId === agent.id)
    .slice()
    .sort((left, right) => {
      return (Date.parse(right && right.updatedAt || '') || 0) - (Date.parse(left && left.updatedAt || '') || 0);
    });

  for (const lock of locks) {
    const queue = readImplementationQueueSnapshot(rootDir, config, agent.id, {
      branch: lock.branch || null,
      worktreePath: lock.worktreePath || null,
    });
    if (queue && listTasks(queue).some((task) => isPendingImplementationTask(task))) {
      return {
        source: 'branch',
        queue,
        branch: lock.branch || null,
        worktreePath: lock.worktreePath,
      };
    }
  }

  const branchTasks = listTasks(fallbackQueue)
    .filter((task) => isPendingImplementationTask(task))
    .slice()
    .sort((left, right) => {
      const rankDiff = compareImplementationTaskPriority(left, right);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    });
  const rootTasksBlockedByBranchCompletion = new Set<string>();

  for (const task of branchTasks) {
    const laneKey = buildTaskLaneKey(task);
    const branchLock = findBranchLockByLane(branchLocks, agent.id, laneKey);
    const branch = normalizeNonEmptyString(
      (branchLock && branchLock.branch)
      || task.branch
      || buildTaskBranchName(config, task)
    );
    if (!branch || !gitRefExists(rootDir, branch)) {
      continue;
    }
    const derivedWorktreePath = branchLock && branchLock.worktreePath
      ? branchLock.worktreePath
      : buildWorktreePath(rootDir, config, task);
    const queue = readImplementationQueueSnapshot(rootDir, config, agent.id, {
      branch,
      worktreePath: derivedWorktreePath,
    });
    if (!queue) {
      continue;
    }
    const matchingTask = findTaskById(queue, task.id);
    if (matchingTask && implementationTaskNeedsDispatch(matchingTask)) {
      return {
        source: 'branch',
        queue,
        branch,
        worktreePath: fs.existsSync(derivedWorktreePath) ? derivedWorktreePath : null,
      };
    }
    if (matchingTask && !implementationTaskNeedsDispatch(matchingTask)) {
      rootTasksBlockedByBranchCompletion.add(task.id);
      continue;
    }
    if (listTasks(queue).some((candidate) => implementationTaskNeedsDispatch(candidate))) {
      return {
        source: 'branch',
        queue,
        branch,
        worktreePath: fs.existsSync(derivedWorktreePath) ? derivedWorktreePath : null,
      };
    }
  }

  const filteredRootQueue = filterCompletedImplementationTasks(fallbackQueue, branchLocks, agent.id);

  return {
    source: 'root',
    queue: {
      ...filteredRootQueue,
      tasks: listTasks(filteredRootQueue)
        .filter((task) => !rootTasksBlockedByBranchCompletion.has(task.id)),
    },
    branch: null,
    worktreePath: null,
  };
}

export {
  resolveImplementationQueueContext,
};
