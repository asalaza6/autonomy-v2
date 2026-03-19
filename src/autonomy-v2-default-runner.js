#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluateScope } = require('./autonomy-v2');
const { hasGithubAuth, resolveGithubAuthToken } = require('./autonomy-v2-github');
const { acquireStateLock } = require('./autonomy-v2-lock');
const {
  executeTaskWithCodex,
  reviewPrWithCodex,
} = require('./autonomy-v2-codex');
const { loadAutonomyEnv } = require('./autonomy-v2-env');

const CLI_PATH = path.join(__dirname, 'autonomy-v2.js');
const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const DEFAULT_ERROR_PREVIEW_LIMIT = 4000;

function logRunnerEvent(event, payload = {}) {
  if (process.env.AUTONOMY_STREAM_WORKER_OUTPUT !== '1') {
    return;
  }
  const suffix = payload && Object.keys(payload).length > 0
    ? ` ${JSON.stringify(payload)}`
    : '';
  console.log(`[runner] ${event}${suffix}`);
}

function logRunnerErrorEvent(event, payload = {}) {
  if (process.env.AUTONOMY_STREAM_WORKER_OUTPUT !== '1') {
    return;
  }
  const suffix = payload && Object.keys(payload).length > 0
    ? ` ${JSON.stringify(payload)}`
    : '';
  console.error(`[runner] ${event}${suffix}`);
}

function summarizeText(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
}

async function main() {
  const rootDir = requireEnv('AUTONOMY_ROOT');
  loadAutonomyEnv(rootDir);
  const agentId = requireEnv('AUTONOMY_AGENT_ID');

  if (process.env.AUTONOMY_TASK_ID) {
    await runImplementation({
      rootDir,
      agentId,
      taskId: process.env.AUTONOMY_TASK_ID,
      branch: requireEnv('AUTONOMY_BRANCH'),
      worktreePath: requireEnv('AUTONOMY_WORKTREE'),
    });
    return;
  }

  if (process.env.AUTONOMY_REVIEW_TASK_ID) {
    await runReviewer({
      rootDir,
      agentId,
      reviewTaskId: process.env.AUTONOMY_REVIEW_TASK_ID,
      prId: requireEnv('AUTONOMY_PR_ID'),
      sourceAgentId: process.env.AUTONOMY_SOURCE_AGENT_ID || '',
    });
    return;
  }

  throw new Error(`No supported runner context for agent "${agentId}".`);
}

async function runImplementation({ rootDir, agentId, taskId, branch, worktreePath }) {
  if (useCodexStub()) {
    return runImplementationStub({ rootDir, agentId, taskId, branch, worktreePath });
  }

  logRunnerEvent('implementation:start', { agentId, taskId, branch, worktreePath });
  const state = loadState(rootDir);
  const agent = getAgentConfig(state.config, agentId);
  const task = getTask(state.queues, taskId);
  const laneKey = buildTaskLaneKey(task);
  const laneTasks = getLaneTasks(state.queues, agentId, laneKey);
  const remainingLaneTasks = laneTasks.filter((candidate) => candidate.id !== task.id);
  const existingPr = getPrForLane(rootDir, agentId, laneKey);
  const completedLaneTasks = getCompletedLaneTasks(rootDir, agentId, laneKey);
  const taskAlreadyCompleted = completedLaneTasks.some((candidate) => candidate.id === task.id);
  logRunnerEvent('implementation:read-task', {
    taskId: task.id,
    taskType: task.type || 'implementation',
    laneKey,
    laneTaskIds: laneTasks.map((candidate) => candidate.id),
    remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
    completedTaskIds: completedLaneTasks.map((candidate) => candidate.id),
    existingPrId: existingPr ? existingPr.id : null,
  });
  if (existingPr) {
    logRunnerEvent('implementation:read-pr', {
      taskId: task.id,
      prId: existingPr.id,
      status: existingPr.status,
      commitCount: getPrCommitCount(existingPr),
      pendingTaskIds: existingPr.pendingTaskIds || [],
      reviewDecisions: (existingPr.reviews || []).map((review) => review.decision),
    });
  }
  const checkCommands = resolveCheckCommands({
    task,
    existingPr,
    remainingLaneTasks,
    completedLaneTasks,
  });
  ensureCheckEnvironment(worktreePath, checkCommands);
  const codexResult = await executeTaskWithCodex({
    rootDir,
    agent,
    task,
    laneTasks,
    pr: existingPr,
    branch,
    worktreePath,
  });
  logRunnerEvent('implementation:codex', {
    taskId: task.id,
    status: codexResult.status,
    summary: summarizeText(codexResult.summary || codexResult.notes),
  });

  if (codexResult.status !== 'completed') {
    throw new Error(`Codex blocked implementation for ${task.id}: ${codexResult.summary || codexResult.notes || 'no summary'}`);
  }

  const changedFiles = listChangedFiles(worktreePath);
  if (changedFiles.length === 0 && !taskAlreadyCompleted) {
    throw new Error(`Codex completed ${task.id} without changing any files.`);
  }

  let scopeResult = {
    ok: true,
    files: changedFiles,
    includeGlobs: [],
    excludeGlobs: [],
    violations: [],
  };
  if (changedFiles.length > 0) {
    scopeResult = evaluateScope({
      files: changedFiles,
      agent,
      task,
    });
    if (!scopeResult.ok) {
      logRunnerEvent('implementation:scope-warning', {
        taskId: task.id,
        violations: scopeResult.violations,
      });
    }
  }

  const checkResults = runCheckCommands(
    worktreePath,
    checkCommands
  );
  const failedChecks = checkResults.filter((entry) => entry.status === 'failed');
  if (failedChecks.length > 0) {
    throw new Error(`Required checks failed: ${failedChecks.map((entry) => entry.command).join(', ')}`);
  }

  let commitMessage = null;
  let commitSha = null;
  let completedTaskIds = completedLaneTasks.map((candidate) => candidate.id);
  if (changedFiles.length > 0) {
    runGit(worktreePath, ['add', '--all', '--', ...changedFiles]);
    commitMessage = buildCommitMessage(agentId, task, completedLaneTasks.length > 0 || Boolean(existingPr));
    runGit(worktreePath, ['commit', '-m', commitMessage]);
    commitSha = readGit(worktreePath, ['rev-parse', 'HEAD']);
    logRunnerEvent('implementation:commit', {
      taskId: task.id,
      branch,
      commitMessage,
      commitSha,
      changedFiles,
    });
    completedTaskIds = recordLaneTaskCompletion(rootDir, task, branch, worktreePath, scopeResult)
      .map((candidate) => candidate.id);
  }
  const pushResult = tryPushBranch(worktreePath, branch);
  logRunnerEvent('implementation:push', {
    taskId: task.id,
    branch,
    pushed: pushResult.ok,
    message: pushResult.message,
  });
  if (Boolean(existingPr) || remainingLaneTasks.length === 0) {
    logRunnerEvent('implementation:record-pr', {
      taskId: task.id,
      branch,
      existingPrId: existingPr ? existingPr.id : null,
      completedTaskIds,
      publish: Boolean(pushResult.ok && hasGithubAuth()),
    });
  }
  finalizeTaskRun({
    rootDir,
    task,
    branch,
    completedTaskIds,
    publish: pushResult.ok && hasGithubAuth(),
    shouldRecordPr: Boolean(existingPr) || remainingLaneTasks.length === 0,
  });
  logRunnerEvent('implementation:done', {
    taskId: task.id,
    changedFiles: changedFiles.length,
    commitMessage,
    pushed: pushResult.ok,
    published: Boolean(pushResult.ok && hasGithubAuth()),
    prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
  });

  appendRunnerLog(rootDir, agentId, 'runner:implementation', {
    input: {
      taskId: task.id,
      laneKey,
      laneTaskIds: laneTasks.map((candidate) => candidate.id),
      remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
      branch,
      worktreePath,
    },
    output: {
      changedFiles,
      checkResults,
      codex: codexResult,
      scopeResult,
      commitMessage,
      commitSha,
      completedTaskIds,
      replayedCompletedTask: taskAlreadyCompleted && changedFiles.length === 0,
      prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
      pushed: pushResult.ok,
      published: Boolean(pushResult.ok && hasGithubAuth()),
      pushMessage: pushResult.message,
    },
  });
}

