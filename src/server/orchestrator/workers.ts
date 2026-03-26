import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { acquireStateLock } from '../../lock/index.js';
import { isImplementationRole, isPmRole, isReviewRole } from '../../agents/role-catalog.js';
import { CLI_PATH, DEFAULT_RUNNER_PATH } from './constants.js';
import { executeRunnerCommand, extractExecError, hasStagedGitChanges, runGit } from './git.js';
import { buildTaskQueueState, getAgent, listTasks, selectImplementationTask } from './helpers.js';
import { getRunnerErrorReportPath, readJson, writeJson } from './paths.js';
import { loadBranchLocks, loadConfig, loadPrds, loadRuntime, appendAgentLog } from './state.js';
import { runPmWorker } from './planning.js';
import { loadQueues, resolveImplementationQueueContext, writeQueueAndAggregate } from './queues.js';

function claimQueuedReviewTask(rootDir, config, agentId) {
  const release = acquireStateLock(rootDir);
  try {
    const queues = loadQueues(rootDir, config);
    const reviewerQueue = queues[agentId];
    const reviewTask = listTasks(reviewerQueue).find((task) => task.status === 'queued');
    if (!reviewTask) {
      return null;
    }
    reviewTask.status = 'assigned';
    reviewTask.dispatchedAt = new Date().toISOString();
    reviewTask.dispatcher = 'scheduler';
    writeQueueAndAggregate(rootDir, config, agentId, reviewerQueue, {
      commitMessage: `autonomy(queue): assign ${reviewTask.id}`,
      gitIdentity: getAgent(config, agentId).gitIdentity,
    });
    return JSON.parse(JSON.stringify(reviewTask));
  } finally {
    release();
  }
}

function markReviewDispatchFailure(rootDir, config, agentId, taskId, message) {
  const release = acquireStateLock(rootDir);
  try {
    const queues = loadQueues(rootDir, config);
    const queue = queues[agentId];
    const task = listTasks(queue).find((candidate) => candidate.id === taskId);
    if (!task) {
      return;
    }
    task.status = 'failed';
    task.updatedAt = new Date().toISOString();
    task.lastError = message;
    delete task.dispatchedAt;
    delete task.dispatcher;
    writeQueueAndAggregate(rootDir, config, agentId, queue, {
      commitMessage: `autonomy(queue): fail ${taskId}`,
      gitIdentity: getAgent(config, agentId).gitIdentity,
    });
  } finally {
    release();
  }
}

function runReviewerWorker(rootDir, config, agent) {
  const reviewTask = claimQueuedReviewTask(rootDir, config, agent.id);
  if (!reviewTask) {
    return { ok: true, status: 'noop', reason: 'no_queued_review' };
  }

  let runner = null;
  try {
    runner = executeRunnerCommand([process.execPath, DEFAULT_RUNNER_PATH], {
      AUTONOMY_ROOT: rootDir,
      AUTONOMY_AGENT_ID: agent.id,
      AUTONOMY_REVIEW_TASK_ID: reviewTask.id,
      AUTONOMY_PR_ID: reviewTask.prId || '',
      AUTONOMY_SOURCE_AGENT_ID: reviewTask.sourceAgentId || '',
      AUTONOMY_ERROR_REPORT: getRunnerErrorReportPath(rootDir, agent.id),
    });
  } catch (error) {
    markReviewDispatchFailure(rootDir, config, agent.id, reviewTask.id, extractExecError(error));
    throw error;
  }
  appendAgentLog(rootDir, config, agent.id, 'worker:dispatch', {
    input: {
      taskId: reviewTask.id,
      prId: reviewTask.prId,
    },
    output: {
      status: reviewTask.status,
      runner,
    },
  });

  return {
    ok: true,
    status: 'assigned',
    taskId: reviewTask.id,
    prId: reviewTask.prId,
    runner,
  };
}

