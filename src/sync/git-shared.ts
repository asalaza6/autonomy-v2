import fs from 'fs';
import { execFileSync } from 'child_process';
import { resolveGithubAuthToken } from '../github/github-main.js';
import type { AnyRecord } from './sync-types.js';

function gitHasStagedChanges(cwd) {
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

function gitRemoteExists(rootDir, remoteName) {
  try {
    execFileSync('git', ['remote', 'get-url', remoteName], {
      cwd: rootDir,
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

function gitIsAncestor(rootDir, olderRef, newerRef) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', olderRef, newerRef], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function gitWorkingTreeClean(rootDir) {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().length === 0;
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

function extractExecError(error) {
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return error.message;
}

function runGit(rootDir: string, args: string[], options: AnyRecord = {}) {
  const execOptions: any = {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (options.timeoutMs) {
    execOptions.timeout = Number(options.timeoutMs);
  }
  execFileSync('git', args, execOptions);
}

function runGitWorktreeAdd(rootDir, args, worktreePath, options = {}) {
  try {
    runGit(rootDir, ['worktree', 'add', ...args], options);
  } catch (error) {
    const message = extractExecError(error);
    if (!fs.existsSync(worktreePath) && message.includes('missing but already registered worktree')) {
      pruneStaleWorktrees(rootDir);
      runGit(rootDir, ['worktree', 'add', ...args], options);
      return;
    }
    throw error;
  }
}

function pruneStaleWorktrees(rootDir) {
  try {
    runGit(rootDir, ['worktree', 'prune', '--expire', 'now']);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function readGit(rootDir: string, args: string[], options: AnyRecord = {}) {
  const execOptions: any = {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (options.timeoutMs) {
    execOptions.timeout = Number(options.timeoutMs);
  }
  return execFileSync('git', args, execOptions).trim();
}

function listTreeFiles(rootDir, ref, prefix) {
  try {
    const output = readGit(rootDir, ['ls-tree', '-r', '--name-only', ref, '--', prefix]);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readTreeFile(rootDir, ref, relativePath) {
  return execFileSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readJsonFromGitRef(rootDir, ref, relativePath, fallbackValue) {
  if (!ref) {
    return fallbackValue;
  }
  try {
    return JSON.parse(readGit(rootDir, [
      'show',
      `${ref}:${String(relativePath).replace(/\\/g, '/')}`,
    ]));
  } catch (_) {
    return fallbackValue;
  }
}

function configureGitIdentity(cwd, gitIdentity) {
  if (!gitIdentity) {
    return;
  }
  runGit(cwd, ['config', 'extensions.worktreeConfig', 'true']);
  if (gitIdentity.name) {
    runGit(cwd, ['config', '--worktree', 'user.name', gitIdentity.name]);
  }
  if (gitIdentity.email) {
    runGit(cwd, ['config', '--worktree', 'user.email', gitIdentity.email]);
  }
}

function gitAuthArgs() {
  const githubToken = resolveGithubAuthToken();
  if (!githubToken) {
    return [];
  }
  const authHeader = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  return ['-c', `http.extraHeader=AUTHORIZATION: basic ${authHeader}`];
}

export {
  configureGitIdentity,
  extractExecError,
  gitAuthArgs,
  gitHasStagedChanges,
  gitIsAncestor,
  gitRefExists,
  gitRemoteExists,
  gitWorkingTreeClean,
  isGitWorktree,
  listTreeFiles,
  pruneStaleWorktrees,
  readGit,
  readJsonFromGitRef,
  readTreeFile,
  runGit,
  runGitWorktreeAdd,
};
