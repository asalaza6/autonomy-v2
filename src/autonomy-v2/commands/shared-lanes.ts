import fs from 'fs';
import type { AnyRecord, AutonomyConfig, BranchLocksState, QueueMap, TaskRecord } from '../../types.js';
import { buildTaskQueueState, readImplementationQueueSnapshot } from './shared-queues.js';
import { getAgent } from './shared-core.js';
import {
  buildTaskBranchName,
  buildTaskLaneKey,
  buildWorktreePath,
  findBranchLockByLane,
  gitRefExists,
  uniqueStrings,
} from './shared-repo.js';

function findCompletedTask(branchLocksState, taskId) {
  for (const branchLock of (branchLocksState && branchLocksState.locks) || []) {
    const task = ((branchLock && branchLock.completedTasks) || []).find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

function findImplementationTaskInBranchQueues(rootDir, config, branchLocksState, taskId) {
  const locks = ((branchLocksState && branchLocksState.locks) || [])
    .slice()
    .sort((left, right) => {
      return (Date.parse(right && right.updatedAt || '') || 0) - (Date.parse(left && left.updatedAt || '') || 0);
    });

  for (const lock of locks) {
    if (!lock || !lock.agentId) {
      continue;
    }
    const queueState = readImplementationQueueSnapshot(rootDir, config, lock.agentId, {
      branch: lock.branch || null,
      worktreePath: lock.worktreePath || null,
    });
    if (!queueState) {
      continue;
    }
    const task = (queueState.tasks || []).find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

function resolvePrRecordTask(rootDir, state, taskId) {
  const liveTask = findTask(state.taskQueues, taskId);
  if (liveTask) {
    return liveTask;
  }
  const branchTask = findImplementationTaskInBranchQueues(rootDir, state.config, state.branchLocks, taskId);
  if (branchTask) {
    return branchTask;
  }
  const completedTask = findCompletedTask(state.branchLocks, taskId);
  if (completedTask) {
    return completedTask;
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function resolveTaskForWorktreePreparation(rootDir, state, taskId) {
  const liveTask = findTask(state.taskQueues, taskId);
  if (liveTask) {
    return liveTask;
  }
  const completedTask = findCompletedTask(state.branchLocks, taskId);
  if (completedTask) {
    return completedTask;
  }
  const branchTask = findImplementationTaskInBranchQueues(rootDir, state.config, state.branchLocks, taskId);
  if (branchTask) {
    return branchTask;
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function findTask(taskQueues: QueueMap, taskId: string): TaskRecord | null {
  for (const queue of Object.values(taskQueues)) {
    const task = queue.tasks.find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

function listLaneTasks(taskQueues: QueueMap, agentId: string, laneKey: string): TaskRecord[] {
  return Object.values(taskQueues)
    .filter((queue) => queue.agentId === agentId)
    .flatMap((queue) => queue.tasks)
    .filter((task) => buildTaskLaneKey(task) === laneKey);
}

function findLatestCompletedLaneTask(branchLocksState, agentId, laneKey) {
  const completedLaneTasks = listCompletedLaneTasks(branchLocksState, agentId, laneKey);
  return completedLaneTasks.length > 0
    ? completedLaneTasks[completedLaneTasks.length - 1]
    : null;
}

function buildImplementationLaneSeedTask(config: AutonomyConfig, branchLocksState: BranchLocksState, taskQueues: QueueMap, agentId: string, laneKey: string, options: AnyRecord = {}) {
  if (options.task) {
    return options.task;
  }
  const liveLaneTasks = listLaneTasks(taskQueues, agentId, laneKey);
  if (liveLaneTasks.length > 0) {
    return liveLaneTasks[0];
  }
  const completedTask = findLatestCompletedLaneTask(branchLocksState, agentId, laneKey);
  if (completedTask) {
    return completedTask;
  }
  if (options.pr) {
    const seedTask: TaskRecord = {
      id: options.pr.taskId || `${agentId}-${laneKey}`,
      agentId,
      laneKey,
      sprintId: options.pr.sprintId || 'shared',
      baseBranch: options.pr.baseBranch || config.integrationBranch,
    };
    if (options.pr.prdId) {
      seedTask.prdId = options.pr.prdId;
    }
    return seedTask;
  }
  return null;
}

function resolveImplementationBranchRef(rootDir: string, config: AutonomyConfig, branchLocksState: BranchLocksState, agentId: string, laneKey: string, options: AnyRecord = {}) {
  const branchLock = findBranchLockByLane(branchLocksState, agentId, laneKey);
  const seedTask = buildImplementationLaneSeedTask(config, branchLocksState, {} as QueueMap, agentId, laneKey, options);
  const branchCandidates = uniqueStrings([
    options.branchHint,
    branchLock ? branchLock.branch : null,
    options.pr ? options.pr.headBranch : null,
    options.task ? options.task.branch : null,
    seedTask ? buildTaskBranchName(config, seedTask) : null,
  ]);

  return branchCandidates.find((candidate) => gitRefExists(rootDir, candidate)) || null;
}

function listImplementationLaneTasks(rootDir: string, state: AnyRecord, agentId: string, laneKey: string, options: AnyRecord = {}) {
  const seedTask = buildImplementationLaneSeedTask(state.config, state.branchLocks, state.taskQueues, agentId, laneKey, options);
  const branch = resolveImplementationBranchRef(rootDir, state.config, state.branchLocks, agentId, laneKey, {
    ...options,
    task: options.task || seedTask || null,
  });
  const branchLock = findBranchLockByLane(state.branchLocks, agentId, laneKey);
  const fallbackWorktreePath = seedTask
    ? buildWorktreePath(rootDir, state.config, seedTask)
    : null;
  const queueState = readImplementationQueueSnapshot(rootDir, state.config, agentId, {
    branch,
    worktreePath: branchLock && branchLock.worktreePath
      ? branchLock.worktreePath
      : fallbackWorktreePath,
  });
  if (!queueState) {
    return {
      tasks: listLaneTasks(state.taskQueues, agentId, laneKey),
      branch: null,
      worktreePath: branchLock ? branchLock.worktreePath || null : null,
      source: 'root',
      task: seedTask,
    };
  }
  return {
    tasks: (queueState.tasks || []).filter((task) => buildTaskLaneKey(task) === laneKey),
    branch,
    worktreePath: branchLock && branchLock.worktreePath
      ? branchLock.worktreePath
      : (fallbackWorktreePath && fs.existsSync(fallbackWorktreePath) ? fallbackWorktreePath : null),
    source: 'branch',
    task: seedTask,
  };
}

function listCompletedLaneTasks(branchLocksState, agentId, laneKey) {
  const branchLock = findBranchLockByLane(branchLocksState, agentId, laneKey);
  if (!branchLock || !Array.isArray(branchLock.completedTasks)) {
    return [];
  }
  return branchLock.completedTasks
    .slice()
    .sort((left, right) => String(left.completedAt || '').localeCompare(String(right.completedAt || '')));
}

export {
  buildImplementationLaneSeedTask,
  findCompletedTask,
  findImplementationTaskInBranchQueues,
  findLatestCompletedLaneTask,
  listCompletedLaneTasks,
  listImplementationLaneTasks,
  listLaneTasks,
  resolveImplementationBranchRef,
  resolvePrRecordTask,
  resolveTaskForWorktreePreparation,
};
