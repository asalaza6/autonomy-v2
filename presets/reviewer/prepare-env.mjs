#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { customPrsPath, customQueuePath, isTaskPrdRunnable, terminalPrdTaskPatch } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const reviewTask = hydrateReviewTask(repoRoot, input.target?.task || resolveReviewTask(repoRoot, input.target?.id));
const runDir = path.join(repoRoot, '.autonomy', 'runtime', 'custom-lifecycle', 'shadow-reviewer-agent');
const DEV_FETCH_REF = 'refs/autonomy/fetched/dev';
fs.mkdirSync(runDir, { recursive: true });
const summaryPath = path.join(runDir, 'review-summary.md');
if (fs.existsSync(summaryPath)) {
  fs.unlinkSync(summaryPath);
}
if (reviewTask && !isTaskPrdRunnable(repoRoot, reviewTask)) {
  markReviewTask(repoRoot, reviewTask.id, terminalPrdTaskPatch(repoRoot, reviewTask));
  writeJson({
    cwd: repoRoot,
    repoRoot,
    runDir,
    summaryPath,
    skipped: true,
    reason: `stale PRD review task ${reviewTask.id} is not runnable`,
    reviewTaskId: reviewTask.id,
    prId: reviewTask.prId || '',
  });
  process.exit(0);
}
const ready = ensurePullRequestReady(repoRoot, reviewTask);
const worktreePath = path.join(
  repoRoot,
  '.autonomy',
  'worktrees',
  'shadow-reviewer-agent',
  slug(input.target?.id || reviewTask?.id || 'review'),
);
fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

const worktree = prepareReviewWorktree(repoRoot, worktreePath, reviewTask);
if (worktree.error) {
  writeJson({
    cwd: worktreePath,
    repoRoot,
    runDir,
    summaryPath,
    worktreePath,
    reviewTaskId: input.target?.id || '',
    prId: input.target?.prId || '',
    ready,
    error: worktree.error,
  });
  process.exit(0);
}

markReviewStarted(repoRoot, input.target?.id);

