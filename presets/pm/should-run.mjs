#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  activePrdPath,
  archivedPrdPath,
  customPrdStateDir,
  customPrdStatePath,
  customPrsPath,
  customQueueDir,
  customQueuePath,
  isTaskPrdRunnable,
  queuedPrdPath,
} from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const stalePrdStates = reconcileArchivedPrdState(repoRoot);
const blockingWork = findBlockingActiveWork(repoRoot);
if (blockingWork) {
  writeJson({
    shouldRun: false,
    reason: `waiting for active PRD ${blockingWork.prdId || 'unknown'} ${blockingWork.kind} ${blockingWork.id} to finish`,
    target: {
      type: 'active-prd-work',
      id: blockingWork.prdId || blockingWork.id,
      workKind: blockingWork.kind,
      workId: blockingWork.id,
      status: blockingWork.status,
    },
  });
  process.exit(0);
}

const activePrd = findUnplannedActivePrd(repoRoot);
if (activePrd) {
  writeJson({
    shouldRun: true,
    reason: `unplanned active PRD ${activePrd.id}`,
    target: {
      type: 'prd',
      id: activePrd.id,
      path: activePrd.relativePath,
    },
  });
  process.exit(0);
}

const queuedPrd = findQueuedPrd(repoRoot);
if (queuedPrd) {
  writeJson({
    shouldRun: true,
    reason: `queued PRD ${queuedPrd.id}`,
    target: {
      type: 'queued-prd',
      id: queuedPrd.id,
      path: queuedPrd.relativePath,
    },
  });
  process.exit(0);
}

writeJson({
  shouldRun: false,
  reason: stalePrdStates.length
    ? `archived stale PRD state: ${stalePrdStates.join(', ')}`
    : 'no PRDs awaiting planning',
});

function reconcileArchivedPrdState(root) {
  return listJsonFiles(customPrdStateDir(root))
    .map((filePath) => reconcilePrdStateFile(root, filePath))
    .filter(Boolean);
}

function reconcilePrdStateFile(root, filePath) {
  const state = readJsonFile(filePath, null);
  const prdId = String(state && state.prdId || '').trim();
  if (!state || !prdId || ['archived', 'done', 'completed'].includes(String(state.status || '').toLowerCase())) {
    return '';
  }
  const archivedPath = archivedPrdPath(root, prdId);
  if (fs.existsSync(activePrdPath(root, prdId)) || !fs.existsSync(archivedPath)) {
    return '';
  }
  state.status = 'archived';
  state.archivedPath = path.relative(root, archivedPath);
  state.staleReason = `prd ${prdId} is archived`;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return prdId;
}

function findUnplannedActivePrd(root) {
  return listJsonFiles(path.join(root, 'prompts', 'autonomous', 'v2', 'specs', 'prds'))
    .map((filePath) => readPrd(root, filePath))
    .filter(Boolean)
    .find((prd) => !isPrdPlanned(root, prd, 'active')) || null;
}

function findQueuedPrd(root) {
  return listJsonFiles(path.join(root, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'queue'))
    .map((filePath) => readPrd(root, filePath))
    .filter(Boolean)
    .find((prd) => !isPrdPlanned(root, prd, 'queued')) || null;
}

function isPrdPlanned(root, prd, source) {
  const statePath = customPrdStatePath(root, prd.id);
  const state = readJsonFile(statePath, null);
  const status = String(state?.status || '').toLowerCase();
  if (state && ['done', 'completed', 'archived'].includes(status)) {
    if (source === 'queued' && fs.existsSync(queuedPrdPath(root, prd.id))) {
      selfHealPrdState(statePath, state, 'queued_prd_has_terminal_runtime_state');
      return false;
    }
    return true;
  }
  const matchingTasks = listQueueTasks(root).filter((task) => task && task.prdId === prd.id);
  const executableTasks = matchingTasks.filter((task) => !isCompletedTaskStatus(task.status || task.state));
  if (state && ['planned', 'planning'].includes(status)) {
    const taskIds = Array.isArray(state.taskIds) ? state.taskIds.filter(Boolean) : [];
    const hasMatchingTasks = taskIds.length
      ? taskIds.some((taskId) => executableTasks.some((task) => task.id === taskId))
      : executableTasks.length > 0;
    if (hasMatchingTasks) {
      return true;
    }
    selfHealPrdState(statePath, state, 'planned_state_without_executable_tasks');
    return false;
  }
  return executableTasks.length > 0;
}

function selfHealPrdState(statePath, state, reason) {
  state.status = 'pending_planning';
  state.selfHealedReason = reason;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function findBlockingActiveWork(root) {
  const pullRequests = readPullRequests(root);
  const architectureTask = readQueueTasks(root, 'shadow-architecture-agent')
    .map((task) => normalizeWork('architecture', task))
    .find((task) => task && !isTerminalOrStale(root, task));
  if (architectureTask) {
    return architectureTask;
  }

  const reviewerTask = readQueueTasks(root, 'shadow-reviewer-agent')
    .map((task) => normalizeWork('review', withPrdFromReviewTarget(pullRequests, task)))
    .find((task) => task && !isTerminalOrStale(root, task));
  if (reviewerTask) {
    return reviewerTask;
  }

  return pullRequests
    .map((entry) => normalizeWork('merge-request', entry))
    .find((entry) => entry && !isTerminalOrStale(root, entry)) || null;
}

function readQueueTasks(root, queueName) {
  const queue = readJsonFile(customQueuePath(root, queueName), {});
  return Array.isArray(queue.tasks) ? queue.tasks : [];
}

function readPullRequests(root) {
  const state = readJsonFile(customPrsPath(root), {});
  return Array.isArray(state.pullRequests) ? state.pullRequests : [];
}

function withPrdFromReviewTarget(pullRequests, task) {
  if (task?.prdId || task?.sourcePrdId) {
    return task;
  }
  const sourceTaskId = sourceTaskIdFor(task);
  const inferredPrId = task?.prId || prIdFromTaskId(task?.id);
  const pr = pullRequests
    .find((candidate) => candidate.id === inferredPrId
      || candidate.taskId === sourceTaskId
      || candidate.taskId === task?.id);
  return {
    ...task,
    sourcePrdId: pr?.prdId || '',
  };
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

function normalizeWork(kind, value) {
  if (!value || !value.id) {
    return null;
  }
  return {
    kind,
    id: String(value.id),
    prdId: String(value.prdId || value.sourcePrdId || ''),
    status: String(value.status || value.state || value.mergeState || 'queued').toLowerCase(),
  };
}

function isTerminal(work) {
  return isCompletedTaskStatus(work && work.status);
}

function isCompletedTaskStatus(status) {
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
  ].includes(String(status || '').toLowerCase());
}

function isTerminalOrStale(root, work) {
  return isTerminal(work) || !isTaskPrdRunnable(root, work);
}

function listQueueTasks(root) {
  return listJsonFiles(customQueueDir(root))
    .flatMap((queuePath) => {
      const queue = readJsonFile(queuePath, {});
      return Array.isArray(queue.tasks) ? queue.tasks : [];
    });
}

function readPrd(root, filePath) {
  const spec = readJsonFile(filePath, null);
  if (!spec || !spec.id) {
    return null;
  }
  return {
    ...spec,
    path: filePath,
    relativePath: path.relative(root, filePath),
  };
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(dir, entry.name))
    .sort();
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
