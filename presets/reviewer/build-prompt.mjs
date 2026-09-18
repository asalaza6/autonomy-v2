#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { customPrsPath, customQueuePath } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const prepared = input.previous?.environment || {};
const target = input.target || {};
const reviewTask = hydrateReviewTask(repoRoot, target.task || resolveReviewTask(repoRoot, target.id));
const prs = readJsonFile(customPrsPath(repoRoot), { pullRequests: [] });
const pr = findPullRequest(prs, reviewTask, target.prId);
const projectContext = readText(path.join(repoRoot, 'prompts', 'autonomous', 'v2', 'project-context.md'));
const systemPrompt = readText(path.join(repoRoot, 'prompts', 'autonomous', 'v2', 'custom', 'agents', 'shadow-reviewer-agent', 'system.md'));
const diff = pr?.headBranch ? git(repoRoot, ['diff', `${pr.baseBranch || 'dev'}...${pr.headBranch}`]).stdout : '';

writeJson({
  prompt: [
    systemPrompt,
    '',
    'Project context:',
    fenced(projectContext),
    '',
    'Review task and PR record:',
    fenced(JSON.stringify({ reviewTask, pr }, null, 2)),
    '',
    'Review execution paths:',
    fenced(JSON.stringify({
      repoRoot,
      reviewWorktree: prepared.worktreePath || prepared.cwd || process.cwd(),
      summaryPath: prepared.summaryPath || path.join(repoRoot, '.autonomy', 'runtime', 'custom-lifecycle', 'shadow-reviewer-agent', 'review-summary.md'),
      headFetchWarning: prepared.headFetchWarning || '',
    }, null, 2)),
    '',
    'Diff:',
    fenced(diff || '(No diff available from local refs.)'),
    '',
    'Review the change. Do not edit feature code.',
    'Do not run broad recursive searches over .autonomy, .autonomy/runtime, or .autonomy/worktrees. Use the supplied review task, PR record, diff, GitHub PR metadata, and targeted files under .autonomy/runtime/custom-lifecycle instead.',
    'Run any checkout, trial merge, and validation commands in the review worktree, not in the root dev checkout.',
    'If a required validation command is npm test -- --watch=false, run it as CI=true npm test -- --watch=false --runInBand so CRA/Jest exits non-interactively.',
    'Do not change branches, stage files, commit, or trial-merge inside the root dev checkout.',
    'If the merge request needs changes, leave actionable comments on the merge request and write a concise review summary at the supplied absolute summaryPath that includes the words "changes requested".',
    'If the merge request is acceptable and checks are passing, merge it into dev remotely and write a concise review summary at the supplied absolute summaryPath that includes the word "approved". Do not run root-checkout git fetch, pull, merge, or sync commands after merging; the finalizer owns local dev synchronization.',
    'If implementation has responded to your prior feedback, review the response and either request changes again or merge.',
    'Do not leave the merge request in an approved-but-unmerged state unless GitHub blocks the merge; if that happens, explain the blocker in the review summary.',
    'The finalizer command records merge/request-change state from queue and PR metadata.',
  ].join('\n'),
});

function resolveReviewTask(root, taskId) {
  const queue = readJsonFile(customQueuePath(root, 'shadow-reviewer-agent'), { tasks: [] });
  return (queue.tasks || []).find((task) => task.id === taskId) || null;
}

function hydrateReviewTask(root, task) {
  if (!task) {
    return null;
  }
  const prs = readJsonFile(customPrsPath(root), { pullRequests: [] });
  const pr = findPullRequest(prs, task, '');
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
  };
}

function findPullRequest(prs, task, targetPrId) {
  const sourceTaskId = sourceTaskIdFor(task);
  const inferredPrId = targetPrId || task?.prId || prIdFromTaskId(task?.id);
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

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
