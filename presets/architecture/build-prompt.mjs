#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { customQueuePath } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const target = input.target || {};
const task = target.task || resolveTask(repoRoot, target.id);
const projectContext = readText(path.join(repoRoot, 'prompts', 'autonomous', 'v2', 'project-context.md'));
const systemPrompt = readText(path.join(repoRoot, 'prompts', 'autonomous', 'v2', 'custom', 'agents', 'shadow-architecture-agent', 'system.md'));

writeJson({
  prompt: [
    systemPrompt,
    '',
    'Project context:',
    fenced(projectContext),
    '',
    'Implementation task:',
    fenced(JSON.stringify(task || target, null, 2)),
    '',
    'Work only in the prepared workspace.',
    'Keep changes narrowly scoped to the task and acceptance criteria.',
    'Do not run broad formatters across the Rust subtree; format or check only files you intentionally edited, and restore unrelated formatter-only changes before handoff.',
    'Before finishing, inspect git diff --name-only and keep only files required by the task acceptance criteria.',
    'Run or preserve the checks listed on the task when practical.',
    'If the PR branch is stale, conflicting, or behind dev, reconcile it in your worktree and leave the corrected code ready for the finalizer.',
    'Do not create pull requests, mark pull requests ready, call GitHub PR tools, push branches, or edit lifecycle queue/PR state by hand. The finalizer command owns commit, push, PR publication/readiness, and reviewer handoff state.',
  ].join('\n'),
});

function resolveTask(root, taskId) {
  const queue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  return (queue.tasks || []).find((task) => task.id === taskId) || null;
}

function fenced(value) {
  return ['```', String(value || '').trim(), '```'].join('\n');
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
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