function claimImplementationTaskInWorktree(config, agent, task, branch, worktreePath) {
  const relativePath = agent.taskQueue;
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Implementation queue for "${agent.id}" must be repo-relative inside the worktree.`);
  }
  const queuePath = path.join(worktreePath, relativePath);
  const queueState = fs.existsSync(queuePath)
    ? readJson(queuePath, buildTaskQueueState(agent, []))
    : buildTaskQueueState(agent, []);
  const tasks = listTasks(queueState).map((candidate) => ({ ...candidate }));
  const nextTask = tasks.find((candidate) => candidate.id === task.id);
  if (!nextTask) {
    throw new Error(`Task "${task.id}" disappeared before branch-local claim.`);
  }
  const claimedAt = new Date().toISOString();
  nextTask.state = 'active';
  nextTask.status = 'active';
  nextTask.branch = branch;
  nextTask.startedAt = nextTask.startedAt || claimedAt;
  nextTask.updatedAt = claimedAt;
  delete nextTask.completedAt;
  delete nextTask.commitSha;
  delete nextTask.completionMode;
  delete nextTask.lastError;

  writeJson(queuePath, buildTaskQueueState(agent, tasks));
  runGit(worktreePath, ['add', '--', relativePath]);
  if (hasStagedGitChanges(worktreePath)) {
    runGit(worktreePath, ['commit', '-m', `auto(${agent.id}): start ${task.id}`]);
  }

  return {
    task: nextTask,
    branch,
  };
}

function markImplementationDispatchFailure(rootDir, config, agentId, taskId, message) {
  void rootDir;
  void config;
  void agentId;
  void taskId;
  void message;
}

function runImplementationWorker(rootDir, config, agent) {
  const queues = loadQueues(rootDir, config);
  const queue = queues[agent.id];
  const branchLocks = loadBranchLocks(rootDir);
  const prds = loadPrds(rootDir, config, { queues });
  const queueContext = resolveImplementationQueueContext(rootDir, config, branchLocks, agent, queue);
  const task = selectImplementationTask(listTasks(queueContext.queue), prds.prds || []);
  if (!task) {
    return { ok: true, status: 'noop', reason: 'no_queued_task' };
  }

  let branch = queueContext.branch || task.branch || null;
  let worktreePath = queueContext.worktreePath || null;
  let dispatchTask = task;
  if (queueContext.source !== 'branch' || !worktreePath || !fs.existsSync(worktreePath)) {
    const worktreePayload = JSON.parse(
      execFileSync(process.execPath, [CLI_PATH, 'worktree:prepare', '--root', rootDir, '--task', task.id, '--create', '--json'], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()
    );
    branch = worktreePayload.branch;
    worktreePath = worktreePayload.worktreePath;
  }
  if (queueContext.source !== 'branch') {
    const claim = claimImplementationTaskInWorktree(config, agent, task, branch, worktreePath);
    branch = claim.branch;
    dispatchTask = claim.task;
  }

  let runner = null;
  try {
    runner = executeRunnerCommand([process.execPath, DEFAULT_RUNNER_PATH], {
      AUTONOMY_ROOT: rootDir,
      AUTONOMY_AGENT_ID: agent.id,
      AUTONOMY_TASK_ID: dispatchTask.id,
      AUTONOMY_BRANCH: branch,
      AUTONOMY_WORKTREE: worktreePath,
      AUTONOMY_ERROR_REPORT: getRunnerErrorReportPath(rootDir, agent.id),
    });
  } catch (error) {
    markImplementationDispatchFailure(rootDir, config, agent.id, dispatchTask.id, extractExecError(error));
    throw error;
  }

  appendAgentLog(rootDir, config, agent.id, 'worker:dispatch', {
    input: {
      taskId: dispatchTask.id,
    },
    output: {
      branch,
      worktreePath,
      runner,
    },
  });

  return {
    ok: true,
    status: 'active',
    taskId: dispatchTask.id,
    branch,
    worktreePath,
    runner,
  };
}

function runWorkerOnce(rootDir, agentId) {
  const { config, sprint } = loadConfig(rootDir);
  const agent = getAgent(config, agentId);
  try {
    if (isPmRole(agent.role)) {
      return runPmWorker(rootDir, config, sprint, agent);
    }
    if (isReviewRole(agent.role)) {
      return runReviewerWorker(rootDir, config, agent);
    }
    if (isImplementationRole(agent.role)) {
      return runImplementationWorker(rootDir, config, agent);
    }

    appendAgentLog(rootDir, config, agent.id, 'worker:skip', {
      input: { role: agent.role },
      output: { status: 'unsupported' },
    });
    return { ok: true, status: 'unsupported' };
  } catch (error) {
    appendAgentLog(rootDir, config, agent.id, 'worker:error', {
      input: {
        role: agent.role,
      },
      output: {
        message: extractExecError(error),
      },
    });
    throw error;
  }
}

export { runWorkerOnce };
