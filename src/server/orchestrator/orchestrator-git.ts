import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AnyRecord, AutonomyConfig } from '../server-types.js';
import { readJson } from './paths.js';
import { buildTaskQueueState, getAgent } from './helpers.js';

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

function readJsonFromGitRef(rootDir, ref, relativePath, fallbackValue) {
  if (!ref || path.isAbsolute(relativePath)) {
    return fallbackValue;
  }
  try {
    return JSON.parse(execFileSync('git', [
      'show',
      `${ref}:${relativePath.replace(/\\/g, '/')}`,
    ], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (_) {
    return fallbackValue;
  }
}

function readImplementationQueueFromGitRef(rootDir, config, agentId, ref, fallbackValue = null) {
  if (!ref) {
    return fallbackValue;
  }
  const agent = getAgent(config, agentId);
  const queueState = readJsonFromGitRef(rootDir, ref, agent.taskQueue, fallbackValue);
  if (!queueState) {
    return fallbackValue;
  }
  return buildTaskQueueState(agent, Array.isArray(queueState.tasks) ? queueState.tasks : []);
}

function readImplementationQueueFromWorktree(config, agentId, worktreePath) {
  const agent = getAgent(config, agentId);
  const relativePath = agent.taskQueue;
  const queuePath = path.isAbsolute(relativePath)
    ? relativePath
    : path.join(worktreePath, relativePath);
  if (!fs.existsSync(queuePath)) {
    return null;
  }
  try {
    const queueState = readJson(queuePath, buildTaskQueueState(agent, []));
    return buildTaskQueueState(agent, Array.isArray(queueState.tasks) ? queueState.tasks : []);
  } catch (_) {
    return null;
  }
}

function readImplementationQueueSnapshot(rootDir: string, config: AutonomyConfig, agentId: string, options: AnyRecord = {}) {
  if (options.worktreePath && fs.existsSync(options.worktreePath)) {
    const queueFromWorktree = readImplementationQueueFromWorktree(config, agentId, options.worktreePath);
    if (queueFromWorktree) {
      return queueFromWorktree;
    }
  }
  const queueFromBranch = options.branch && gitRefExists(rootDir, options.branch)
    ? readImplementationQueueFromGitRef(rootDir, config, agentId, options.branch, null)
    : null;
  if (queueFromBranch) {
    return queueFromBranch;
  }
  return null;
}

export {
  gitRefExists,
  readImplementationQueueSnapshot,
};
