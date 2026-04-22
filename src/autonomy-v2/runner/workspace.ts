import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { resolveGithubAuthToken } from '../../github/github-main.js';
import { AGENT_ROLES } from '../../agents/role-catalog.js';
import { getAgentConversationId, setAgentConversationReference } from '../../agents/conversation-references.js';
import { classifyMergeFailureMessage } from '../commands/merge-watchdog.js';
import { CLI_PATH, RUNTIME_SEGMENTS } from './runner-constants.js';
import {
  buildTaskQueueState,
  getAgentConfig,
  getImplementationTaskState,
} from './runner-state.js';
import { ensureDir, extractExecError, readJson, sleepMs, slugify, writeJson } from './runner-shared.js';

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
  if (!shouldRecordPr) {
    return;
  }
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
  const implementationConversationId = getImplementationConversationId(task, agent.id);
  if (implementationConversationId) {
    setAgentConversationReference(currentTask, {
      agentId: agent.id,
      role: AGENT_ROLES.IMPLEMENTATION,
    }, implementationConversationId, now);
  }
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
  return { queuePath, relativePath };
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
    return { queuePath, relativePath, changed: false };
  }
  currentTask.commitSha = commitSha;
  currentTask.updatedAt = new Date().toISOString();
  writeJson(queuePath, buildTaskQueueState(agent, tasks));
  return { queuePath, relativePath, changed: true };
}

function getImplementationConversationId(task, agentId = '') {
  return getAgentConversationId(task, {
    agentId: agentId || task && task.agentId,
    role: AGENT_ROLES.IMPLEMENTATION,
  });
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
  return Array.from(new Set([
    ...tracked.split('\n').filter(Boolean),
    ...untracked.split('\n').filter(Boolean),
  ]));
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
  const currentBranch = readGit(rootDir, ['branch', '--show-current']);
  if (currentBranch === baseBranch) {
    if (!isTrackedWorktreeClean(rootDir)) {
      return;
    }
    try {
      runGit(rootDir, ['merge', '--ff-only', `origin/${baseBranch}`]);
    } catch (_) {
      // Best-effort only. The gate context can still use origin/<baseBranch>.
    }
    return;
  }
  execFileSync('git', ['update-ref', `refs/heads/${baseBranch}`, remoteRef], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function isTrackedWorktreeClean(rootDir) {
  return readGit(rootDir, ['status', '--porcelain', '--untracked-files=no']) === '';
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
      return { merged: true, message: 'merged' };
    } catch (error) {
      lastMessage = extractExecError(error);
      if (!/not mergeable|merge already in progress/i.test(lastMessage) || attempt === 3) {
        break;
      }
      sleepMs(1000);
    }
  }

  return { merged: false, message: lastMessage, code: classifyMergeFailureMessage(lastMessage) };
}

export {
  buildCommitMessage,
  buildQueueMetadataCommitMessage,
  ensureReviewContext,
  finalizeTaskRun,
  listBranchCommits,
  listChangedFiles,
  listReviewDiffFiles,
  markImplementationTaskComplete,
  readGit,
  recordImplementationTaskCommitSha,
  resolveTargetFile,
  runGit,
  tryMergeWithRetry,
  tryPushBranch,
};
