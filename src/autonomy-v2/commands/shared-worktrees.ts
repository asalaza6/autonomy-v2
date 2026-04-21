import fs from 'fs';
import path from 'path';
import { AGENT_ROLES, TASK_TYPES, getRoleLabel, isImplementationRole, isReviewRole } from '../../agents/role-catalog.js';
import type { AnyRecord, AutonomyConfig, BranchLocksState, PullRequestRecord, TaskRecord } from '../autonomy-types.js';
import { ensureDir, getAgent, getAutonomyPaths, readJson, writeJson } from './shared-core.js';
import {
  buildReviewFollowupAcceptance,
  buildTaskBranchName,
  buildTaskLaneKey,
  buildWorktreePath,
  hasStagedGitChanges,
  findBranchLockByLane,
  isGitWorktree,
  resolveBaseRef,
  runGit,
  runGitWorktreeAdd,
  upsertBranchLock,
} from './shared-repo.js';
import {
  buildTaskQueueState,
  findTask,
  getImplementationTaskState,
  getTaskQueue,
} from './shared-queues.js';
import {
  buildImplementationLaneSeedTask,
  findCompletedTask,
  listImplementationLaneTasks,
  resolveImplementationBranchRef,
} from './shared-lanes.js';

function configureWorktreeGitIdentity(worktreePath, agent) {
  if (!agent.gitIdentity) {
    return;
  }

  runGit(worktreePath, ['config', 'extensions.worktreeConfig', 'true']);
  if (agent.gitIdentity.name) {
    runGit(worktreePath, ['config', '--worktree', 'user.name', agent.gitIdentity.name]);
  }
  if (agent.gitIdentity.email) {
    runGit(worktreePath, ['config', '--worktree', 'user.email', agent.gitIdentity.email]);
  }
}

function prepareTaskWorktree(rootDir: string, config: AutonomyConfig, branchLocksState: BranchLocksState, task: TaskRecord, options: AnyRecord = {}) {
  const agent = getAgent(config, task.agentId);
  if (!isImplementationRole(agent.role) && agent.role !== TASK_TYPES.CONFLICT) {
    throw new Error(`Agent "${agent.id}" does not use worktree preparation.`);
  }
  const create = options.create === true;
  const branchName = options.branchName || buildTaskBranchName(config, task);
  const worktreePath = options.worktreePath || buildWorktreePath(rootDir, config, task);
  let mode = create ? 'created' : 'planned';

  if (create) {
    const baseBranch = task.baseBranch || config.integrationBranch;
    const baseRef = resolveBaseRef(rootDir, baseBranch);
    ensureDir(path.dirname(worktreePath));
    const worktreeExists = fs.existsSync(worktreePath);
    const branchExists = [branchName].some((ref) => {
      try {
        runGit(rootDir, ['rev-parse', '--verify', ref]);
        return true;
      } catch (_) {
        return false;
      }
    });

    if (!worktreeExists && branchExists) {
      runGitWorktreeAdd(rootDir, [worktreePath, branchName], worktreePath);
      mode = 'reused-branch';
    } else if (!worktreeExists) {
      runGitWorktreeAdd(rootDir, ['-b', branchName, worktreePath, baseRef], worktreePath);
      mode = 'created';
    } else if (!isGitWorktree(worktreePath)) {
      throw new Error(`Worktree path "${worktreePath}" exists but is not a git worktree.`);
    } else {
      mode = 'reused-worktree';
    }
    configureWorktreeGitIdentity(worktreePath, agent);
  }

  upsertBranchLock(branchLocksState, {
    taskId: task.id,
    laneKey: buildTaskLaneKey(task),
    agentId: task.agentId,
    branch: branchName,
    worktreePath,
    baseBranch: task.baseBranch || config.integrationBranch,
    mode,
    updatedAt: new Date().toISOString(),
  });

  return {
    taskId: task.id,
    branch: branchName,
    worktreePath,
    mode,
  };
}

