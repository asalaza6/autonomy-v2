#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { customPrsPath, customQueuePath, isTaskPrdRunnable, terminalPrdTaskPatch } from '../lib/custom-state.mjs';

const input = readStdinJson();
const repoRoot = input.repoRoot || process.cwd();
const cwd = input.workspace?.cwd || repoRoot;
const task = input.target?.task || resolveTask(repoRoot, input.target?.id);
const runDir = path.join(repoRoot, '.autonomy', 'runtime', 'custom-lifecycle', 'shadow-architecture-agent');
fs.mkdirSync(runDir, { recursive: true });

if (task && !isTaskPrdRunnable(repoRoot, task)) {
  markArchitectureTask(repoRoot, task, 'archived', terminalPrdTaskPatch(repoRoot, task));
  const payload = {
    finalizedAt: new Date().toISOString(),
    target: input.target || {},
    cwd,
    checkResults: [],
    changed: false,
    skipped: true,
    reason: `stale PRD task ${task.id} is not runnable`,
  };
  fs.writeFileSync(path.join(runDir, 'last-finalize.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  writeJson({
    ok: true,
    status: 'stale-prd-task-skipped',
    reason: payload.reason,
    checkResults: [],
    commit: null,
    push: null,
    pullRequest: null,
    handoff: null,
  });
  process.exit(0);
}
const checks = Array.from(new Set([...(task?.checks || []), 'npm run typecheck']
  .map(normalizeCheckCommand)));
const checkResults = checks.map((command) => runShell(cwd, command));
const statusBeforeAdd = git(cwd, ['status', '--short']).stdout.trim();

let commit = null;
let push = null;
let pullRequest = null;
let handoff = null;
if (statusBeforeAdd) {
  git(cwd, ['add', '-A']);
  const message = `auto(shadow-architecture-agent): ${task?.id || input.target?.id || 'custom lifecycle task'}`;
  const commitResult = git(cwd, ['commit', '-m', message]);
  commit = {
    status: commitResult.status === 0 ? 'committed' : 'failed',
    stdout: commitResult.stdout.trim(),
    stderr: commitResult.stderr.trim(),
  };
  if (commitResult.status === 0) {
    const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    push = publishBranch(cwd, branch);
    if (push.status === 'pushed' || push.status === 'up-to-date') {
      pullRequest = createPullRequest(repoRoot, cwd, task, branch);
      if (canHandoffPullRequest(pullRequest)) {
        markArchitectureTask(repoRoot, task, 'completed', {
          headBranch: branch,
          prId: buildPrId(task),
          remoteUrl: pullRequest?.url || '',
          completedAt: new Date().toISOString(),
        });
        recordPullRequest(repoRoot, task, branch, pullRequest);
        handoff = maybeQueuePrdReview(repoRoot, task, branch, pullRequest);
      } else {
        handoff = {
          status: 'publication-blocked',
          reason: pullRequest?.ready?.stderr || pullRequest?.stderr || 'pull request is not ready for review',
        };
      }
    }
  }
} else if (task && isImplementationFollowup(task)) {
  const prRecord = findPullRequest(repoRoot, task);
  const branch = currentBranch(cwd) || prRecord?.headBranch || task.headBranch || '';
  push = publishBranch(cwd, branch);
  if (push.status === 'pushed' || push.status === 'up-to-date') {
    pullRequest = prRecord?.remote?.url
      ? existingPullRequest(repoRoot, cwd, task, prRecord.remote.url)
      : createPullRequest(repoRoot, cwd, task, branch);
    if (canHandoffPullRequest(pullRequest)) {
      markArchitectureTask(repoRoot, task, 'completed', {
        headBranch: branch,
        prId: buildPrId(task),
        remoteUrl: pullRequest?.url || prRecord?.remote?.url || '',
        completedAt: new Date().toISOString(),
      });
      recordPullRequest(repoRoot, task, branch, pullRequest);
      handoff = {
        ...maybeQueuePrdReview(repoRoot, task, branch, pullRequest),
        push,
      };
    } else {
      handoff = {
        status: 'publication-blocked',
        reason: pullRequest?.ready?.stderr || pullRequest?.stderr || 'pull request is not ready for review',
        push,
      };
    }
  } else {
    const comment = leaveNoopComment(repoRoot, task, prRecord, push);
    markArchitectureTask(repoRoot, task, 'completed', {
      prId: buildPrId(task),
      remoteUrl: prRecord?.remote?.url || '',
      completedAt: new Date().toISOString(),
    });
    recordPullRequest(repoRoot, task, branch, {
      status: prRecord?.remote?.url ? 'existing' : 'noop',
      url: prRecord?.remote?.url || '',
    });
    handoff = {
      ...maybeQueuePrdReview(repoRoot, task, branch, {
        status: prRecord?.remote?.url ? 'existing' : 'noop',
        url: prRecord?.remote?.url || '',
      }),
      comment,
      push,
    };
  }
}

