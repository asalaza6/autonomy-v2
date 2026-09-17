#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { customQueuePath, isTaskPrdRunnable, terminalPrdTaskPatch } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const task = resolveTask(repoRoot, input.target || {});
if (!task) {
  writeJson({ cwd: repoRoot, skipped: true, reason: 'task not found' });
  process.exit(0);
}
if (!isTaskPrdRunnable(repoRoot, task)) {
  markTaskStarted(repoRoot, task.id, terminalPrdTaskPatch(repoRoot, task));
  writeJson({
    cwd: repoRoot,
    skipped: true,
    reason: `stale PRD task ${task.id} is not runnable`,
    taskId: task.id,
  });
  process.exit(0);
}

const baseBranch = task.baseBranch || 'dev';
const prdKey = task.prdId || task.id;
const branch = task.branch || [
  'agent',
  task.sprintId || 'multi-agent-mvp',
  'shadow-architecture-agent',
  slug(prdKey),
].join('/');
const worktreePath = path.join(repoRoot, '.autonomy', 'worktrees', 'shadow-architecture-agent', slug(`${task.sprintId || 'multi-agent-mvp'}-${prdKey}`));
fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

if (!fs.existsSync(worktreePath)) {
  const args = localBranchExists(repoRoot, branch)
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseBranch];
  const result = git(repoRoot, args);
  if (result.status !== 0) {
    writeJson({
      cwd: repoRoot,
      branch,
      worktreePath,
      error: result.stderr || result.stdout || `git ${args.join(' ')} failed`,
    });
    process.exit(0);
  }
}

markTaskStarted(repoRoot, task.id, {
  status: 'in_progress',
  branch,
  worktreePath,
});

writeJson({
  cwd: worktreePath,
  branch,
  baseBranch,
  taskId: task.id,
  task,
});

function resolveTask(root, target) {
  if (target.task && target.task.id) {
    return target.task;
  }
  const queue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  return (queue.tasks || []).find((task) => task.id === target.id) || null;
}

function localBranchExists(root, branch) {
  return git(root, ['rev-parse', '--verify', branch]).status === 0;
}

function markTaskStarted(root, taskId, patch) {
  const queuePath = customQueuePath(root, 'shadow-architecture-agent');
  const queue = readJsonFile(queuePath, { tasks: [] });
  queue.tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  const existing = queue.tasks.find((entry) => entry.id === taskId);
  if (!existing) {
    return;
  }
  Object.assign(existing, patch, { updatedAt: new Date().toISOString() });
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
  return String(value || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'task';
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
