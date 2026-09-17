#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { activePrdPath, customPrdStatePath, queuedPrdPath } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const target = input.target || {};
const runDir = path.join(repoRoot, '.autonomy', 'runtime', 'custom-lifecycle', 'shadow-pm-agent');
fs.mkdirSync(runDir, { recursive: true });
const promotion = promoteQueuedPrd(repoRoot, target);

writeJson({
  cwd: repoRoot,
  runDir,
  promotion,
  prdRelativePath: promotion.promotedRelativePath || target.path || '',
});

function promoteQueuedPrd(root, target) {
  if (target.type !== 'queued-prd' || !target.id) {
    return { status: 'not-needed' };
  }

  const sourcePath = path.join(root, String(target.path || path.relative(root, queuedPrdPath(root, target.id))));
  const destinationPath = activePrdPath(root, target.id);
  if (fs.existsSync(destinationPath)) {
    markPromoted(root, target.id, destinationPath, 'already-active');
    return {
      status: 'already-active',
      promotedRelativePath: path.relative(root, destinationPath),
    };
  }

  if (!fs.existsSync(sourcePath)) {
    return {
      status: 'missing-source',
      error: `queued PRD not found at ${path.relative(root, sourcePath)}`,
    };
  }

  const rootStatus = git(root, ['status', '--short']).stdout.trim();
  if (rootStatus) {
    return {
      status: 'blocked',
      error: 'root dev worktree must be clean before PRD promotion',
      statusShort: rootStatus,
    };
  }

  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const move = git(root, ['mv', sourcePath, destinationPath]);
  if (move.status !== 0) {
    return {
      status: 'failed',
      step: 'git-mv',
      error: move.stderr.trim() || move.stdout.trim(),
    };
  }

  markPromoted(root, target.id, destinationPath, 'active');
  const commit = git(root, ['commit', '-m', `autonomy(prd): promote ${target.id}`]);
  if (commit.status !== 0) {
    return {
      status: 'failed',
      step: 'commit',
      promotedRelativePath: path.relative(root, destinationPath),
      error: commit.stderr.trim() || commit.stdout.trim(),
    };
  }

  const push = git(root, ['push', 'origin', 'dev']);
  if (push.status !== 0) {
    return {
      status: 'failed',
      step: 'push',
      promotedRelativePath: path.relative(root, destinationPath),
      error: push.stderr.trim() || push.stdout.trim(),
    };
  }

  return {
    status: 'promoted',
    promotedRelativePath: path.relative(root, destinationPath),
    commit: commit.stdout.trim(),
  };
}

function markPromoted(root, prdId, filePath, status) {
  const now = new Date().toISOString();
  const statePath = customPrdStatePath(root, prdId);
  const state = readJsonFile(statePath, { prdId });
  const previousStatus = String(state.status || '').toLowerCase();
  const {
    archivedAt,
    archivedPath,
    plannedTaskIds,
    selfHealedReason,
    staleReason,
    taskIds,
    ...stateToCarryForward
  } = state;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    ...stateToCarryForward,
    prdId,
    status,
    activePath: path.relative(root, filePath),
    promotedAt: ['archived', 'completed', 'done', 'pending_planning'].includes(previousStatus)
      ? now
      : state.promotedAt || now,
    updatedAt: now,
  }, null, 2)}\n`, 'utf8');
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
