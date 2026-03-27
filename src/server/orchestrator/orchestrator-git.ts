import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AnyRecord, AutonomyConfig } from '../server-types.js';
import { readJson } from './paths.js';
import { buildTaskQueueState, getAgent, normalizeNonEmptyString } from './helpers.js';

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

function resolveTrackedQueueRef(rootDir, integrationBranch) {
  const remoteRef = `origin/${integrationBranch}`;
  if (gitRefExists(rootDir, remoteRef)) {
    return remoteRef;
  }
  if (gitRefExists(rootDir, integrationBranch)) {
    return integrationBranch;
  }
  return null;
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

function runGit(cwd, args) {
  execFileSync('git', args, {
    cwd,
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
  const queueFromBranch = options.branch && gitRefExists(rootDir, options.branch)
    ? readImplementationQueueFromGitRef(rootDir, config, agentId, options.branch, null)
    : null;
  if (queueFromBranch) {
    return queueFromBranch;
  }
  if (options.worktreePath && fs.existsSync(options.worktreePath)) {
    return readImplementationQueueFromWorktree(config, agentId, options.worktreePath);
  }
  return null;
}

function extractExecError(error) {
  const runnerSummary = normalizeNonEmptyString(error && error.autonomyErrorReport && error.autonomyErrorReport.summary);
  if (runnerSummary) {
    return runnerSummary;
  }
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return normalizeNonEmptyString(error && error.message) || 'Command failed without stderr/stdout output.';
}

function readRunnerErrorReport(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function executeRunnerCommand(command, env) {
  const [binary, ...args] = command;
  const streamOutput = (env && env.AUTONOMY_STREAM_WORKER_OUTPUT === '1')
    || process.env.AUTONOMY_STREAM_WORKER_OUTPUT === '1';
  const errorReportPath = normalizeNonEmptyString(env && env.AUTONOMY_ERROR_REPORT);
  if (errorReportPath && fs.existsSync(errorReportPath)) {
    fs.rmSync(errorReportPath, { force: true });
  }
  try {
    execFileSync(binary, args, {
      cwd: (env && env.AUTONOMY_ROOT) || process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: streamOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    return {
      command,
      status: 'executed',
    };
  } catch (error) {
    const runnerErrorReport = readRunnerErrorReport(errorReportPath);
    if (runnerErrorReport) {
      error.autonomyErrorReport = runnerErrorReport;
    }
    throw error;
  }
}

export {
  executeRunnerCommand,
  extractExecError,
  gitRefExists,
  hasStagedGitChanges,
  readImplementationQueueSnapshot,
  readJsonFromGitRef,
  resolveTrackedQueueRef,
  runGit,
};