function runImplementationStub({ rootDir, agentId, taskId, branch, worktreePath }) {
  logRunnerEvent('implementation:start', { agentId, taskId, branch, worktreePath, stub: true });
  const state = loadState(rootDir);
  const task = getTask(state.queues, taskId);
  const laneKey = buildTaskLaneKey(task);
  const laneTasks = getLaneTasks(state.queues, agentId, laneKey);
  const remainingLaneTasks = laneTasks.filter((candidate) => candidate.id !== task.id);
  const existingPr = getPrForLane(rootDir, agentId, laneKey);
  const completedLaneTasks = getCompletedLaneTasks(rootDir, agentId, laneKey);
  const taskAlreadyCompleted = completedLaneTasks.some((candidate) => candidate.id === task.id);
  logRunnerEvent('implementation:read-task', {
    taskId: task.id,
    taskType: task.type || 'implementation',
    laneKey,
    laneTaskIds: laneTasks.map((candidate) => candidate.id),
    remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
    completedTaskIds: completedLaneTasks.map((candidate) => candidate.id),
    existingPrId: existingPr ? existingPr.id : null,
    stub: true,
  });
  if (existingPr) {
    logRunnerEvent('implementation:read-pr', {
      taskId: task.id,
      prId: existingPr.id,
      status: existingPr.status,
      commitCount: getPrCommitCount(existingPr),
      pendingTaskIds: existingPr.pendingTaskIds || [],
      reviewDecisions: (existingPr.reviews || []).map((review) => review.decision),
      stub: true,
    });
  }
  const targetFile = resolveTargetFile(worktreePath, task);
  ensureDir(path.dirname(targetFile));
  const alreadyExists = fs.existsSync(targetFile);
  let commitMessage = null;
  let commitSha = null;
  let completedTaskIds = completedLaneTasks.map((candidate) => candidate.id);
  if (!taskAlreadyCompleted) {
    const generatedAt = new Date().toISOString();
    const content = alreadyExists
      ? `${fs.readFileSync(targetFile, 'utf8').trimEnd()}\n- Follow-up (${task.id}): ${generatedAt}\n`
      : [
        `# ${task.title}`,
        '',
        `- Agent: ${agentId}`,
        `- Task: ${task.id}`,
        `- Lane: ${laneKey}`,
        `- Generated: ${generatedAt}`,
        task.description ? `- Description: ${task.description}` : null,
        '',
        '## Acceptance',
        ...(task.acceptance || []).map((entry) => `- ${entry}`),
        '- Automated implementation runner created this draft change.',
        '',
      ].filter(Boolean).join('\n');

    fs.writeFileSync(targetFile, content, 'utf8');
    runGit(worktreePath, ['add', path.relative(worktreePath, targetFile)]);
    commitMessage = buildCommitMessage(agentId, task, completedLaneTasks.length > 0 || Boolean(existingPr));
    runGit(worktreePath, ['commit', '-m', commitMessage]);
    commitSha = readGit(worktreePath, ['rev-parse', 'HEAD']);
    logRunnerEvent('implementation:commit', {
      taskId: task.id,
      branch,
      commitMessage,
      commitSha,
      changedFiles: [path.relative(worktreePath, targetFile)],
      stub: true,
    });
    completedTaskIds = recordLaneTaskCompletion(rootDir, task, branch, worktreePath)
      .map((candidate) => candidate.id);
  }
  const pushResult = tryPushBranch(worktreePath, branch);
  logRunnerEvent('implementation:push', {
    taskId: task.id,
    branch,
    pushed: pushResult.ok,
    message: pushResult.message,
    stub: true,
  });
  if (Boolean(existingPr) || remainingLaneTasks.length === 0) {
    logRunnerEvent('implementation:record-pr', {
      taskId: task.id,
      branch,
      existingPrId: existingPr ? existingPr.id : null,
      completedTaskIds,
      publish: Boolean(pushResult.ok && hasGithubAuth()),
      stub: true,
    });
  }
  finalizeTaskRun({
    rootDir,
    task,
    branch,
    completedTaskIds,
    publish: pushResult.ok && hasGithubAuth(),
    shouldRecordPr: Boolean(existingPr) || remainingLaneTasks.length === 0,
  });
  logRunnerEvent('implementation:done', {
    taskId: task.id,
    changedFiles: taskAlreadyCompleted ? 0 : 1,
    commitMessage,
    pushed: pushResult.ok,
    published: Boolean(pushResult.ok && hasGithubAuth()),
    prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
    stub: true,
  });

  appendRunnerLog(rootDir, agentId, 'runner:implementation', {
    input: {
      taskId: task.id,
      laneKey,
      laneTaskIds: laneTasks.map((candidate) => candidate.id),
      remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
      branch,
      worktreePath,
    },
    output: {
      targetFiles: [path.relative(worktreePath, targetFile)],
      commitMessages: commitMessage ? [commitMessage] : [],
      commitSha,
      completedTaskIds,
      replayedCompletedTask: taskAlreadyCompleted,
      prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
      pushed: pushResult.ok,
      published: Boolean(pushResult.ok && hasGithubAuth()),
      pushMessage: pushResult.message,
    },
  });
}

