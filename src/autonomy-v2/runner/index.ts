#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { evaluateScope } from '../scope/index.js';
import { hasGithubAuth, resolveGithubAuthToken } from '../../github/index.js';
import { acquireStateLock } from '../../lock/index.js';
import { executeTaskWithCodex, reviewPrWithCodex, } from '../../codex/index.js';
import { loadAutonomyEnv } from '../../env/index.js';
import { AGENT_ROLES, RUNNER_TYPES, TASK_TYPES, buildRoleEventName, getRoleAgentLabel, getRoleLabel, getRunnerTypeForRole, isImplementationRole, } from '../../agents/role-catalog.js';
import { runImplementationFlow } from './task-flow.js';
import { runReviewFlow } from './gate-flow.js';
import { ensureDir, extractExecError, logRunnerErrorEvent, logRunnerEvent, normalizeNonEmptyString, readJson, requireEnv, slugify, sleepMs, summarizeText, trimForErrorReport, trimLeadingSeparator, uniqueScopeViolations, uniqueStrings, writeJson, } from './shared.js';
import { postIssueComment, resolveGithubRepo, } from './net.js';
import type { AnyRecord, AutonomyConfig, QueueMap, QueueState, TaskRecord } from '../../types.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.join(__dirname, '..', 'index.js');
const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const REVIEW_AUTO_APPROVAL_THRESHOLD = 4;

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

async function runImplementation(params) {
  return runImplementationFlow(params, runnerDependencies);
}

async function runReviewer(params) {
  return runReviewFlow(params, runnerDependencies);
}

const runnerDependencies = {
  AGENT_ROLES,
  CLI_PATH,
  TASK_TYPES,
  appendRunnerLog,
  buildCommitMessage,
  buildQueueMetadataCommitMessage,
  buildRoleEventName,
  buildScopeSafeApprovalSummary,
  buildTaskLaneKey,
  ensureCheckEnvironment,
  ensureDir,
  ensureReviewContext,
  evaluateScope,
  execFileSync,
  executeTaskWithCodex,
  finalizeTaskRun,
  fs,
  getAgentConfig,
  getCompletedLaneTasks,
  getLaneTasks,
  getPr,
  getPrCommitCount,
  getPrForLane,
  getReviewTask,
  getRoleAgentLabel,
  getRoleLabel,
  getTask,
  hasGithubAuth,
  isPendingImplementationTask,
  isScopeOnlyReviewFeedback,
  listBranchCommits,
  listChangedFiles,
  listReviewDiffFiles,
  loadState,
  logRunnerEvent,
  markImplementationTaskComplete,
  normalizeNonEmptyString,
  path,
  persistReviewerTaskState,
  postIssueComment,
  publishMergeFollowupCommentIfNeeded,
  readGit,
  recordImplementationTaskCommitSha,
  recordLaneTaskCompletion,
  resolveCheckCommands,
  resolveGithubAuthToken,
  resolveGithubRepo,
  resolveTargetFile,
  reviewPrWithCodex,
  runCheckCommands,
  runGit,
  shouldForceApproveAfterRepeatedReviews,
  shouldRetryApprovedPrMerge,
  summarizeText,
  tryMergeWithRetry,
  tryPushBranch,
  uniqueStrings,
  useCodexStub,
};

function loadState(rootDir: string, options: AnyRecord = {}): { config: AutonomyConfig; queues: QueueMap } {
  const repoAutonomyDir = path.join(rootDir, ...AUTONOMY_SEGMENTS);
  const config = readJson(path.join(repoAutonomyDir, 'config', 'agents.json'));
  const queues = {};
  (config.agents || []).forEach((agent) => {
    const relativePath = agent.taskQueue;
    const queuePath = isImplementationRole(agent.role)
      ? (
        options.worktreePath && options.implementationAgentId === agent.id
          ? path.join(options.worktreePath, relativePath)
          : path.join(rootDir, relativePath)
      )
      : path.isAbsolute(relativePath)
        ? relativePath
        : resolveRuntimeManagedPath(rootDir, relativePath);
    queues[agent.id] = fs.existsSync(queuePath)
      ? readJson(queuePath)
      : buildTaskQueueState(agent, []);
  });
  return {
    config,
    queues,
  };
}


