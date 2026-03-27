import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { AGENT_ROLES, getRoleAgentLabel, getRoleLabel } from '../../agents/role-catalog.js';
import type { AnyRecord } from '../autonomy-types.js';
import { slugify } from './shared-core.js';

function buildReviewFollowupAcceptance(pr, description, existingAcceptance = []) {
  const explicitAcceptance = uniqueStrings(existingAcceptance || []);
  const prAcceptance = uniqueStrings((pr && pr.acceptance) || []);
  if (explicitAcceptance.length > 0 && !stringListsEqual(explicitAcceptance, prAcceptance)) {
    return explicitAcceptance;
  }
  const summary = String(description || '').trim();
  return [summary || `Address reviewer feedback for ${pr && pr.title ? pr.title : 'this PR'}`];
}

function stringListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function findPullRequestByLane(prState, task) {
  const laneKey = buildTaskLaneKey(task);
  return (prState.pullRequests || []).find((candidate) => {
    return candidate.agentId === task.agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function findBranchLockByLane(branchLocksState, agentId, laneKey) {
  return (branchLocksState.locks || []).find((candidate) => {
    return candidate.agentId === agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function collectTaskScopeViolations(task) {
  return (task && Array.isArray(task.scopeViolations) ? task.scopeViolations : []).map((entry) => ({
    taskId: task.id,
    file: String(entry && entry.file || '').trim(),
    reason: String(entry && entry.reason || '').trim(),
  })).filter((entry) => entry.file && entry.reason);
}

function uniqueScopeViolations(values) {
  const seen = new Set();
  const output = [];
  (values || []).forEach((value) => {
    const taskId = String(value && value.taskId || '').trim();
    const file = String(value && value.file || '').trim();
    const reason = String(value && value.reason || '').trim();
    const key = `${taskId}::${file}::${reason}`;
    if (!taskId || !file || !reason || seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push({ taskId, file, reason });
  });
  return output;
}

function buildLaneSourceSummary(task, completedLaneTasks, pendingLaneTasks) {
  const laneTasks = uniqueTasksById([
    ...completedLaneTasks,
    task,
    ...pendingLaneTasks,
  ]);
  if (laneTasks.length <= 1) {
    return {
      title: task.title,
      body: task.description || '',
    };
  }

  return {
    title: `${task.agentId.replace(/-agent$/, '')} lane work for ${task.prdId || task.id}`,
    body: `Lane task ids: ${laneTasks.map((candidate) => candidate.id).join(', ')}`,
  };
}

function uniqueTasksById(tasks) {
  const seen = new Set();
  return (tasks || []).filter((task) => {
    const id = String(task && task.id || '');
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function buildStablePullRequestId(laneKey) {
  return `pr-${slugify(laneKey || 'lane')}`;
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

function buildTaskBranchName(config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const agentSegment = slugify(task.agentId);
  const laneSegment = slugify(buildTaskLaneKey(task));
  return `${config.branchPrefixes.task}/${sprintSegment}/${agentSegment}/${laneSegment}`;
}

function buildWorktreePath(rootDir, config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const laneSegment = slugify(buildTaskLaneKey(task));
  return path.join(rootDir, config.worktreesRoot, task.agentId, `${sprintSegment}-${laneSegment}`);
}

function resolveBaseRef(rootDir, branchName) {
  const remoteRef = `origin/${branchName}`;
  if (gitRefExists(rootDir, remoteRef)) {
    return remoteRef;
  }
  if (gitRefExists(rootDir, branchName)) {
    return branchName;
  }
  throw new Error(`Base branch "${branchName}" does not exist locally or on origin.`);
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

function runGit(rootDir, args) {
  execFileSync('git', args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGitWorktreeAdd(rootDir: string, args: string[], worktreePath: string, options: AnyRecord = {}) {
  const runner = options.quiet === true ? runGitQuiet : runGit;
  try {
    runner(rootDir, ['worktree', 'add', ...args]);
  } catch (error) {
    const message = extractExecError(error);
    if (!fs.existsSync(worktreePath) && message.includes('missing but already registered worktree')) {
      pruneStaleWorktrees(rootDir);
      runner(rootDir, ['worktree', 'add', ...args]);
      return;
    }
    throw error;
  }
}

function pruneStaleWorktrees(rootDir) {
  try {
    runGitQuiet(rootDir, ['worktree', 'prune', '--expire', 'now']);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function upsertBranchLock(branchLocksState, nextLock) {
  const currentIndex = branchLocksState.locks.findIndex((lock) => {
    if (nextLock.laneKey && lock.laneKey) {
      return lock.laneKey === nextLock.laneKey && lock.agentId === nextLock.agentId;
    }
    return lock.taskId === nextLock.taskId;
  });
  if (currentIndex >= 0) {
    branchLocksState.locks[currentIndex] = {
      ...branchLocksState.locks[currentIndex],
      ...nextLock,
    };
    return;
  }
  branchLocksState.locks.push(nextLock);
}

function runGitQuiet(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGitRead(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasStagedGitChanges(cwd) {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], {
      cwd,
      stdio: 'ignore',
    });
    return false;
  } catch (_) {
    return true;
  }
}

function extractExecError(error) {
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return error.message;
}

function normalizeReviewDecision(decision) {
  if (decision === 'approve' || decision === 'approved') {
    return 'approved';
  }
  if (decision === 'changes-requested' || decision === 'changes_requested') {
    return 'changes_requested';
  }
  throw new Error(`Unsupported ${getRoleLabel(AGENT_ROLES.REVIEW)} decision "${decision}". Use approve or changes-requested.`);
}

function evaluateMerge({ config, pr, actor }) {
  const reasons = [];
  const mergeActors = config.mergeActors || [];
  if (mergeActors.length > 0) {
    if (!mergeActors.includes(actor.id)) {
      reasons.push(`actor ${actor.id} is not allowed to merge`);
    }
  } else if (actor.role !== 'merge') {
    reasons.push(`actor ${actor.id} is not a merge agent`);
  }
  if (pr.baseBranch !== config.integrationBranch) {
    reasons.push(`PR base branch must be ${config.integrationBranch}, received ${pr.baseBranch}`);
  }
  if ((config.blockedBranches || []).includes(pr.baseBranch)) {
    reasons.push(`PR base branch ${pr.baseBranch} is blocked`);
  }
  if (pr.status !== 'approved') {
    reasons.push(`PR status must be approved before merge, received ${pr.status}`);
  }
  if (!pr.reviews || pr.reviews.length === 0) {
    reasons.push(`PR has no recorded ${getRoleLabel(AGENT_ROLES.REVIEW)}`);
  } else {
    const latestDecision = pr.reviews[pr.reviews.length - 1].decision;
    if (latestDecision !== 'approved') {
      reasons.push(`latest ${getRoleLabel(AGENT_ROLES.REVIEW)} decision is ${latestDecision}`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    mergeStrategy: config.mergeStrategy || 'merge',
    integrationBranch: config.integrationBranch,
  };
}

export {
  buildLaneSourceSummary,
  buildReviewFollowupAcceptance,
  buildStablePullRequestId,
  buildTaskBranchName,
  buildTaskLaneKey,
  buildWorktreePath,
  collectTaskScopeViolations,
  evaluateMerge,
  extractExecError,
  findBranchLockByLane,
  findPullRequestByLane,
  gitRefExists,
  hasStagedGitChanges,
  isGitWorktree,
  normalizeReviewDecision,
  resolveBaseRef,
  runGit,
  runGitQuiet,
  runGitRead,
  runGitWorktreeAdd,
  uniqueScopeViolations,
  uniqueStrings,
  upsertBranchLock,
};
