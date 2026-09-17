#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { customPrsPath, customQueuePath, isTaskPrdRunnable, terminalPrdTaskPatch } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const queuePath = customQueuePath(repoRoot, 'shadow-architecture-agent');
const queue = readJsonFile(queuePath, { tasks: [] });
const staleTasks = markStalePrdTasks(repoRoot, queuePath, queue);
const activeReviewTask = findActiveReviewTask(repoRoot);
if (activeReviewTask) {
  writeJson({
    shouldRun: false,
    reason: `waiting for reviewer task ${activeReviewTask.id} before implementation continues`,
    target: {
      type: 'review',
      id: activeReviewTask.id,
      task: activeReviewTask,
    },
  });
  process.exit(0);
}

const task = findImplementationTask(queue.tasks || []);

writeJson(task ? {
  shouldRun: true,
  reason: isImplementationInProgress(task)
    ? `resuming implementation task ${task.id}`
    : `queued implementation task ${task.id}`,
  prdId: task.prdId || task.sourcePrdId || '',
  taskId: task.id,
  branch: task.branch || task.headBranch || '',
  target: {
    type: 'task',
    id: task.id,
    queuePath: path.relative(repoRoot, queuePath),
    task,
  },
} : {
  shouldRun: false,
  reason: staleTasks.length
    ? `archived stale PRD tasks: ${staleTasks.join(', ')}`
    : 'no shadow-architecture-agent implementation tasks queued',
});

function isTerminal(task) {
  return ['done', 'completed', 'merged', 'closed', 'approved', 'archived', 'cancelled', 'canceled', 'rejected'].includes(statusOf(task));
}

function findImplementationTask(tasks) {
  return tasks.find((candidate) => isImplementationInProgress(candidate))
    || tasks.find((candidate) => isImplementationReady(candidate));
}

function markStalePrdTasks(root, filePath, queueState) {
  queueState.tasks = Array.isArray(queueState.tasks) ? queueState.tasks : [];
  const staleTaskIds = [];
  let changed = false;
  for (const task of queueState.tasks) {
    if (!task || isTerminal(task) || isTaskPrdRunnable(root, task)) {
      continue;
    }
    Object.assign(task, terminalPrdTaskPatch(root, task));
    staleTaskIds.push(task.id || 'unknown');
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(filePath, `${JSON.stringify(queueState, null, 2)}\n`, 'utf8');
  }
  return staleTaskIds;
}

function isImplementationInProgress(task) {
  return task && !isTerminal(task) && [
    'in_progress',
    'in-progress',
    'running',
  ].includes(statusOf(task));
}

function isImplementationReady(task) {
  const status = statusOf(task);
  return task && !isTerminal(task) && [
    '',
    'pending',
    'queued',
    'needs-implementation',
    'needs_changes',
    'changes_requested',
    'review-changes-requested',
    'returned-to-implementation',
  ].includes(status);
}

function findActiveReviewTask(root) {
  const reviewQueue = readJsonFile(customQueuePath(root, 'shadow-reviewer-agent'), { tasks: [] });
  const prs = readJsonFile(customPrsPath(root), { pullRequests: [] });
  return (reviewQueue.tasks || [])
    .find((task) => task && isReviewOwned(task) && isTaskPrdRunnable(root, withPrdFromReviewTarget(prs, task))) || null;
}

function isReviewOwned(task) {
  return ['queued', 'review-queued', 'reviewing', 'in_review', 'in-review', 'approved'].includes(statusOf(task));
}

function statusOf(task) {
  return String(task && (task.status || task.state) || '').toLowerCase();
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

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
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