function buildTaskQueueState(agent: AnyRecord, tasks: TaskRecord[] = []): QueueState {
  return isImplementationRole(agent.role)
    ? {
        schemaVersion: 1,
        agentId: agent.id,
        role: agent.role,
        tasks,
      }
    : {
        agentId: agent.id,
        role: agent.role,
        tasks,
      };
}

function getImplementationTaskState(task) {
  return String((task && (task.state || task.status)) || '').trim();
}

function isPendingImplementationTask(task) {
  const state = getImplementationTaskState(task);
  return state === 'active' || state === 'queued';
}

function getTask(queues: QueueMap, taskId: string): TaskRecord {
  for (const queue of Object.values(queues)) {
    const task = (queue.tasks || []).find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function getLaneTasks(queues: QueueMap, agentId: string, laneKey: string): TaskRecord[] {
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

function resolveTargetFile(worktreePath, task, agent) {
  const includePath = ((agent && agent.include) || [])[0];
  if (!includePath) {
    return path.join(worktreePath, `AUTONOMY_${slugify(task.id)}.md`);
  }

  const rootSegment = trimGlob(includePath);
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

function buildQueueMetadataCommitMessage(agentId, task) {
  return `auto(${agentId}): record ${task.id}`;
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
}

function markImplementationTaskComplete(worktreePath, config, task, branch, completionMode) {
  const agent = getAgentConfig(config, task.agentId);
  const relativePath = agent.taskQueue;
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Implementation queue for "${task.agentId}" must be repo-relative inside the worktree.`);
  }
  const queuePath = path.join(worktreePath, relativePath);
  const queueState = fs.existsSync(queuePath)
    ? readJson(queuePath)
    : buildTaskQueueState(agent, []);
  const tasks = Array.isArray(queueState.tasks) ? queueState.tasks : [];
  const currentTask = tasks.find((candidate) => candidate.id === task.id);
  if (!currentTask) {
    throw new Error(`Implementation queue in ${relativePath} does not contain task "${task.id}".`);
  }
  const now = new Date().toISOString();
  currentTask.state = 'done';
  currentTask.status = 'done';
  currentTask.branch = branch;
  currentTask.updatedAt = now;
  currentTask.completedAt = now;
  currentTask.completionMode = completionMode;
  delete currentTask.lastError;

  if (!tasks.some((candidate) => candidate.id !== task.id && getImplementationTaskState(candidate) === 'active')) {
    const nextTask = tasks.find((candidate) => candidate.id !== task.id && getImplementationTaskState(candidate) === 'queued');
    if (nextTask) {
      nextTask.state = 'active';
      nextTask.status = 'active';
      nextTask.branch = branch;
      nextTask.startedAt = nextTask.startedAt || now;
      nextTask.updatedAt = now;
    }
  }

  writeJson(queuePath, buildTaskQueueState(agent, tasks));
  return {
    queuePath,
    relativePath,
  };
}

function recordImplementationTaskCommitSha(worktreePath, config, task, commitSha) {
  const agent = getAgentConfig(config, task.agentId);
  const relativePath = agent.taskQueue;
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Implementation queue for "${task.agentId}" must be repo-relative inside the worktree.`);
  }
  const queuePath = path.join(worktreePath, relativePath);
  const queueState = fs.existsSync(queuePath)
    ? readJson(queuePath)
    : buildTaskQueueState(agent, []);
  const tasks = Array.isArray(queueState.tasks) ? queueState.tasks : [];
  const currentTask = tasks.find((candidate) => candidate.id === task.id);
  if (!currentTask) {
    throw new Error(`Implementation queue in ${relativePath} does not contain task "${task.id}".`);
  }
  if (currentTask.commitSha === commitSha) {
    return {
      queuePath,
      relativePath,
      changed: false,
    };
  }
  currentTask.commitSha = commitSha;
  currentTask.updatedAt = new Date().toISOString();
  writeJson(queuePath, buildTaskQueueState(agent, tasks));
  return {
    queuePath,
    relativePath,
    changed: true,
  };
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
    /outside (?:the )?(?:agent|lane) scope/,
    /agent scope/,
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
  return `Approved. Compared against origin/${pr.baseBranch}, the diff stays within the lane agent scope (${changed}).${checksText}`;
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
    type: task.type || TASK_TYPES.DEFAULT,
    sprintId: task.sprintId || null,
    baseBranch: task.baseBranch || null,
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
    ? getRunnerTypeForRole(AGENT_ROLES.IMPLEMENTATION)
    : process.env.AUTONOMY_REVIEW_TASK_ID
      ? getRunnerTypeForRole(AGENT_ROLES.REVIEW)
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
  if (context.runnerType === RUNNER_TYPES.DEFAULT) {
    return buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'error');
  }
  if (context.runnerType === RUNNER_TYPES.REVIEW) {
    return buildRoleEventName(AGENT_ROLES.REVIEW, 'error');
  }
  return 'error';
}

function publishRunnerFailure(error) {
  const context = getRunnerFailureContext();
  const record = buildRunnerFailureRecord(error, context);
  const eventPayload: AnyRecord = {
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

function getReviewTask(queues: QueueMap, reviewTaskId: string): TaskRecord {
  for (const queue of Object.values(queues)) {
    const task = (queue.tasks || []).find((candidate) => candidate.id === reviewTaskId);
    if (task) {
      return task;
    }
  }
  throw new Error(`Unknown ${getRoleLabel(AGENT_ROLES.REVIEW)} task "${reviewTaskId}".`);
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

function shouldForceApproveAfterRepeatedReviews(pr, _checkResults, _scopeResult) {
  const normalizedPr = pr || {};
  const reviewCount = Number.isFinite(Number(normalizedPr.reviews && normalizedPr.reviews.length))
    ? Number(normalizedPr.reviews.length)
    : 0;
  return reviewCount >= REVIEW_AUTO_APPROVAL_THRESHOLD;
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
    `${getRoleAgentLabel(AGENT_ROLES.REVIEW).replace(/\s+/g, '-')}:`,
    '',
    'I approved this PR, but the automatic merge did not complete.',
    `Latest merge result: ${mergeMessage}`,
    `If new commits land, I will ${getRoleLabel(AGENT_ROLES.REVIEW)} the updated diff again; otherwise this PR is waiting on merge conditions to clear.`,
  ].join('\n');
}

function persistReviewerTaskState(rootDir: string, config: AutonomyConfig, reviewTaskId: string, patch: AnyRecord) {
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

function writeQueuesState(rootDir: string, config: AutonomyConfig, queues: QueueMap) {
  (config.agents || []).forEach((agent) => {
    if (isImplementationRole(agent.role)) {
      return;
    }
    const relativePath = agent.taskQueue;
    const queuePath = path.isAbsolute(relativePath)
      ? relativePath
      : resolveRuntimeManagedPath(rootDir, relativePath);
    writeJson(queuePath, queues[agent.id]);
  });
  writeJson(path.join(rootDir, ...RUNTIME_SEGMENTS, 'state', 'tasks.json'), {
    tasks: Object.values(queues)
      .filter((queue) => {
        const agent = getAgentConfig(config, queue.agentId);
        return !isImplementationRole((agent && agent.role) || queue.role || '');
      })
      .flatMap((queue) => queue.tasks || []),
  });
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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const summary = publishRunnerFailure(error);
    console.error(`ERROR: ${summary}`);
    process.exit(1);
  });
}


export { buildRunnerFailureRecord };
export { buildMergeFollowupComment };
export { extractExecError };
export { isScopeOnlyReviewFeedback };
export { main };
export { normalizeNonEmptyString };
export { publishRunnerFailure };
export { shouldForceApproveAfterRepeatedReviews };
export { shouldIgnoreMissingTaskFinishError };
export { shouldRetryApprovedPrMerge };
