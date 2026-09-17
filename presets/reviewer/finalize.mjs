#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  activePrdPath,
  archivedPrdPath,
  customPrdStatePath,
  customPrsPath,
  customQueuePath,
  isTaskPrdRunnable,
  queuedPrdPath,
  terminalPrdTaskPatch,
} from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const reviewTask = input.target?.task || resolveReviewTask(repoRoot, input.target?.id);
const runDir = path.join(repoRoot, '.autonomy', 'runtime', 'custom-lifecycle', 'shadow-reviewer-agent');
const DEV_FETCH_REF = 'refs/autonomy/fetched/dev';
fs.mkdirSync(runDir, { recursive: true });
const summaryPath = path.join(runDir, 'review-summary.md');
if (reviewTask && !isTaskPrdRunnable(repoRoot, hydrateReviewTask(repoRoot, reviewTask))) {
  const scopedTask = hydrateReviewTask(repoRoot, reviewTask);
  updateRelatedReviewTasks(repoRoot, scopedTask, terminalPrdTaskPatch(repoRoot, scopedTask));
  const worktreeCleanup = cleanupMergedWorktrees(repoRoot, scopedTask);
  const payload = {
    finalizedAt: new Date().toISOString(),
    target: input.target || {},
    run: input.run || null,
    summaryPath,
    summaryPresent: false,
    prState: null,
    outcome: {
      status: 'stale-prd-review-skipped',
      reason: `stale PRD review task ${scopedTask.id} is not runnable`,
    },
    devSync: null,
    archive: null,
    worktreeCleanup,
  };
  fs.writeFileSync(path.join(runDir, 'last-finalize.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeJson({
    ok: true,
    status: payload.outcome.status,
    reason: payload.outcome.reason,
    summaryPath,
    prState: null,
    devSync: null,
    archive: null,
    worktreeCleanup,
  });
  process.exit(0);
}
const summary = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8').trim() : '';
const prState = inspectPullRequest(repoRoot, reviewTask);
const outcome = determineOutcome(reviewTask, summary, prState);
const result = applyOutcome(repoRoot, reviewTask, outcome, prState);
const payload = {
  finalizedAt: new Date().toISOString(),
  target: input.target || {},
  run: input.run || null,
  summaryPath,
  summaryPresent: Boolean(summary),
  prState,
  outcome,
  devSync: result?.devSync || null,
  archive: result?.archive || null,
  worktreeCleanup: result?.worktreeCleanup || null,
};
fs.writeFileSync(path.join(runDir, 'last-finalize.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

writeJson({
  ok: true,
  status: outcome.status,
  summaryPath,
  prState,
  devSync: result?.devSync || null,
  archive: result?.archive || null,
  worktreeCleanup: result?.worktreeCleanup || null,
});

function resolveReviewTask(root, taskId) {
  const queue = readJsonFile(customQueuePath(root, 'shadow-reviewer-agent'), { tasks: [] });
  return (queue.tasks || []).find((task) => task.id === taskId) || null;
}

function hydrateReviewTask(root, task) {
  if (!task) {
    return null;
  }
  const pr = findPullRequest(root, task);
  if (!pr) {
    return task;
  }
  return {
    ...task,
    prId: task.prId || pr.id || '',
    sourceTaskId: task.sourceTaskId || pr.taskId || '',
    headBranch: task.headBranch || pr.headBranch || '',
    baseBranch: task.baseBranch || pr.baseBranch || 'dev',
    remoteUrl: task.remoteUrl || pr.remote?.url || '',
    sourcePrdId: task.sourcePrdId || pr.prdId || '',
  };
}

function inspectPullRequest(root, task) {
  const remoteUrl = task?.remoteUrl || findPullRequest(root, task)?.remote?.url || '';
  if (!remoteUrl) {
    return { status: 'unknown', reason: 'missing-pr-url' };
  }
  const result = spawnSync('gh', ['pr', 'view', remoteUrl, '--json', 'state,mergeStateStatus,isDraft,reviewDecision,url'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  if (result.status !== 0) {
    return {
      status: 'unknown',
      url: remoteUrl,
      error: String(result.stderr || result.error?.message || '').trim(),
    };
  }
  const parsed = readJsonText(result.stdout, {});
  return {
    status: String(parsed.state || 'unknown').toLowerCase(),
    mergeStateStatus: String(parsed.mergeStateStatus || ''),
    reviewDecision: String(parsed.reviewDecision || ''),
    isDraft: Boolean(parsed.isDraft),
    url: String(parsed.url || remoteUrl),
  };
}

function determineOutcome(task, summary, prState) {
  if (prState.status === 'merged') {
    return { status: 'merged', reviewTaskStatus: 'merged', architectureTaskStatus: 'merged' };
  }
  const normalizedSummary = String(summary || '').toLowerCase();
  const reviewDecision = String(prState.reviewDecision || '').toLowerCase();
  if (reviewDecision === 'changes_requested' || normalizedSummary.includes('request changes') || normalizedSummary.includes('changes requested') || normalizedSummary.includes('needs changes')) {
    return {
      status: 'changes-requested',
      reviewTaskStatus: 'changes_requested',
      architectureTaskStatus: 'changes_requested',
    };
  }
  if (reviewDecision === 'approved' || normalizedSummary.includes('approved')) {
    return {
      status: 'merge-pending',
      reviewTaskStatus: 'queued',
      architectureTaskStatus: 'in_review',
    };
  }
  if (task) {
    return {
      status: 'review-recorded',
      reviewTaskStatus: 'queued',
      architectureTaskStatus: 'in_review',
    };
  }
  return {
    status: 'review-run-completed',
    reviewTaskStatus: '',
    architectureTaskStatus: '',
  };
}

function applyOutcome(root, task, outcome, prState) {
  if (!task?.id) {
    return null;
  }
  updateRelatedReviewTasks(root, task, {
    status: outcome.reviewTaskStatus,
    updatedAt: new Date().toISOString(),
    remoteUrl: prState.url || task.remoteUrl || '',
  });
  const sourceTaskId = sourceTaskIdFor(task);
  if (sourceTaskId && outcome.architectureTaskStatus) {
    updateArchitectureTask(root, sourceTaskId, {
      status: outcome.architectureTaskStatus,
      updatedAt: new Date().toISOString(),
      remoteUrl: prState.url || task.remoteUrl || '',
    });
  }
  if (prState.url) {
    updatePullRequest(root, task, outcome, prState);
  }
  if (outcome.status === 'merged') {
    const devSync = syncLocalDev(root);
    const archive = devSync?.status === 'synced'
      ? archivePrd(root, task)
      : { status: 'skipped', reason: 'dev sync did not complete' };
    const worktreeCleanup = devSync?.status === 'synced'
      ? cleanupMergedWorktrees(root, task)
      : { status: 'skipped', reason: 'dev sync did not complete' };
    return { devSync, archive, worktreeCleanup };
  }
  return { devSync: null, archive: null, worktreeCleanup: null };
}

function updateRelatedReviewTasks(root, task, patch) {
  const queuePath = customQueuePath(root, 'shadow-reviewer-agent');
  updateQueueTasks(queuePath, relatedReviewTaskPredicate(task), patch);
}

function updateArchitectureTask(root, taskId, patch) {
  const queuePath = customQueuePath(root, 'shadow-architecture-agent');
  updateQueueTasks(queuePath, (entry) => entry.id === taskId, patch);
}

function updateQueueTasks(queuePath, predicate, patch) {
  const queue = readJsonFile(queuePath, { tasks: [] });
  queue.tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  let changed = false;
  queue.tasks.forEach((task) => {
    if (!predicate(task)) {
      return;
    }
    Object.entries(patch).forEach(([key, value]) => {
      if (value) {
        task[key] = value;
        changed = true;
      }
    });
  });
  if (changed) {
    fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  }
}

function findPullRequest(root, task) {
  const state = readJsonFile(customPrsPath(root), { pullRequests: [] });
  const sourceTaskId = sourceTaskIdFor(task);
  return (state.pullRequests || [])
    .find((entry) => entry.id === task?.prId || entry.taskId === sourceTaskId || entry.taskId === task?.id) || null;
}

function updatePullRequest(root, task, outcome, prState) {
  const prsPath = customPrsPath(root);
  const state = readJsonFile(prsPath, { pullRequests: [] });
  state.pullRequests = Array.isArray(state.pullRequests) ? state.pullRequests : [];
  const sourceTaskId = sourceTaskIdFor(task);
  const existing = state.pullRequests
    .find((entry) => entry.id === task?.prId || entry.taskId === sourceTaskId || entry.taskId === task?.id);
  if (!existing) {
    return;
  }
  existing.status = outcome.status === 'merged' ? 'merged' : 'open';
  existing.mergeState = outcome.status === 'merged' ? 'merged' : 'open';
  existing.reviewStatus = outcome.status;
  existing.updatedAt = new Date().toISOString();
  existing.remote = { ...(existing.remote || {}), url: prState.url || existing.remote?.url || '' };
  fs.writeFileSync(prsPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function cleanupMergedWorktrees(root, task) {
  const candidates = worktreeCleanupCandidates(root, task);
  if (!candidates.length) {
    return { status: 'skipped', reason: 'no worktree candidates' };
  }

  const removals = candidates.map((candidate) => removeWorktreeCandidate(root, candidate));
  const failed = removals.filter((removal) => removal.status === 'failed' || removal.status === 'unsafe');
  const removed = removals.filter((removal) => removal.status === 'removed').length;
  const missing = removals.filter((removal) => removal.status === 'missing').length;

  return {
    status: failed.length ? 'partial' : (removed ? 'removed' : 'missing'),
    removed,
    missing,
    removals,
  };
}

function worktreeCleanupCandidates(root, task) {
  const architectureTask = findArchitectureTask(root, task);
  const sourceTaskId = sourceTaskIdFor(task) || architectureTask?.id || '';
  const prId = task?.prId || findPullRequest(root, task)?.id || findPrIdFromTaskId(sourceTaskId || task?.id);
  const sprintId = architectureTask?.sprintId || task?.sprintId || 'multi-agent-mvp';
  const candidates = [];

  addWorktreeCandidate(candidates, {
    role: 'implementation',
    base: path.join(root, '.autonomy', 'worktrees', 'shadow-architecture-agent'),
    filePath: architectureTask?.worktreePath || task?.worktreePath,
  });
  if (sourceTaskId) {
    addWorktreeCandidate(candidates, {
      role: 'implementation',
      base: path.join(root, '.autonomy', 'worktrees', 'shadow-architecture-agent'),
      filePath: path.join(root, '.autonomy', 'worktrees', 'shadow-architecture-agent', slug(`${sprintId}-${sourceTaskId}`)),
    });
  }

  addWorktreeCandidate(candidates, {
    role: 'review',
    base: path.join(root, '.autonomy', 'worktrees', 'shadow-reviewer-agent'),
    filePath: task?.reviewWorktreePath,
  });
  if (task?.id) {
    addWorktreeCandidate(candidates, {
      role: 'review',
      base: path.join(root, '.autonomy', 'worktrees', 'shadow-reviewer-agent'),
      filePath: path.join(root, '.autonomy', 'worktrees', 'shadow-reviewer-agent', slug(task.id)),
    });
  }
  if (prId) {
    addWorktreeCandidate(candidates, {
      role: 'review',
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
    base: path.resolve(candidate.base),
    filePath: resolvedPath,
  });
}

function removeWorktreeCandidate(root, candidate) {
  const relative = path.relative(candidate.base, candidate.filePath);
  const result = {
    role: candidate.role,
    path: path.relative(root, candidate.filePath),
  };
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ...result, status: 'unsafe', reason: 'candidate outside managed worktree base' };
  }
  if (!fs.existsSync(candidate.filePath)) {
    return { ...result, status: 'missing' };
  }

  const remove = git(root, ['worktree', 'remove', '--force', candidate.filePath]);
  if (remove.status === 0) {
    return { ...result, status: 'removed' };
  }

  try {
    fs.rmSync(candidate.filePath, { recursive: true, force: true });
    const prune = git(root, ['worktree', 'prune']);
    return {
      ...result,
      status: 'removed',
      method: 'rm',
      gitError: remove.stderr.trim() || remove.stdout.trim(),
      pruneStatus: prune.status,
    };
  } catch (error) {
    return {
      ...result,
      status: 'failed',
      error: error?.message || 'failed to remove worktree',
      gitError: remove.stderr.trim() || remove.stdout.trim(),
    };
  }
}

function findArchitectureTask(root, task) {
  const sourceTaskId = sourceTaskIdFor(task);
  if (!sourceTaskId) {
    return null;
  }
  const queue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  return (queue.tasks || []).find((entry) => entry.id === sourceTaskId) || null;
}

function relatedReviewTaskPredicate(task) {
  const sourceTaskId = sourceTaskIdFor(task);
  const prId = task?.prId || findPrIdFromTaskId(task?.id);
  return (entry) => {
    if (!entry) {
      return false;
    }
    return entry.id === task?.id
      || (sourceTaskId && entry.id === sourceTaskId)
      || (sourceTaskId && entry.sourceTaskId === sourceTaskId)
      || (prId && entry.prId === prId)
      || (task?.headBranch && entry.headBranch === task.headBranch);
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

function findPrIdFromTaskId(taskId) {
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

function syncLocalDev(root) {
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const status = git(root, ['status', '--short']).stdout.trim();
  if (branch !== 'dev') {
    return {
      status: 'skipped',
      reason: `root worktree is on ${branch || 'unknown'}, not dev`,
    };
  }
  if (status) {
    return {
      status: 'blocked',
      reason: 'root dev worktree is dirty',
      statusShort: status,
    };
  }
  const fetch = git(root, ['fetch', 'origin', `+refs/heads/dev:${DEV_FETCH_REF}`]);
  if (fetch.status !== 0) {
    return {
      status: 'failed',
      step: 'fetch',
      stderr: fetch.stderr.trim(),
    };
  }
  const fetchedSha = git(root, ['rev-parse', DEV_FETCH_REF]).stdout.trim();
  const currentSha = git(root, ['rev-parse', 'dev']).stdout.trim();
  if (fetchedSha && fetchedSha !== currentSha) {
    const merge = git(root, ['merge', '--ff-only', DEV_FETCH_REF]);
    if (merge.status !== 0) {
      return {
        status: 'failed',
        step: 'merge',
        stdout: merge.stdout.trim(),
        stderr: merge.stderr.trim(),
      };
    }
  }
  const updateRemote = git(root, ['update-ref', 'refs/remotes/origin/dev', fetchedSha || DEV_FETCH_REF]);
  return {
    status: updateRemote.status === 0 ? 'synced' : 'failed',
    step: 'update-origin-dev',
    stdout: updateRemote.stdout.trim(),
    stderr: updateRemote.stderr.trim(),
    fetchedSha,
  };
}

function archivePrd(root, task) {
  const prdId = task?.sourcePrdId || task?.prdId || findPullRequest(root, task)?.prdId || '';
  if (!prdId) {
    return { status: 'skipped', reason: 'missing-prd-id' };
  }
  if (hasOpenPrdWork(root, prdId)) {
    return {
      status: 'skipped',
      reason: 'active-prd-work-remains',
      prdId,
    };
  }

  const rootStatus = git(root, ['status', '--short']).stdout.trim();
  if (rootStatus) {
    return {
      status: 'blocked',
      reason: 'root dev worktree is dirty before PRD archive',
      statusShort: rootStatus,
    };
  }

  const candidates = [activePrdPath(root, prdId), queuedPrdPath(root, prdId)];
  const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
  const archivePath = archivedPrdPath(root, prdId);
  if (!sourcePath) {
    markPrdArchived(root, prdId, archivePath, 'missing-source');
    return { status: 'missing-source', prdId };
  }

  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  const destinationPath = uniqueArchivePath(archivePath);
  const move = git(root, ['mv', sourcePath, destinationPath]);
  if (move.status !== 0) {
    return {
      status: 'failed',
      step: 'git-mv',
      prdId,
      error: move.stderr.trim() || move.stdout.trim(),
    };
  }

  markPrdArchived(root, prdId, destinationPath, 'archived');
  const commit = git(root, ['commit', '-m', `autonomy(prd): archive ${prdId}`]);
  if (commit.status !== 0) {
    return {
      status: 'failed',
      step: 'commit',
      prdId,
      error: commit.stderr.trim() || commit.stdout.trim(),
    };
  }

  const push = git(root, ['push', 'origin', 'dev']);
  if (push.status !== 0) {
    return {
      status: 'failed',
      step: 'push',
      prdId,
      error: push.stderr.trim() || push.stdout.trim(),
    };
  }

  return {
    status: 'archived',
    prdId,
    archivedPath: path.relative(root, destinationPath),
    commit: commit.stdout.trim(),
  };
}

function hasOpenPrdWork(root, prdId) {
  const architectureQueue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  const reviewQueue = readJsonFile(customQueuePath(root, 'shadow-reviewer-agent'), { tasks: [] });
  return [...(architectureQueue.tasks || []), ...(reviewQueue.tasks || [])]
    .some((entry) => entry && taskPrdId(root, entry) === prdId && !isTerminalStatus(entry.status || entry.state));
}

function taskPrdId(root, task) {
  if (task?.prdId || task?.sourcePrdId) {
    return task.prdId || task.sourcePrdId;
  }
  const sourceTaskId = task?.sourceTaskId;
  if (!sourceTaskId) {
    return '';
  }
  const architectureQueue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  return (architectureQueue.tasks || []).find((entry) => entry.id === sourceTaskId)?.prdId || '';
}

function isTerminalStatus(status) {
  return ['done', 'completed', 'merged', 'closed', 'approved', 'archived', 'cancelled', 'canceled', 'rejected']
    .includes(String(status || '').toLowerCase());
}

function markPrdArchived(root, prdId, archivePath, status) {
  const now = new Date().toISOString();
  const statePath = customPrdStatePath(root, prdId);
  const state = readJsonFile(statePath, { prdId });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    ...state,
    prdId,
    status,
    archivedPath: path.relative(root, archivePath),
    archivedAt: status === 'archived' ? now : state.archivedAt,
    updatedAt: now,
  }, null, 2)}\n`, 'utf8');
}

function uniqueArchivePath(filePath) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }
  const parsed = path.parse(filePath);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  return path.join(parsed.dir, `${parsed.name}-${stamp}${parsed.ext}`);
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function readJsonText(value, fallback) {
  try {
    return JSON.parse(String(value || ''));
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