async function runReviewer({ rootDir, agentId, reviewTaskId, prId, sourceAgentId }) {
  if (useCodexStub()) {
    return runReviewerStub({ rootDir, agentId, reviewTaskId, prId, sourceAgentId });
  }

  logRunnerEvent('review:start', { agentId, reviewTaskId, prId, sourceAgentId });
  const state = loadState(rootDir);
  const agent = getAgentConfig(state.config, agentId);
  const reviewerTask = getReviewTask(state.queues, reviewTaskId);
  const pr = getPr(rootDir, prId);
  const reviewRound = Number(reviewerTask.reviewRound || 1);
  logRunnerEvent('review:read-task', {
    reviewTaskId,
    prId: pr.id,
    sourceAgentId,
    reviewRound,
    prStatus: pr.status,
    commitCount: getPrCommitCount(pr),
    lastDecision: reviewerTask.lastDecision || null,
  });
  if (shouldRetryApprovedPrMerge(pr, reviewerTask)) {
    logRunnerEvent('review:merge-retry', {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
      commitCount: getPrCommitCount(pr),
    });
    const mergeResult = tryMergeWithRetry(rootDir, pr.id, agentId);
    const mergeCommentPublished = !mergeResult.merged
      ? publishMergeFollowupCommentIfNeeded(rootDir, pr, reviewerTask, mergeResult.message)
      : false;
    if (!mergeResult.merged) {
      persistReviewerTaskState(rootDir, state.config, reviewTaskId, {
        status: 'approved',
        updatedAt: new Date().toISOString(),
        lastError: null,
        lastMergeFailureMessage: normalizeNonEmptyString(mergeResult.message),
      });
    }
    logRunnerEvent('review:done', {
      reviewTaskId,
      prId: pr.id,
      decision: 'approve',
      merged: mergeResult.merged,
      mergeMessage: mergeResult.message,
      followupOnly: true,
    });

    appendRunnerLog(rootDir, agentId, 'runner:review', {
      input: {
        reviewTaskId,
        prId: pr.id,
        reviewRound,
        followupOnly: true,
      },
      output: {
        decision: 'approve',
        merged: mergeResult.merged,
        mergeMessage: mergeResult.message,
        mergeCommentPublished,
      },
    });
    return;
  }
  const reviewContext = ensureReviewContext(rootDir, pr);
  const reviewCommits = listBranchCommits(reviewContext.worktreePath, pr.baseBranch);
  logRunnerEvent('review:read-commits', {
    reviewTaskId,
    prId: pr.id,
    baseBranch: pr.baseBranch,
    commitCount: reviewCommits.length,
    commits: reviewCommits,
  });
  const reviewDiffFiles = listReviewDiffFiles(reviewContext.worktreePath, pr.baseBranch);
  logRunnerEvent('review:read-diff', {
    reviewTaskId,
    prId: pr.id,
    baseBranch: pr.baseBranch,
    fileCount: reviewDiffFiles.length,
    files: reviewDiffFiles,
  });
  const scopeResult = evaluateScope({
    files: reviewDiffFiles,
    agent,
    task: {
      id: pr.taskId,
      allowedPaths: pr.allowedPaths || [],
    },
  });
  ensureCheckEnvironment(reviewContext.worktreePath, pr.checks || []);
  const checkResults = runCheckCommands(reviewContext.worktreePath, pr.checks || []);
  const codexReview = await reviewPrWithCodex({
    rootDir,
    agent,
    reviewTask: reviewerTask,
    pr,
    branch: reviewContext.branch,
    worktreePath: reviewContext.worktreePath,
    checkResults,
    diffFiles: reviewDiffFiles,
    scopeResult,
  });
  logRunnerEvent('review:codex', {
    reviewTaskId,
    decision: codexReview.decision,
    summary: summarizeText(codexReview.summary),
  });
  const failedChecks = checkResults.filter((entry) => entry.status === 'failed');
  const scopeConcernOnly = scopeResult.ok && isScopeOnlyReviewFeedback(codexReview);
  const decision = failedChecks.length > 0
    ? 'changes-requested'
    : !scopeResult.ok
      ? 'changes-requested'
      : scopeConcernOnly
        ? 'approve'
        : codexReview.decision === 'approved'
          ? 'approve'
          : 'changes-requested';
  const summaryParts = scopeConcernOnly
    ? [buildScopeSafeApprovalSummary(pr, reviewDiffFiles, checkResults)]
    : [codexReview.summary].concat(codexReview.concerns || []);
  if (failedChecks.length > 0) {
    summaryParts.push(`Blocking checks failed: ${failedChecks.map((entry) => entry.command).join(', ')}`);
  }
  if (!scopeResult.ok) {
    summaryParts.push(`Blocking scope violations: ${scopeResult.violations.map((entry) => `${entry.file} (${entry.reason})`).join(', ')}`);
  }
  const summary = summaryParts.filter(Boolean).join('\n');

  const reviewArgs = [
    CLI_PATH,
    'review:record',
    '--root',
    rootDir,
    '--pr',
    pr.id,
    '--reviewer',
    agentId,
    '--decision',
    decision,
    '--summary',
    summary,
  ];
  if (pr.remote && pr.remote.number && hasGithubAuth()) {
    reviewArgs.push('--publish');
  }
  execFileSync(process.execPath, reviewArgs, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let merged = false;
  let mergeMessage = null;
  let mergeCommentPublished = false;
  if (decision === 'approve') {
    logRunnerEvent('review:merge-attempt', {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
    });
    const mergeResult = tryMergeWithRetry(rootDir, pr.id, agentId);
    merged = mergeResult.merged;
    mergeMessage = mergeResult.message;
    if (!merged) {
      mergeCommentPublished = publishMergeFollowupCommentIfNeeded(rootDir, pr, reviewerTask, mergeMessage);
      persistReviewerTaskState(rootDir, state.config, reviewTaskId, {
        status: 'approved',
        updatedAt: new Date().toISOString(),
        lastMergeFailureMessage: normalizeNonEmptyString(mergeMessage),
      });
    }
  }
  logRunnerEvent('review:done', {
    reviewTaskId,
    prId: pr.id,
    decision,
    merged,
    mergeMessage,
  });

  appendRunnerLog(rootDir, agentId, 'runner:review', {
    input: {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
      branch: reviewContext.branch,
      worktreePath: reviewContext.worktreePath,
    },
    output: {
      codex: codexReview,
      diffFiles: reviewDiffFiles,
      scopeResult,
      checkResults,
      decision,
      scopeConcernOnly,
      summary,
      merged,
      mergeMessage,
      mergeCommentPublished,
    },
  });
}

function runReviewerStub({ rootDir, agentId, reviewTaskId, prId, sourceAgentId }) {
  logRunnerEvent('review:start', { agentId, reviewTaskId, prId, sourceAgentId, stub: true });
  const state = loadState(rootDir);
  const reviewerTask = getReviewTask(state.queues, reviewTaskId);
  const pr = getPr(rootDir, prId);
  const reviewRound = Number(reviewerTask.reviewRound || 1);
  logRunnerEvent('review:read-task', {
    reviewTaskId,
    prId: pr.id,
    sourceAgentId,
    reviewRound,
    prStatus: pr.status,
    commitCount: getPrCommitCount(pr),
    lastDecision: reviewerTask.lastDecision || null,
    stub: true,
  });
  const decision = reviewRound === 1 ? 'changes-requested' : 'approve';
  const summary = reviewRound === 1
    ? `Add one more ${sourceAgentId.replace(/-agent$/, '') || 'feature'} follow-up line before merge.`
    : `Ready to merge ${pr.title}.`;

  if (pr.remote && pr.remote.number && hasGithubAuth()) {
    const repo = resolveGithubRepo(rootDir);
    postIssueComment(repo, resolveGithubAuthToken({ required: true }), pr.remote.number, `reviewer-agent:\n\n${summary}`);
  }

  execFileSync(process.execPath, [
    CLI_PATH,
    'review:record',
    '--root',
    rootDir,
    '--pr',
    pr.id,
    '--reviewer',
    agentId,
    '--decision',
    decision,
    '--summary',
    summary,
  ], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let merged = false;
  let mergeMessage = null;
  if (decision === 'approve') {
    logRunnerEvent('review:merge-attempt', {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
      stub: true,
    });
    const mergeResult = tryMergeWithRetry(rootDir, pr.id, agentId);
    merged = mergeResult.merged;
    mergeMessage = mergeResult.message;
  }
  logRunnerEvent('review:done', {
    reviewTaskId,
    prId: pr.id,
    decision,
    merged,
    mergeMessage,
    stub: true,
  });

  appendRunnerLog(rootDir, agentId, 'runner:review', {
    input: {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
    },
    output: {
      decision,
      summary,
      merged,
      mergeMessage,
    },
  });
}

function loadState(rootDir) {
  const repoAutonomyDir = path.join(rootDir, ...AUTONOMY_SEGMENTS);
  const config = readJson(path.join(repoAutonomyDir, 'config', 'agents.json'));
  const queues = {};
  (config.agents || []).forEach((agent) => {
    if (!agent.taskQueue) {
      return;
    }
    const queuePath = path.isAbsolute(agent.taskQueue)
      ? agent.taskQueue
      : resolveRuntimeManagedPath(rootDir, agent.taskQueue);
    queues[agent.id] = readJson(queuePath);
  });
  return {
    config,
    queues,
  };
}

function getTask(queues, taskId) {
  for (const queue of Object.values(queues)) {
    const task = (queue.tasks || []).find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function getLaneTasks(queues, agentId, laneKey) {
  return Object.values(queues)
    .filter((queue) => queue.agentId === agentId)
    .flatMap((queue) => queue.tasks || [])
    .filter((candidate) => buildTaskLaneKey(candidate) === laneKey)
    .sort((left, right) => {
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    });
}

function buildTaskLaneKey(task) {
  if (task.laneKey) {
    return task.laneKey;
  }
  if (task.prdId) {
    return `${task.prdId}:${task.agentId}`;
  }
  return task.id;
}

function resolveTargetFile(worktreePath, task) {
  const allowedPath = (task.allowedPaths || [])[0];
  if (!allowedPath) {
    return path.join(worktreePath, `AUTONOMY_${slugify(task.id)}.md`);
  }

  const rootSegment = trimGlob(allowedPath);
  const absoluteRoot = path.join(worktreePath, rootSegment);
  const looksLikeFile = path.extname(rootSegment) !== '';
  if (looksLikeFile) {
    return absoluteRoot;
  }
  return path.join(absoluteRoot, `AUTONOMY_${slugify(task.id)}.md`);
}

function trimGlob(value) {
  const normalized = String(value || '').replace(/\\/g, '/');
  const wildcardIndex = normalized.search(/[*?[]/);
  if (wildcardIndex === -1) {
    return normalized.replace(/\/+$/, '');
  }
  const prefix = normalized.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/, '');
}

function buildCommitMessage(agentId, task, hasPriorLaneWork) {
  const verb = hasPriorLaneWork ? 'followup' : 'draft';
  return `auto(${agentId}): ${verb} ${task.id}`;
}

function finalizeTaskRun({ rootDir, task, branch, completedTaskIds, publish, shouldRecordPr }) {
  if (shouldRecordPr) {
    const recordArgs = [
      CLI_PATH,
      'pr:record',
      '--root',
      rootDir,
      '--task',
      task.id,
      '--head-branch',
      branch,
    ];
    completedTaskIds.forEach((completedTaskId) => {
      recordArgs.push('--completed-task', completedTaskId);
    });
    if (publish) {
      recordArgs.push('--publish');
    }
    execFileSync(process.execPath, recordArgs, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  try {
    execFileSync(process.execPath, [
      CLI_PATH,
      'task:finish',
      '--root',
      rootDir,
      '--task',
      task.id,
    ], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (!shouldIgnoreMissingTaskFinishError(error, task.id)) {
      throw error;
    }
  }
}

function listChangedFiles(worktreePath) {
  const tracked = execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMR', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return uniqueStrings([
    ...tracked.split('\n').filter(Boolean),
    ...untracked.split('\n').filter(Boolean),
  ]);
}

function runCheckCommands(worktreePath, commands) {
  return uniqueStrings(commands).map((command) => {
    try {
      execFileSync(command, {
        cwd: worktreePath,
        encoding: 'utf8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {
        command,
        status: 'passed',
      };
    } catch (error) {
      return {
        command,
        status: 'failed',
        output: [String(error.stdout || '').trim(), String(error.stderr || '').trim()].filter(Boolean).join('\n').trim(),
      };
    }
  });
}

function listReviewDiffFiles(worktreePath, baseBranch) {
  const baseRef = gitRefExists(worktreePath, `origin/${baseBranch}`)
    ? `origin/${baseBranch}`
    : baseBranch;
  const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: worktreePath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return output ? output.split('\n').filter(Boolean) : [];
}

function listBranchCommits(worktreePath, baseBranch) {
  const baseRef = gitRefExists(worktreePath, `origin/${baseBranch}`)
    ? `origin/${baseBranch}`
    : baseBranch;
  const output = readGit(worktreePath, ['log', '--format=%H%x09%s', `${baseRef}..HEAD`]);
  if (!output) {
    return [];
  }
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\t');
      return {
        sha: String(sha || '').slice(0, 12),
        subject: String(subject || '').trim(),
      };
    });
}

function ensureCheckEnvironment(worktreePath, commands) {
  if (!requiresNodeInstall(commands)) {
    return;
  }
  if (!fs.existsSync(path.join(worktreePath, 'package.json'))) {
    return;
  }
  if (fs.existsSync(path.join(worktreePath, 'node_modules'))) {
    return;
  }

  const npmArgs = fs.existsSync(path.join(worktreePath, 'package-lock.json'))
    ? ['ci', '--ignore-scripts']
    : ['install', '--ignore-scripts'];
  execFileSync('npm', npmArgs, {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requiresNodeInstall(commands) {
  return uniqueStrings(commands).some((command) => /(^|\s)(npm|npx)\s/.test(command));
}

function isScopeOnlyReviewFeedback(codexReview) {
  if (!codexReview || codexReview.decision !== 'changes_requested') {
    return false;
  }
  const summaryText = String(codexReview.summary || '').trim().toLowerCase();
  const concerns = Array.isArray(codexReview.concerns)
    ? codexReview.concerns.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const scopeOnlyTexts = concerns.length > 0 ? concerns : (summaryText ? [summaryText] : []);
  if (scopeOnlyTexts.length === 0) {
    return false;
  }
  const scopeSignals = [
    /out-of-scope/,
    /outside (?:the )?(?:allowed|lane) path/,
    /outside (?:the )?allowed scope/,
    /allowed paths?/,
    /allowedpaths/,
    /scope violation/,
    /extra file/,
    /unexpected file/,
    /unreviewed file/,
    /unreviewed diff/,
    /git diff --name-status/,
  ];
  const blockingSignals = [
    /blocking/,
    /not safe to merge/,
    /unimplemented/,
    /missing/,
    /absent/,
    /not present/,
    /placeholder/,
    /does not/,
    /never /,
    /still has/,
    /still lacks/,
    /gap/,
    /fails?/,
  ];

  if ([summaryText].concat(scopeOnlyTexts).some((entry) => blockingSignals.some((pattern) => pattern.test(entry)))) {
    return false;
  }

  return scopeOnlyTexts.every((entry) => scopeSignals.some((pattern) => pattern.test(entry)));
}

function buildScopeSafeApprovalSummary(pr, diffFiles, checkResults) {
  const changed = diffFiles.length > 0 ? diffFiles.join(', ') : 'no file changes';
  const passedChecks = checkResults
    .filter((entry) => entry.status === 'passed')
    .map((entry) => entry.command)
    .join(', ');
  const checksText = passedChecks ? ` The provided required checks passed: ${passedChecks}.` : '';
  return `Approved. Compared against origin/${pr.baseBranch}, the diff stays within the lane PR allowed paths (${changed}).${checksText}`;
}

function resolveCheckCommands({ task, existingPr, remainingLaneTasks, completedLaneTasks }) {
  if (existingPr) {
    return uniqueStrings([
      ...(existingPr.checks || []),
      ...(task.checks || []),
    ]);
  }
  if (remainingLaneTasks.length === 0) {
    return uniqueStrings([
      ...completedLaneTasks.flatMap((candidate) => candidate.checks || []),
      ...(task.checks || []),
    ]);
  }
  return uniqueStrings(task.checks || []);
}

function getAgentConfig(config, agentId) {
  const agent = (config.agents || []).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent "${agentId}".`);
  }
  return agent;
}

function ensureReviewContext(rootDir, pr) {
  syncBaseBranchRef(rootDir, pr.baseBranch);
  const branchLock = getBranchLock(rootDir, pr);
  if (branchLock && fs.existsSync(branchLock.worktreePath) && isGitWorktree(branchLock.worktreePath)) {
    return {
      branch: branchLock.branch || pr.headBranch,
      worktreePath: branchLock.worktreePath,
    };
  }

  const reviewRoot = path.join(rootDir, ...RUNTIME_SEGMENTS, 'reviews');
  const reviewPath = path.join(reviewRoot, slugify(pr.id));
  ensureDir(reviewRoot);
  if (!fs.existsSync(reviewPath)) {
    runGit(rootDir, ['worktree', 'add', '--detach', reviewPath, pr.headBranch]);
  } else if (isGitWorktree(reviewPath)) {
    runGit(reviewPath, ['reset', '--hard', pr.headBranch]);
    runGit(reviewPath, ['clean', '-fd']);
  } else {
    throw new Error(`Review worktree path "${reviewPath}" exists but is not a git worktree.`);
  }

  return {
    branch: pr.headBranch,
    worktreePath: reviewPath,
  };
}

function syncBaseBranchRef(rootDir, baseBranch) {
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  if (!gitRefExists(rootDir, remoteRef)) {
    return;
  }
  execFileSync('git', ['update-ref', `refs/heads/${baseBranch}`, remoteRef], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function getBranchLock(rootDir, pr) {
  const branchLocksPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'branch-locks.json');
  if (!fs.existsSync(branchLocksPath)) {
    return null;
  }
  const branchLocks = readJson(branchLocksPath);
  return (branchLocks.locks || []).find((candidate) => {
    return candidate.agentId === pr.agentId
      && (candidate.laneKey || candidate.taskId) === (pr.laneKey || pr.taskId);
  }) || null;
}

function getCompletedLaneTasks(rootDir, agentId, laneKey) {
  const branchLocksPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'branch-locks.json');
  if (!fs.existsSync(branchLocksPath)) {
    return [];
  }
  const branchLocks = readJson(branchLocksPath);
  const branchLock = findBranchLock(branchLocks, agentId, laneKey);
  return Array.isArray(branchLock && branchLock.completedTasks)
    ? branchLock.completedTasks.slice()
    : [];
}

function recordLaneTaskCompletion(rootDir, task, branch, worktreePath, scopeResult) {
  const laneKey = buildTaskLaneKey(task);
  const release = acquireStateLock(rootDir);
  try {
    const branchLocksPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'branch-locks.json');
    const branchLocks = fs.existsSync(branchLocksPath)
      ? readJson(branchLocksPath)
      : { locks: [] };
    let branchLock = findBranchLock(branchLocks, task.agentId, laneKey);
    if (!branchLock) {
      branchLock = {
        taskId: task.id,
        laneKey,
        agentId: task.agentId,
        branch,
        worktreePath,
        completedTasks: [],
      };
      branchLocks.locks.push(branchLock);
    }
    branchLock.taskId = task.id;
    branchLock.branch = branch;
    branchLock.worktreePath = worktreePath;
    branchLock.updatedAt = new Date().toISOString();
    branchLock.completedTasks = Array.isArray(branchLock.completedTasks) ? branchLock.completedTasks : [];
    const snapshot = buildTaskSnapshot(task, scopeResult);
    const currentIndex = branchLock.completedTasks.findIndex((candidate) => candidate.id === task.id);
    if (currentIndex >= 0) {
      branchLock.completedTasks[currentIndex] = {
        ...branchLock.completedTasks[currentIndex],
        ...snapshot,
      };
    } else {
      branchLock.completedTasks.push(snapshot);
    }
    writeJson(branchLocksPath, branchLocks);
    return branchLock.completedTasks.slice();
  } finally {
    release();
  }
}

function buildTaskSnapshot(task, scopeResult) {
  return {
    id: task.id,
    title: task.title,
    description: task.description || '',
    agentId: task.agentId,
    prdId: task.prdId || null,
    laneKey: buildTaskLaneKey(task),
    type: task.type || 'implementation',
    sprintId: task.sprintId || null,
    baseBranch: task.baseBranch || null,
    allowedPaths: uniqueStrings(task.allowedPaths || []),
    checks: uniqueStrings(task.checks || []),
    acceptance: uniqueStrings(task.acceptance || []),
    scopeViolations: uniqueScopeViolations(scopeResult && scopeResult.violations),
    completedAt: new Date().toISOString(),
  };
}

function findBranchLock(branchLocks, agentId, laneKey) {
  return (branchLocks.locks || []).find((candidate) => {
    return candidate.agentId === agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.reduce((accumulator, value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      return accumulator;
    }
    seen.add(normalized);
    accumulator.push(normalized);
    return accumulator;
  }, []);
}

function uniqueScopeViolations(values) {
  const seen = new Set();
  return (values || []).reduce((accumulator, value) => {
    const file = String(value && value.file || '').trim();
    const reason = String(value && value.reason || '').trim();
    const key = `${file}::${reason}`;
    if (!file || !reason || seen.has(key)) {
      return accumulator;
    }
    seen.add(key);
    accumulator.push({ file, reason });
    return accumulator;
  }, []);
}

function useCodexStub() {
  return process.env.AUTONOMY_CODEX_STUB === '1';
}

function tryPushBranch(worktreePath, branch) {
  const githubToken = resolveGithubAuthToken();
  const baseArgs = githubToken
    ? ['-c', `http.extraHeader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${githubToken}`).toString('base64')}`]
    : [];

  try {
    runGit(worktreePath, [...baseArgs, 'push', '-u', 'origin', branch]);
    return { ok: true, message: 'pushed to origin' };
  } catch (error) {
    const message = extractExecError(error);
    if (!/non-fast-forward/i.test(message)) {
      return { ok: false, message };
    }
  }

  try {
    runGit(worktreePath, [...baseArgs, 'push', '--force-with-lease', '-u', 'origin', branch]);
    return { ok: true, message: 'force-pushed to origin with lease' };
  } catch (error) {
    return { ok: false, message: extractExecError(error) };
  }
}

function appendRunnerLog(rootDir, agentId, event, payload) {
  const logPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'agents', agentId, 'log.md');
  ensureDir(path.dirname(logPath));
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${agentId} Log\n`, 'utf8');
  }

  const lines = [
    '',
    `## ${new Date().toISOString()} ${event}`,
    '### Input',
    '```json',
    JSON.stringify(payload.input, null, 2),
    '```',
    '### Output',
    '```json',
    JSON.stringify(payload.output, null, 2),
    '```',
  ];
  fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
}

function getRunnerFailureContext() {
  const runnerType = process.env.AUTONOMY_TASK_ID
    ? 'implementation'
    : process.env.AUTONOMY_REVIEW_TASK_ID
      ? 'review'
      : 'unknown';
  return {
    rootDir: normalizeNonEmptyString(process.env.AUTONOMY_ROOT),
    agentId: normalizeNonEmptyString(process.env.AUTONOMY_AGENT_ID),
    runnerType,
    taskId: normalizeNonEmptyString(process.env.AUTONOMY_TASK_ID),
    reviewTaskId: normalizeNonEmptyString(process.env.AUTONOMY_REVIEW_TASK_ID),
    prId: normalizeNonEmptyString(process.env.AUTONOMY_PR_ID),
    sourceAgentId: normalizeNonEmptyString(process.env.AUTONOMY_SOURCE_AGENT_ID),
    branch: normalizeNonEmptyString(process.env.AUTONOMY_BRANCH),
    worktreePath: normalizeNonEmptyString(process.env.AUTONOMY_WORKTREE),
  };
}

function trimForErrorReport(value, { preferTail = false } = {}) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length <= DEFAULT_ERROR_PREVIEW_LIMIT) {
    return normalized;
  }
  if (preferTail) {
    return `...[truncated]\n${normalized.slice(-DEFAULT_ERROR_PREVIEW_LIMIT)}`;
  }
  return `${normalized.slice(0, DEFAULT_ERROR_PREVIEW_LIMIT)}\n...[truncated]`;
}

function buildRunnerFailureRecord(error, context = getRunnerFailureContext()) {
  const message = normalizeNonEmptyString(error && error.message) || 'Runner failed without an error message.';
  const stderr = trimForErrorReport(error && error.stderr, { preferTail: true });
  const stdout = trimForErrorReport(error && error.stdout, { preferTail: true });
  const stack = trimForErrorReport(error && error.stack);
  return {
    recordedAt: new Date().toISOString(),
    runnerType: context.runnerType,
    agentId: context.agentId,
    taskId: context.taskId,
    reviewTaskId: context.reviewTaskId,
    prId: context.prId,
    sourceAgentId: context.sourceAgentId,
    branch: context.branch,
    worktreePath: context.worktreePath,
    summary: stderr || stdout || message,
    message,
    stderr,
    stdout,
    stack,
  };
}

function buildRunnerFailureEventName(context) {
  if (context.runnerType === 'implementation') {
    return 'implementation:error';
  }
  if (context.runnerType === 'review') {
    return 'review:error';
  }
  return 'error';
}

function publishRunnerFailure(error) {
  const context = getRunnerFailureContext();
  const record = buildRunnerFailureRecord(error, context);
  const eventPayload = {
    summary: record.summary,
  };
  if (record.taskId) {
    eventPayload.taskId = record.taskId;
  }
  if (record.reviewTaskId) {
    eventPayload.reviewTaskId = record.reviewTaskId;
  }
  if (record.prId) {
    eventPayload.prId = record.prId;
  }
  logRunnerErrorEvent(buildRunnerFailureEventName(context), eventPayload);

  if (context.rootDir && context.agentId) {
    try {
      appendRunnerLog(context.rootDir, context.agentId, 'runner:error', {
        input: {
          runnerType: context.runnerType,
          taskId: context.taskId,
          reviewTaskId: context.reviewTaskId,
          prId: context.prId,
          sourceAgentId: context.sourceAgentId,
          branch: context.branch,
          worktreePath: context.worktreePath,
        },
        output: record,
      });
    } catch (_) {
      // Runner failure reporting must not mask the original error.
    }
  }

  const errorReportPath = normalizeNonEmptyString(process.env.AUTONOMY_ERROR_REPORT);
  if (errorReportPath) {
    try {
      ensureDir(path.dirname(errorReportPath));
      fs.writeFileSync(errorReportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (_) {
      // Best effort only.
    }
  }

  return record.summary;
}

function runGit(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function isGitWorktree(worktreePath) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function gitRefExists(rootDir, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function getPrForLane(rootDir, agentId, laneKey) {
  const prsPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'prs.json');
  const prsState = readJson(prsPath);
  return (prsState.pullRequests || []).find((candidate) => {
    return candidate.agentId === agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function getPr(rootDir, prId) {
  const prsPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'prs.json');
  const prsState = readJson(prsPath);
  const pr = (prsState.pullRequests || []).find((candidate) => candidate.id === prId);
  if (!pr) {
    throw new Error(`Unknown PR "${prId}".`);
  }
  return pr;
}

function getReviewTask(queues, reviewTaskId) {
  for (const queue of Object.values(queues)) {
    const task = (queue.tasks || []).find((candidate) => candidate.id === reviewTaskId);
    if (task) {
      return task;
    }
  }
  throw new Error(`Unknown review task "${reviewTaskId}".`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveRuntimeManagedPath(rootDir, relativePath) {
  const normalized = path.normalize(relativePath);
  const trackedStatePrefix = path.join(...AUTONOMY_SEGMENTS, 'state');
  const runtimeStateDir = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state');
  if (normalized === trackedStatePrefix || normalized.startsWith(`${trackedStatePrefix}${path.sep}`)) {
    return path.join(runtimeStateDir, trimLeadingSeparator(normalized.slice(trackedStatePrefix.length)));
  }
  return path.join(rootDir, normalized);
}

function trimLeadingSeparator(value) {
  let normalized = String(value || '');
  while (normalized.startsWith('/') || normalized.startsWith('\\')) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function shouldRetryApprovedPrMerge(pr, reviewerTask) {
  if (latestReviewDecision(pr) !== 'approved') {
    return false;
  }
  if (pr && pr.remote && pr.remote.mergedAt) {
    return false;
  }
  const reviewedCommitCount = Number(reviewerTask && reviewerTask.reviewedCommitCount);
  const currentCommitCount = getPrCommitCount(pr);
  if (Number.isFinite(reviewedCommitCount) && reviewedCommitCount > 0) {
    return currentCommitCount <= reviewedCommitCount;
  }
  return true;
}

function latestReviewDecision(pr) {
  if (!pr || !Array.isArray(pr.reviews) || pr.reviews.length === 0) {
    return '';
  }
  return String(pr.reviews[pr.reviews.length - 1].decision || '');
}

function getPrCommitCount(pr) {
  const count = Number(pr && (pr.commitCount || (pr.remote && pr.remote.commitCount)));
  return Number.isFinite(count) ? count : 0;
}

function shouldIgnoreMissingTaskFinishError(error, taskId) {
  const message = extractExecError(error);
  return message.includes(`Unknown task "${taskId}"`);
}

function publishMergeFollowupCommentIfNeeded(rootDir, pr, reviewerTask, mergeMessage) {
  const normalizedMessage = normalizeNonEmptyString(mergeMessage) || 'Automatic merge did not complete.';
  if (normalizedMessage === reviewerTask.lastMergeFailureMessage) {
    return false;
  }
  if (!pr.remote || !pr.remote.number || !hasGithubAuth()) {
    return false;
  }
  const repo = resolveGithubRepo(rootDir);
  const token = resolveGithubAuthToken({ required: true });
  postIssueComment(
    repo,
    token,
    pr.remote.number,
    buildMergeFollowupComment(normalizedMessage)
  );
  return true;
}

function buildMergeFollowupComment(mergeMessage) {
  return [
    'reviewer-agent:',
    '',
    'I approved this PR, but the automatic merge did not complete.',
    `Latest merge result: ${mergeMessage}`,
    'If new commits land, I will review the updated diff again; otherwise this PR is waiting on merge conditions to clear.',
  ].join('\n');
}

function persistReviewerTaskState(rootDir, config, reviewTaskId, patch) {
  const release = acquireStateLock(rootDir);
  try {
    const state = loadState(rootDir);
    const reviewerTask = getReviewTask(state.queues, reviewTaskId);
    Object.entries(patch || {}).forEach(([key, value]) => {
      if (value === null || typeof value === 'undefined') {
        delete reviewerTask[key];
        return;
      }
      reviewerTask[key] = value;
    });
    writeQueuesState(rootDir, config, state.queues);
  } finally {
    release();
  }
}

function writeQueuesState(rootDir, config, queues) {
  (config.agents || []).forEach((agent) => {
    const queuePath = path.isAbsolute(agent.taskQueue)
      ? agent.taskQueue
      : resolveRuntimeManagedPath(rootDir, agent.taskQueue);
    writeJson(queuePath, queues[agent.id]);
  });
  writeJson(path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'tasks.json'), {
    tasks: Object.values(queues).flatMap((queue) => queue.tasks || []),
  });
}

function normalizeNonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function extractExecError(error) {
  const stderr = normalizeNonEmptyString(error.stderr);
  if (stderr) {
    return stderr;
  }
  const stdout = normalizeNonEmptyString(error.stdout);
  if (stdout) {
    return stdout;
  }
  return normalizeNonEmptyString(error.message) || 'Command failed without stderr/stdout output.';
}

function tryMergeWithRetry(rootDir, prId, agentId) {
  let lastMessage = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      execFileSync(process.execPath, [
        CLI_PATH,
        'merge',
        '--root',
        rootDir,
        '--pr',
        prId,
        '--actor',
        agentId,
        '--execute',
      ], {
        cwd: rootDir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {
        merged: true,
        message: 'merged',
      };
    } catch (error) {
      lastMessage = extractExecError(error);
      if (!/not mergeable|merge already in progress/i.test(lastMessage) || attempt === 3) {
        break;
      }
      sleepMs(1000);
    }
  }

  return {
    merged: false,
    message: lastMessage,
  };
}

function sleepMs(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function resolveGithubRepo(rootDir) {
  const remoteUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.hostname === 'github.com') {
      const trimmedPath = parsedUrl.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
      const segments = trimmedPath.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return {
          owner: segments[0],
          repo: segments.slice(1).join('/'),
        };
      }
    }
  } catch (error) {
    // Fall back to regex parsing for non-URL formats.
  }

  const httpsMatch = remoteUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
    };
  }

  throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
}

function postIssueComment(repo, token, issueNumber, body) {
  return githubRequest(repo, token, 'POST', `/issues/${issueNumber}/comments`, { body });
}

function githubRequest(repo, token, method, endpoint, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo.owner}/${repo.repo}${endpoint}`,
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'fluxborne-autonomy-v2-runner',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };

  if (body) {
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }

  const response = execHttpRequest(options, body);
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return response.payload;
  }
  throw new Error(`GitHub API ${response.statusCode}: ${response.payload.message || response.raw}`);
}

function execHttpRequest(options, body) {
  const result = {
    statusCode: 0,
    payload: {},
    raw: '',
  };

  const response = execFileSync(process.execPath, ['-e', buildHttpClientScript()], {
    cwd: __dirname,
    env: {
      ...process.env,
      AUTONOMY_HTTP_OPTIONS: JSON.stringify(options),
      AUTONOMY_HTTP_BODY: body || '',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  if (response) {
    const parsed = JSON.parse(response);
    result.statusCode = parsed.statusCode;
    result.payload = parsed.payload;
    result.raw = parsed.raw;
  }
  return result;
}

function buildHttpClientScript() {
  return `
const https = require('https');
const options = JSON.parse(process.env.AUTONOMY_HTTP_OPTIONS);
const body = process.env.AUTONOMY_HTTP_BODY || '';
const req = https.request(options, (res) => {
  let raw = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => {
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_) {}
    process.stdout.write(JSON.stringify({ statusCode: res.statusCode, payload, raw }));
  });
});
req.on('error', (error) => {
  process.stderr.write(error.message);
  process.exit(1);
});
if (body) req.write(body);
req.end();
`;
}

if (require.main === module) {
  main().catch((error) => {
    const summary = publishRunnerFailure(error);
    console.error(`ERROR: ${summary}`);
    process.exit(1);
  });
}

module.exports = {
  buildRunnerFailureRecord,
  buildMergeFollowupComment,
  extractExecError,
  isScopeOnlyReviewFeedback,
  main,
  normalizeNonEmptyString,
  shouldIgnoreMissingTaskFinishError,
  shouldRetryApprovedPrMerge,
};
