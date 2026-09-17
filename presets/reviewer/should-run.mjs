#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { customPrsPath, customQueuePath, isTaskPrdRunnable, terminalPrdTaskPatch } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const queuePath = customQueuePath(repoRoot, 'shadow-reviewer-agent');
const queue = readJsonFile(queuePath, { tasks: [] });
const prs = readJsonFile(customPrsPath(repoRoot), { pullRequests: [] });
const staleTasks = markStalePrdTasks(repoRoot, queuePath, queue, prs);
const staleCleanupTask = findStaleCleanupTask(repoRoot, queue.tasks || [], prs);
if (staleCleanupTask) {
  writeJson({
    shouldRun: true,
    reason: `cleanup stale review worktrees for ${staleCleanupTask.sourceTaskId || staleCleanupTask.id}`,
    prdId: reviewPrdId(prs, staleCleanupTask),
    prId: staleCleanupTask.prId || findPullRequest(prs, staleCleanupTask)?.id || '',
    taskId: staleCleanupTask.id,
    target: {
      type: 'cleanup',
      id: staleCleanupTask.id,
      task: staleCleanupTask,
    },
  });
  process.exit(0);
}
const runnableStatuses = new Set(['queued', 'review-queued', 'reviewing', 'ready_for_review']);
const task = (queue.tasks || [])
  .filter((candidate) => runnableStatuses.has(statusOf(candidate)))
  .find((candidate) => hasReviewTarget(prs, candidate));

writeJson(task ? {
  shouldRun: true,
  reason: `queued review task ${task.id}`,
  prdId: reviewPrdId(prs, task),
  prId: task.prId || findPullRequest(prs, task)?.id || '',
  taskId: task.id,
  target: {
    type: 'review',
    id: task.id,
    queuePath: path.relative(repoRoot, queuePath),
    prId: task.prId || '',
    task,
  },
} : {
  shouldRun: false,
  reason: staleTasks.length
    ? `archived stale PRD review tasks: ${staleTasks.join(', ')}`
    : 'no shadow-reviewer-agent tasks queued or resumable',
});

function markStalePrdTasks(root, filePath, queueState, prState) {
  queueState.tasks = Array.isArray(queueState.tasks) ? queueState.tasks : [];
  const staleTaskIds = [];
  let changed = false;
  for (const task of queueState.tasks) {
    if (!task || isTerminal(task)) {
      continue;
    }
    const scopedTask = withPrdFromReviewTarget(prState, task);
    if (isTaskPrdRunnable(root, scopedTask)) {
      continue;
    }
    Object.assign(task, terminalPrdTaskPatch(root, scopedTask));
    staleTaskIds.push(task.id || 'unknown');
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(filePath, `${JSON.stringify(queueState, null, 2)}\n`, 'utf8');
  }
  return staleTaskIds;
}

function withPrdFromReviewTarget(prs, task) {
  if (task?.prdId || task?.sourcePrdId) {
    return task;
  }
  const pr = findPullRequest(prs, task);
  return {
    ...task,
    sourcePrdId: pr?.prdId || '',
  };
}

function findStaleCleanupTask(root, reviewTasks, prs) {
  for (const task of reviewTasks) {
    const scopedTask = withPrdFromReviewTarget(prs, task);
    if (!isTaskPrdRunnable(root, scopedTask) && hasLingeringWorktrees(root, prs, scopedTask)) {
      return scopedTask;
    }
  }

  const architectureQueue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  for (const task of architectureQueue.tasks || []) {
    if (!task || isTaskPrdRunnable(root, task)) {
      continue;
    }
    const syntheticTask = {
      id: `cleanup-${task.id || 'task'}`,
      type: 'cleanup',
      agentId: 'shadow-reviewer-agent',
      sourceTaskId: task.id || '',
      sourceAgentId: 'shadow-architecture-agent',
      sourcePrdId: task.prdId || '',
      prId: findPullRequest(prs, {
        sourceTaskId: task.id || '',
        prId: prIdFromTaskId(task.id),
      })?.id || prIdFromTaskId(task.id),
      headBranch: task.headBranch || task.branch || '',
      baseBranch: task.baseBranch || 'dev',
      worktreePath: task.worktreePath || '',
      sprintId: task.sprintId || '',
      status: 'archived',
    };
    if (hasLingeringWorktrees(root, prs, syntheticTask)) {
      return syntheticTask;
    }
  }

  return null;
}