const payload = {
  finalizedAt: new Date().toISOString(),
  target: input.target || {},
  cwd,
  checkResults,
  changed: Boolean(statusBeforeAdd),
  commit,
  push,
  pullRequest,
  handoff,
};
fs.writeFileSync(path.join(runDir, 'last-finalize.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

writeJson({
  ok: true,
  status: statusBeforeAdd ? 'changes-finalized' : 'no-changes',
  checkResults: checkResults.map(({ command, status }) => ({ command, status })),
  commit,
  push,
  pullRequest,
  handoff,
});

function createPullRequest(root, cwd, task, branch) {
  const progress = prdTaskProgress(root, task);
  const title = `[shadow-architecture-agent] ${task?.prdId || task?.title || task?.id || 'Implementation PRD'}`;
  const body = [
    `PRD: ${task?.prdId || ''}`,
    '',
    task?.description || '',
    '',
    '## Task Progress',
    ...progress.tasks.map((entry) => `${entry.completed ? '- [x]' : '- [ ]'} ${entry.title || entry.id}`),
    '',
    '<!-- darwinexzero-frontend-custom-lifecycle -->',
    `Agent: shadow-architecture-agent`,
    `PRD: ${task?.prdId || ''}`,
    `Current task: ${task?.id || ''}`,
  ].join('\n');
  const result = spawnSync('gh', ['pr', 'create', '--base', task?.baseBranch || 'dev', '--head', branch, '--title', title, '--body', body], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  if (result.status !== 0) {
    const existing = spawnSync('gh', ['pr', 'view', branch, '--json', 'url,state,number,isDraft'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    const parsed = existing.status === 0 ? readJsonText(existing.stdout, {}) : {};
    if (parsed.url) {
      const ready = progress.complete
        ? ensurePullRequestReady(cwd, parsed.url)
        : { status: 'deferred-until-prd-complete' };
      return {
        status: 'existing',
        url: String(parsed.url || '').trim(),
        isDraft: false,
        ready,
        stdout: String(existing.stdout || '').trim(),
        stderr: String(result.stderr || result.error?.message || '').trim(),
      };
    }
  }
  const url = result.status === 0 ? String(result.stdout || '').trim() : '';
  const ready = url && progress.complete ? ensurePullRequestReady(cwd, url) : { status: 'deferred-until-prd-complete' };
  return {
    status: result.status === 0 ? 'created' : 'failed',
    url,
    isDraft: false,
    ready,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error?.message || '').trim(),
  };
}

function ensurePullRequestReady(cwd, url) {
  if (!url) {
    return { status: 'skipped', reason: 'missing-pr-url' };
  }
  const view = spawnSync('gh', ['pr', 'view', url, '--json', 'isDraft,url'], {
    cwd,
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
    return { status: 'already-ready' };
  }
  const ready = spawnSync('gh', ['pr', 'ready', String(parsed.url || url)], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  return {
    status: ready.status === 0 ? 'marked-ready' : 'failed',
    stdout: String(ready.stdout || '').trim(),
    stderr: String(ready.stderr || ready.error?.message || '').trim(),
  };
}

function canHandoffPullRequest(pullRequest) {
  if (!pullRequest?.url || pullRequest.status === 'failed') {
    return false;
  }
  return pullRequest.ready?.status !== 'failed';
}

function existingPullRequest(root, cwd, task, url) {
  const progress = prdTaskProgress(root, task);
  const ready = progress.complete
    ? ensurePullRequestReady(cwd, url)
    : { status: 'deferred-until-prd-complete' };
  return {
    status: 'existing',
    url,
    isDraft: false,
    ready,
  };
}

function publishBranch(cwd, branch) {
  if (!branch || branch === 'HEAD') {
    return {
      branch,
      status: 'skipped',
      reason: 'not-on-branch',
    };
  }
  const remoteExists = git(cwd, ['ls-remote', '--exit-code', '--heads', 'origin', branch]).status === 0;
  if (!remoteExists) {
    const pushResult = git(cwd, ['push', '-u', 'origin', branch]);
    return pushPayload(branch, pushResult, 'push');
  }

  git(cwd, ['fetch', 'origin', branch]);
  const divergence = branchDivergence(cwd, branch);
  if (divergence.ahead === 0) {
    return {
      branch,
      status: 'up-to-date',
      divergence,
    };
  }

  const pushArgs = ['push', '-u', 'origin', branch];
  const pushResult = git(cwd, pushArgs);
  if (pushResult.status === 0 || !isShadowArchitectureBranch(branch)) {
    return {
      ...pushPayload(branch, pushResult, 'push'),
      divergence,
    };
  }

  const forceResult = git(cwd, [
    'push',
    '--force-with-lease',
    'origin',
    `HEAD:refs/heads/${branch}`,
  ]);
  return {
    ...pushPayload(branch, forceResult, 'force-with-lease'),
    divergence,
    fallbackFrom: pushPayload(branch, pushResult, 'push'),
  };
}

function branchDivergence(cwd, branch) {
  const result = git(cwd, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
  const [behind, ahead] = String(result.stdout || '').trim().split(/\s+/).map((value) => Number(value || 0));
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

function pushPayload(branch, result, mode) {
  return {
    branch,
    mode,
    status: result.status === 0 ? 'pushed' : 'failed',
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error?.message || '').trim(),
  };
}

function currentBranch(cwd) {
  const result = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (result.status !== 0) {
    return '';
  }
  return result.stdout.trim();
}

function isShadowArchitectureBranch(branch) {
  return /^agent\/[^/]+\/shadow-architecture-agent\//.test(String(branch || ''));
}

function maybeQueuePrdReview(root, task, branch, pullRequest) {
  const progress = prdTaskProgress(root, task);
  if (!progress.complete) {
    return {
      status: 'prd-task-completed',
      prdId: task?.prdId || '',
      completedTaskIds: progress.completedTaskIds,
      pendingTaskIds: progress.pendingTaskIds,
      nextAction: 'continue_prd_tasks_on_same_branch',
    };
  }
  queueReview(root, task, branch, pullRequest);
  return {
    status: 'review-queued',
    prdId: task?.prdId || '',
    reviewTaskId: task?.id ? `review-${buildPrId(task)}` : '',
    completedTaskIds: progress.completedTaskIds,
    pendingTaskIds: progress.pendingTaskIds,
  };
}

function prdTaskProgress(root, task) {
  const queue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  const tasks = (Array.isArray(queue.tasks) ? queue.tasks : [])
    .filter((entry) => entry && task && (
      (task.prdId && entry.prdId === task.prdId)
      || (!task.prdId && entry.id === task.id)
    ));
  const scopedTasks = tasks.length ? tasks : [task].filter(Boolean);
  const completedTaskIds = scopedTasks
    .filter((entry) => isCompletedTaskStatus(entry.status || entry.state))
    .map((entry) => entry.id)
    .filter(Boolean);
  const pendingTaskIds = scopedTasks
    .filter((entry) => !isCompletedTaskStatus(entry.status || entry.state))
    .map((entry) => entry.id)
    .filter(Boolean);
  return {
    tasks: scopedTasks.map((entry) => ({
      id: entry.id,
      title: entry.title || '',
      status: entry.status || entry.state || '',
      completed: isCompletedTaskStatus(entry.status || entry.state),
    })),
    taskIds: scopedTasks.map((entry) => entry.id).filter(Boolean),
    completedTaskIds,
    pendingTaskIds,
    laneKeys: Array.from(new Set(scopedTasks.map((entry) => entry.laneKey).filter(Boolean))),
    acceptance: scopedTasks.flatMap((entry) => Array.isArray(entry.acceptance) ? entry.acceptance : []),
    checks: Array.from(new Set(scopedTasks.flatMap((entry) => Array.isArray(entry.checks) ? entry.checks : []))),
    complete: scopedTasks.length > 0 && pendingTaskIds.length === 0,
  };
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

function queueReview(root, task, branch, pullRequest) {
  if (!task?.id) {
    return;
  }
  const queuePath = customQueuePath(root, 'shadow-reviewer-agent');
  const queue = readJsonFile(queuePath, { agentId: 'shadow-reviewer-agent', role: 'review', tasks: [] });
  queue.tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  const reviewTaskId = `review-${buildPrId(task)}`;
  const progress = prdTaskProgress(root, task);
  const existing = queue.tasks.find((entry) => entry.id === reviewTaskId);
  if (existing) {
    existing.status = existing.status === 'merged' ? existing.status : 'queued';
    existing.headBranch = branch || existing.headBranch || '';
    existing.remoteUrl = pullRequest?.url || existing.remoteUrl || '';
    existing.sourceTaskId = progress.taskIds[0] || task.id;
    existing.sourceTaskIds = progress.taskIds;
    existing.acceptance = progress.acceptance;
    existing.updatedAt = new Date().toISOString();
    existing.reviewRound = Number(existing.reviewRound || 1) + 1;
  } else {
    queue.tasks.push({
      id: reviewTaskId,
      title: `Review [shadow-architecture-agent] ${task.prdId || task.title || task.id}`,
      description: `Review ${buildPrId(task)} for PRD ${task.prdId || task.id}`,
      agentId: 'shadow-reviewer-agent',
      type: 'review',
      prId: buildPrId(task),
      sourceTaskId: progress.taskIds[0] || task.id,
      sourceTaskIds: progress.taskIds,
      sourceAgentId: 'shadow-architecture-agent',
      headBranch: branch,
      baseBranch: task.baseBranch || 'dev',
      acceptance: progress.acceptance,
      reviewRound: 1,
      status: 'queued',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      remoteUrl: pullRequest?.url || '',
      sourcePrdId: task.prdId || '',
    });
  }
  fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

function markArchitectureTask(root, task, status, extra = {}) {
  if (!task?.id) {
    return;
  }
  const queuePath = customQueuePath(root, 'shadow-architecture-agent');
  const queue = readJsonFile(queuePath, { tasks: [] });
  queue.tasks = Array.isArray(queue.tasks) ? queue.tasks : [];
  const existing = queue.tasks.find((entry) => entry.id === task.id);
  if (!existing) {
    return;
  }
  existing.status = status;
  existing.updatedAt = new Date().toISOString();
  Object.assign(existing, extra);
  fs.writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
}

function isImplementationFollowup(task) {
  return [
    'needs_changes',
    'changes_requested',
    'review-changes-requested',
    'returned-to-implementation',
  ].includes(String(task.status || task.state || '').toLowerCase());
}

function findPullRequest(root, task) {
  const state = readJsonFile(customPrsPath(root), { pullRequests: [] });
  const prId = buildPrId(task);
  return (state.pullRequests || []).find((entry) => entry.id === prId
    || entry.prdId === task?.prdId
    || entry.taskId === task?.id) || null;
}

function leaveNoopComment(root, task, prRecord, pushResult = null) {
  const message = [
    'shadow-architecture-agent noop response',
    '',
    `Task ${task.id} produced no code changes on this pass.`,
    pushResult?.status === 'failed'
      ? `Branch publication failed: ${pushResult.stderr || pushResult.stdout || 'unknown push failure'}`
      : '',
    'Handing back to reviewer for another review pass.',
  ].filter(Boolean).join('\n');
  const remoteUrl = prRecord?.remote?.url || '';
  if (!remoteUrl) {
    return {
      status: 'skipped',
      reason: 'missing-pr-url',
      message,
    };
  }
  const result = spawnSync('gh', ['pr', 'comment', remoteUrl, '--body', message], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  return {
    status: result.status === 0 ? 'commented' : 'failed',
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error?.message || '').trim(),
    message,
  };
}

function recordPullRequest(root, task, branch, pullRequest) {
  if (!task?.id) {
    return;
  }
  const prsPath = customPrsPath(root);
  fs.mkdirSync(path.dirname(prsPath), { recursive: true });
  const state = readJsonFile(prsPath, { pullRequests: [] });
  state.pullRequests = Array.isArray(state.pullRequests) ? state.pullRequests : [];
  const prId = buildPrId(task);
  const progress = prdTaskProgress(root, task);
  const existing = state.pullRequests.find((entry) => entry.id === prId);
  const record = {
    id: prId,
    taskId: progress.taskIds[0] || task.id,
    laneKey: progress.laneKeys.join(','),
    prdId: task.prdId || '',
    sprintId: task.sprintId || '',
    agentId: 'shadow-architecture-agent',
    sourceTitle: task.prdId || task.title || task.id,
    sourceBody: progress.tasks.map((entry) => `${entry.id}: ${entry.title || ''}`).join('\n'),
    taskIds: progress.taskIds,
    completedTaskIds: progress.completedTaskIds,
    pendingTaskIds: progress.pendingTaskIds,
    acceptance: progress.acceptance,
    checks: progress.checks,
    headBranch: branch,
    baseBranch: task.baseBranch || 'dev',
    status: 'open',
    publicationState: {
      draft: false,
      readyForReview: progress.complete,
    },
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    remote: pullRequest?.url ? { url: pullRequest.url } : undefined,
    title: `[shadow-architecture-agent] ${task.prdId || task.title || task.id}`,
    mergeState: 'open',
  };
  if (existing) {
    Object.assign(existing, record);
  } else {
    state.pullRequests.push(record);
  }
  fs.writeFileSync(prsPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function buildPrId(task) {
  return `pr-${String(task?.prdId || task?.id || 'shadow-architecture-agent-prd').replace(/-\d+$/, '')}`;
}

function resolveTask(root, taskId) {
  const queue = readJsonFile(customQueuePath(root, 'shadow-architecture-agent'), { tasks: [] });
  return (queue.tasks || []).find((task) => task.id === taskId) || null;
}

function runShell(cwd, command) {
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
  return {
    command,
    status: result.status === 0 ? 'passed' : 'failed',
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || result.error?.message || '').trim(),
  };
}

function normalizeCheckCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return trimmed;
  }
  const isNpmTest = /^npm\s+(?:run\s+)?test\b/.test(trimmed);
  if (!isNpmTest || !trimmed.includes('--watch=false') || /\bCI=true\b/.test(trimmed)) {
    return trimmed;
  }
  const runInBand = trimmed.includes('--runInBand') ? '' : ' --runInBand';
  return `CI=true ${trimmed}${runInBand}`;
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