function getPrimaryReviewer(config) {
  const reviewer = (config.agents || []).find((agent) => isReviewRole(agent.role));
  if (!reviewer) {
    throw new Error('No reviewer agent configured.');
  }
  return reviewer;
}

function ensureReviewerTask(taskQueues, config, pr, sourceTask, now) {
  const reviewer = getPrimaryReviewer(config);
  const reviewerQueue = getTaskQueue(taskQueues, config, reviewer.id);
  const reviewTaskId = `${getRoleLabel(AGENT_ROLES.REVIEW)}-${pr.id}`;
  let reviewTask = reviewerQueue.tasks.find((candidate) => candidate.id === reviewTaskId);
  if (!reviewTask) {
    reviewTask = {
      id: reviewTaskId,
      title: `Review ${pr.title}`,
      description: `Review ${pr.id} for ${sourceTask.title}`,
      agentId: reviewer.id,
      type: TASK_TYPES.REVIEW,
      prId: pr.id,
      sourceTaskId: sourceTask.id,
      sourceAgentId: sourceTask.agentId,
      reviewRound: (pr.reviews || []).length + 1,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    reviewerQueue.tasks.push(reviewTask);
  }
  return reviewTask;
}

function queueReviewerTask(taskQueues, config, pr, sourceTask, now) {
  const reviewerTask = ensureReviewerTask(taskQueues, config, pr, sourceTask, now);
  reviewerTask.title = `Review ${pr.title}`;
  reviewerTask.description = `Review ${pr.id} for ${sourceTask.title}`;
  reviewerTask.headBranch = pr.headBranch;
  reviewerTask.baseBranch = pr.baseBranch;
  reviewerTask.sourceTaskId = sourceTask.id;
  reviewerTask.sourceAgentId = sourceTask.agentId;
  reviewerTask.acceptance = sourceTask.acceptance || [];
  reviewerTask.scopeViolations = (pr.scopeViolations || []).slice();
  reviewerTask.reviewRound = (pr.reviews || []).length + 1;
  reviewerTask.status = 'queued';
  reviewerTask.updatedAt = now;
  return reviewerTask;
}

function getReviewerTask(taskQueues, config, pr) {
  const reviewer = (config.agents || []).find((agent) => isReviewRole(agent.role));
  if (!reviewer) {
    return null;
  }
  const reviewerQueue = getTaskQueue(taskQueues, config, reviewer.id);
  return reviewerQueue.tasks.find((candidate) => candidate.id === `${getRoleLabel(AGENT_ROLES.REVIEW)}-${pr.id}`) || null;
}

function getImplementationConversationId(record) {
  return String(record && record.implementationConversationId || '').trim();
}

function resolveFollowupImplementationConversationId(patch, pr, tasks: TaskRecord[] = []) {
  const patchConversationId = getImplementationConversationId(patch);
  if (patchConversationId) {
    return patchConversationId;
  }
  for (const candidate of tasks || []) {
    const isSourceTask = candidate.id === pr.taskId
      || (Array.isArray(pr.completedTaskIds) && pr.completedTaskIds.includes(candidate.id));
    const conversationId = isSourceTask ? getImplementationConversationId(candidate) : '';
    if (conversationId) {
      return conversationId;
    }
  }
  return '';
}

function enqueueLaneFollowupTask(taskQueues, config, pr, patch) {
  const queue = getTaskQueue(taskQueues, config, pr.agentId);
  const taskId = patch.id;
  let task = queue.tasks.find((candidate) => candidate.id === taskId);
  const implementationConversationId = resolveFollowupImplementationConversationId(patch, pr, queue.tasks || []);
  const nextDescription = String(
    patch.description
      || (task && task.description)
      || `Address ${getRoleLabel(AGENT_ROLES.REVIEW)}er feedback for ${pr.title}`
  ).trim();
  if (!task) {
    task = {
      id: taskId,
      title: patch.title,
      description: nextDescription,
      agentId: pr.agentId,
      prdId: pr.prdId || undefined,
      laneKey: pr.laneKey || pr.taskId,
      type: patch.type || TASK_TYPES.DEFAULT,
      sprintId: pr.sprintId || 'shared',
      baseBranch: pr.baseBranch,
      checks: [],
      acceptance: buildReviewFollowupAcceptance(pr, nextDescription),
      status: 'queued',
      createdAt: patch.createdAt || new Date().toISOString(),
      updatedAt: patch.updatedAt || new Date().toISOString(),
      prId: pr.id,
    };
    if (implementationConversationId) {
      task.implementationConversationId = implementationConversationId;
    }
    if (!task.prdId) {
      delete task.prdId;
    }
    queue.tasks.push(task);
    return task;
  }

  task.title = patch.title || task.title;
  task.description = nextDescription;
  task.type = patch.type || task.type;
  task.acceptance = buildReviewFollowupAcceptance(pr, nextDescription, task.acceptance);
  task.status = 'queued';
  task.updatedAt = patch.updatedAt || new Date().toISOString();
  task.prId = pr.id;
  if (implementationConversationId) {
    task.implementationConversationId = implementationConversationId;
  }
  return task;
}

function buildLaneFollowupTaskId(pr) {
  return `${pr.agentId}-followup-${pr.id}-${(pr.reviews || []).length}`;
}

function buildLaneConflictTaskId(pr) {
  const conflictCount = Array.isArray(pr.conflicts) ? pr.conflicts.length + 1 : 1;
  return `${pr.agentId}-conflict-${pr.id}-${conflictCount}`;
}

function ensureImplementationLaneWorktree(rootDir: string, state: AnyRecord, pr: PullRequestRecord, options: AnyRecord = {}) {
  const agent = getAgent(state.config, pr.agentId);
  if (!isImplementationRole(agent.role)) {
    throw new Error(`Agent "${agent.id}" does not use tracked ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} queues.`);
  }
  const laneKey = pr.laneKey || pr.taskId;
  const laneContext = listImplementationLaneTasks(rootDir, state, pr.agentId, laneKey, {
    pr,
    task: options.task || null,
  });
  const seedTask = laneContext.task || buildImplementationLaneSeedTask(
    state.config,
    state.branchLocks,
    state.taskQueues,
    pr.agentId,
    laneKey,
    { pr, task: options.task || null }
  );
  if (!seedTask) {
    throw new Error(`Unable to resolve lane task state for ${pr.id}.`);
  }
  let branch = laneContext.branch || resolveImplementationBranchRef(
    rootDir,
    state.config,
    state.branchLocks,
    pr.agentId,
    laneKey,
    { pr, task: seedTask }
  );
  if (!branch) {
    const fallbackBranch = buildTaskBranchName(state.config, seedTask);
    const branchLock = findBranchLockByLane(state.branchLocks, pr.agentId, laneKey);
    if (branchLock) {
      branchLock.branch = fallbackBranch;
      branchLock.taskId = branchLock.taskId || seedTask.id || pr.taskId;
      branchLock.laneKey = branchLock.laneKey || laneKey;
      branchLock.baseBranch = seedTask.baseBranch || pr.baseBranch || state.config.integrationBranch;
      branchLock.updatedAt = new Date().toISOString();
      if (!branchLock.worktreePath) {
        branchLock.worktreePath = laneContext.worktreePath || buildWorktreePath(rootDir, state.config, seedTask);
      }
    }
    branch = fallbackBranch;
  }

  const preparedTask = {
    ...seedTask,
    id: seedTask.id || pr.taskId,
    agentId: pr.agentId,
    laneKey,
    sprintId: seedTask.sprintId || pr.sprintId || 'shared',
    baseBranch: seedTask.baseBranch || pr.baseBranch || state.config.integrationBranch,
  };
  if (pr.prdId && !preparedTask.prdId) {
    preparedTask.prdId = pr.prdId;
  }

  const payload = prepareTaskWorktree(rootDir, state.config, state.branchLocks, preparedTask, {
    create: true,
    branchName: branch,
    worktreePath: laneContext.worktreePath || buildWorktreePath(rootDir, state.config, preparedTask),
  });
  writeJson(getAutonomyPaths(rootDir).branchLocksState, state.branchLocks);
  return payload;
}

function appendTrackedBranchFollowupTask(rootDir, state, pr, patch) {
  const agent = getAgent(state.config, pr.agentId);
  if (!isImplementationRole(agent.role)) {
    return null;
  }
  const baseTask = findTask(state.taskQueues, pr.taskId)
    || findCompletedTask(state.branchLocks, pr.taskId)
    || null;
  const worktree = ensureImplementationLaneWorktree(rootDir, state, pr, { task: baseTask });

  const relativePath = agent.taskQueue;
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Implementation queue for "${agent.id}" must be repo-relative inside the worktree.`);
  }
  const queuePath = path.join(worktree.worktreePath, relativePath);
  const queueState = fs.existsSync(queuePath)
    ? readJson(queuePath)
    : buildTaskQueueState(agent, []);
  const tasks = Array.isArray(queueState.tasks) ? queueState.tasks : [];
  const taskId = patch.id;
  const implementationConversationId = resolveFollowupImplementationConversationId(patch, pr, tasks);
  const nextDescription = String(
    patch.description
      || 'Address reviewer feedback'
  ).trim();
  let task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    const hasActiveTask = tasks.some((candidate) => getImplementationTaskState(candidate) === 'active');
    task = {
      id: taskId,
      title: patch.title,
      description: nextDescription,
      agentId: pr.agentId,
      prdId: pr.prdId || undefined,
      laneKey: pr.laneKey || pr.taskId,
      type: patch.type || 'review_followup',
      source: patch.source || patch.type || 'review_followup',
      sprintId: pr.sprintId || 'shared',
      baseBranch: pr.baseBranch,
      checks: [],
      acceptance: buildReviewFollowupAcceptance(pr, nextDescription),
      state: hasActiveTask ? 'queued' : 'active',
      status: hasActiveTask ? 'queued' : 'active',
      branch: worktree.branch || null,
      createdAt: patch.createdAt || new Date().toISOString(),
      updatedAt: patch.updatedAt || new Date().toISOString(),
      startedAt: hasActiveTask ? null : (patch.updatedAt || new Date().toISOString()),
      prId: pr.id,
    };
    if (implementationConversationId) {
      task.implementationConversationId = implementationConversationId;
    }
    if (!task.prdId) {
      delete task.prdId;
    }
    tasks.push(task);
  } else {
    task.title = patch.title || task.title;
    task.description = nextDescription;
    task.type = patch.type || task.type;
    task.source = patch.source || patch.type || task.source || 'review_followup';
    task.acceptance = buildReviewFollowupAcceptance(pr, nextDescription, task.acceptance);
    task.updatedAt = patch.updatedAt || new Date().toISOString();
    task.prId = pr.id;
    if (implementationConversationId) {
      task.implementationConversationId = implementationConversationId;
    }
    if (!tasks.some((candidate) => candidate.id !== task.id && getImplementationTaskState(candidate) === 'active')) {
      task.state = 'active';
      task.status = 'active';
      task.startedAt = task.startedAt || task.updatedAt;
      task.branch = worktree.branch || task.branch || null;
    }
  }

  writeJson(queuePath, buildTaskQueueState(agent, tasks));
  runGit(worktree.worktreePath, ['add', '--', relativePath]);
  if (hasStagedGitChanges(worktree.worktreePath)) {
    runGit(worktree.worktreePath, ['commit', '-m', `auto(${pr.agentId}): queue ${task.id}`]);
  }
  return task;
}

export {
  appendTrackedBranchFollowupTask,
  buildLaneConflictTaskId,
  buildLaneFollowupTaskId,
  
  ensureReviewerTask,
  enqueueLaneFollowupTask,
  getReviewerTask,
  prepareTaskWorktree,
  queueReviewerTask,
};