function hasLingeringWorktrees(root, prs, task) {
  return worktreeCleanupCandidates(root, prs, task)
    .some((candidate) => fs.existsSync(candidate.filePath));
}

function worktreeCleanupCandidates(root, prs, task) {
  const architectureTask = findArchitectureTask(root, sourceTaskIdFor(task));
  const sourceTaskId = sourceTaskIdFor(task) || architectureTask?.id || '';
  const prId = task?.prId || findPullRequest(prs, task)?.id || prIdFromTaskId(sourceTaskId || task?.id);
  const sprintId = architectureTask?.sprintId || task?.sprintId || 'multi-agent-mvp';
  const candidates = [];

  addWorktreeCandidate(candidates, {
    base: path.join(root, '.autonomy', 'worktrees', 'shadow-architecture-agent'),
    filePath: architectureTask?.worktreePath || task?.worktreePath,
  });
  if (sourceTaskId) {
    addWorktreeCandidate(candidates, {
      base: path.join(root, '.autonomy', 'worktrees', 'shadow-architecture-agent'),
      filePath: path.join(root, '.autonomy', 'worktrees', 'shadow-architecture-agent', slug(`${sprintId}-${sourceTaskId}`)),
    });
  }

  addWorktreeCandidate(candidates, {
    base: path.join(root, '.autonomy', 'worktrees', 'shadow-reviewer-agent'),
    filePath: task?.reviewWorktreePath,
  });
  if (task?.id) {
    addWorktreeCandidate(candidates, {
      base: path.join(root, '.autonomy', 'worktrees', 'shadow-reviewer-agent'),
      filePath: path.join(root, '.autonomy', 'worktrees', 'shadow-reviewer-agent', slug(task.id)),
    });
  }
  if (prId) {
    addWorktreeCandidate(candidates, {
      base: path.join(root, '.autonomy', 'worktrees', 'shadow-reviewer-agent'),
      filePath: path.join(root, '.autonomy', 'worktrees', 'shadow-reviewer-agent', slug(`review-${prId}`)),
    });
  }

  return candidates;
}

function addWorktreeCandidate(candidates, candidate) {
  if (!candidate.filePath) {
    return;
  }
  const resolvedPath = path.resolve(candidate.filePath);
  if (candidates.some((entry) => entry.filePath === resolvedPath)) {
    return;
  }
  candidates.push({
    ...candidate,
    filePath: resolvedPath,
  });
}

function findArchitectureTask(root, taskId) {
  if (!taskId) {
    return null;
  }
  const queue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  return (queue.tasks || []).find((entry) => entry.id === taskId) || null;
}

function isTerminal(task) {
  return [
    'done',
    'completed',
    'merged',
    'closed',
    'approved',
    'archived',
    'cancelled',
    'canceled',
    'rejected',
    'terminal',
  ].includes(statusOf(task));
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function statusOf(task) {
  return String(task && (task.status || task.state) || '').toLowerCase();
}

function hasReviewTarget(prs, task) {
  if (!task) {
    return false;
  }
  if (task.prId || task.remoteUrl) {
    return true;
  }
  return Boolean(findPullRequest(prs, task));
}

function reviewPrdId(prs, task) {
  return task?.prdId || task?.sourcePrdId || findPullRequest(prs, task)?.prdId || '';
}

function findPullRequest(prs, task) {
  const sourceTaskId = sourceTaskIdFor(task);
  const inferredPrId = task?.prId || prIdFromTaskId(task?.id);
  return (prs.pullRequests || [])
    .find((candidate) => candidate.id === inferredPrId
      || candidate.taskId === sourceTaskId
      || candidate.taskId === task?.id) || null;
}

function sourceTaskIdFor(task) {
  if (!task) {
    return '';
  }
  if (task.sourceTaskId) {
    return task.sourceTaskId;
  }
  if (task.fromAgentId || task.sourceAgentId || String(task.id || '').startsWith('task-')) {
    return task.id || '';
  }
  return '';
}

function prIdFromTaskId(taskId) {
  if (!taskId || !String(taskId).startsWith('task-')) {
    return '';
  }
  return `pr-${String(taskId).replace(/-\d+$/, '')}`;
}

function slug(value) {
  return String(value || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'task';
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
}

function writeJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