writeJson({
  cwd: worktreePath,
  repoRoot,
  runDir,
  summaryPath,
  worktreePath,
  headFetchWarning: worktree.headFetchWarning || '',
  reviewTaskId: input.target?.id || '',
  prId: input.target?.prId || '',
  ready,
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

function findPullRequest(root, task) {
  const state = readJsonFile(customPrsPath(root), { pullRequests: [] });
  const sourceTaskId = sourceTaskIdFor(task);
  const inferredPrId = task?.prId || prIdFromTaskId(task?.id);
  return (state.pullRequests || [])
    .find((candidate) => candidate.id === inferredPrId
      || candidate.taskId === sourceTaskId
      || candidate.taskId === task?.id) || null;
}

function ensurePullRequestReady(root, task) {
  const remoteUrl = task?.remoteUrl || findPullRequest(root, task)?.remote?.url || '';
  if (!remoteUrl) {
    return { status: 'skipped', reason: 'missing-pr-url' };
  }
  const view = spawnSync('gh', ['pr', 'view', remoteUrl, '--json', 'isDraft,url'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  if (view.status !== 0) {
    return {
      status: 'unknown',
      stderr: String(view.stderr || view.error?.message || '').trim(),
    };
  }
  const parsed = readJsonText(view.stdout, {});
  if (!parsed.isDraft) {
    updatePullRequestPublicationState(root, task, remoteUrl, { draft: false, readyForReview: true });
    return { status: 'already-ready' };
  }
  const ready = spawnSync('gh', ['pr', 'ready', String(parsed.url || remoteUrl)], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  if (ready.status === 0) {
    updatePullRequestPublicationState(root, task, String(parsed.url || remoteUrl), { draft: false, readyForReview: true });
  }
  return {
    status: ready.status === 0 ? 'marked-ready' : 'failed',
    stdout: String(ready.stdout || '').trim(),
    stderr: String(ready.stderr || ready.error?.message || '').trim(),
  };
}

function updatePullRequestPublicationState(root, task, remoteUrl, publicationState) {
  const prsPath = customPrsPath(root);
  const state = readJsonFile(prsPath, { pullRequests: [] });
  state.pullRequests = Array.isArray(state.pullRequests) ? state.pullRequests : [];
  const sourceTaskId = sourceTaskIdFor(task);
  const existing = state.pullRequests.find((entry) => entry.id === task?.prId
    || entry.taskId === sourceTaskId
    || entry.taskId === task?.id
    || entry.remote?.url === remoteUrl);
  if (!existing) {
    return;
  }
  existing.status = existing.status === 'review-queued' ? 'open' : existing.status || 'open';
  existing.reviewStatus = existing.reviewStatus === 'review-queued' ? 'queued' : existing.reviewStatus;
  existing.publicationState = {
    ...(existing.publicationState || {}),
    ...publicationState,
  };
  existing.remote = { ...(existing.remote || {}), url: remoteUrl };
  existing.updatedAt = new Date().toISOString();
  fs.writeFileSync(prsPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

function prepareReviewWorktree(root, targetPath, task) {
  const devRef = syncDevForReview(root);
  if (devRef.error) {
    return { error: devRef.error };
  }
  if (!fs.existsSync(targetPath)) {
    const add = git(root, ['worktree', 'add', '--detach', targetPath, devRef.ref]);
    if (add.status !== 0) {
      return { error: add.stderr || add.stdout || 'failed to create review worktree' };
    }
  }
  const status = git(targetPath, ['status', '--porcelain']).stdout.trim();
  if (status) {
    const stash = git(targetPath, ['stash', 'push', '-u', '-m', 'autonomy reviewer cleanup']);
    if (stash.status !== 0) {
      return { error: stash.stderr || stash.stdout || 'failed to stash dirty review worktree' };
    }
  }
  const checkout = git(targetPath, ['checkout', '--detach', devRef.ref]);
  if (checkout.status !== 0) {
    return { error: checkout.stderr || checkout.stdout || 'failed to reset review worktree to latest dev' };
  }
  if (!task?.headBranch) {
    return {};
  }
  const headFetch = git(targetPath, [
    'fetch',
    'origin',
    `refs/heads/${task.headBranch}:refs/remotes/origin/${task.headBranch}`,
  ]);
  return headFetch.status === 0
    ? {}
    : { headFetchWarning: headFetch.stderr.trim() || headFetch.stdout.trim() || 'failed to fetch review head branch' };
}

function syncDevForReview(root) {
  const fetch = git(root, ['fetch', 'origin', `+refs/heads/dev:${DEV_FETCH_REF}`]);
  if (fetch.status !== 0) {
    return { error: fetch.stderr || fetch.stdout || 'failed to fetch review refs' };
  }
  const fetchedSha = git(root, ['rev-parse', DEV_FETCH_REF]).stdout.trim();
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const status = git(root, ['status', '--short']).stdout.trim();
  if (branch === 'dev' && !status && fetchedSha) {
    const currentSha = git(root, ['rev-parse', 'dev']).stdout.trim();
    if (currentSha !== fetchedSha) {
      const merge = git(root, ['merge', '--ff-only', DEV_FETCH_REF]);
      if (merge.status !== 0) {
        return { error: merge.stderr || merge.stdout || 'failed to fast-forward root dev' };
      }
    }
    const updateRemote = git(root, ['update-ref', 'refs/remotes/origin/dev', fetchedSha]);
    if (updateRemote.status !== 0) {
      return { error: updateRemote.stderr || updateRemote.stdout || 'failed to update origin/dev' };
    }
  }
  return { ref: DEV_FETCH_REF };
}

function markReviewStarted(root, taskId) {
  if (!taskId) {
    return;
  }
  const queuePath = customQueuePath(root, 'shadow-reviewer-agent');
  const queue = readJsonFile(queuePath, { tasks: [] });
  queue.tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  const existing = queue.tasks.find((entry) => entry.id === taskId);
  if (!existing) {
    return;
  }
  existing.status = 'reviewing';
  existing.updatedAt = new Date().toISOString();
  fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

function markReviewTask(root, taskId, patch) {
  if (!taskId) {
    return;
  }
  const queuePath = customQueuePath(root, 'shadow-reviewer-agent');
  const queue = readJsonFile(queuePath, { tasks: [] });
  queue.tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  const existing = queue.tasks.find((entry) => entry.id === taskId);
  if (!existing) {
    return;
  }
  Object.assign(existing, patch);
  fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function slug(value) {
  return String(value || 'review')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'review';
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
