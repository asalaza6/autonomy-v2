#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { activePrdPath, customPrdStatePath, customQueueDir } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const target = input.target || {};
const now = new Date().toISOString();
const queues = listQueues(repoRoot);
const plannedTaskIds = queues.flatMap((queue) => queue.tasks || [])
  .filter((task) => task && task.prdId === target.id)
  .map((task) => task.id);
const runDir = path.join(repoRoot, '.autonomy', 'runtime', 'custom-lifecycle', 'shadow-pm-agent');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'last-finalize.json'), `${JSON.stringify({
  finalizedAt: now,
  target,
  plannedTaskIds,
  run: input.run || null,
}, null, 2)}\n`, 'utf8');
if (target.id && plannedTaskIds.length > 0) {
  const statePath = customPrdStatePath(repoRoot, target.id);
  const activePath = resolveActivePath(repoRoot, target, input.previous?.environment);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    prdId: target.id,
    status: 'planned',
    plannedTaskIds,
    activePath,
    updatedAt: now,
  }, null, 2)}\n`, 'utf8');
}

writeJson({
  ok: true,
  status: plannedTaskIds.length > 0 ? 'planned' : 'no-planned-tasks-detected',
  plannedTaskIds,
});

function listQueues(root) {
  const queueDir = customQueueDir(root);
  if (!fs.existsSync(queueDir)) {
    return [];
  }
  return fs.readdirSync(queueDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJsonFile(path.join(queueDir, name), {}));
}

function resolveActivePath(root, target, run) {
  if (run?.prdRelativePath && !run.prdRelativePath.includes('/queue/')) {
    return run.prdRelativePath;
  }
  if (target.id) {
    const activePath = activePrdPath(root, target.id);
    if (fs.existsSync(activePath)) {
      return path.relative(root, activePath);
    }
  }
  return run?.prdRelativePath || target.path || '';
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
