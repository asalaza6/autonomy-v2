import https from 'https';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import type { AnyRecord } from '../autonomy-types.js';
import { buildMergeCommitTitle, ensureDir, slugify } from './shared-core.js';
import { extractExecError, gitRefExists, resolveBaseRef, runGitQuiet, runGitRead, runGitWorktreeAdd } from './shared-repo.js';
import { gitAuthArgs, gitIsAncestor, gitRemoteExists, gitWorkingTreeClean } from '../../sync/git-shared.js';

function resolveGithubRepo(rootDir) {
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).trim();

  const parsed = parseGithubRemoteUrl(remoteUrl);
  if (parsed) {
    return parsed;
  }

  throw new Error(`Could not parse GitHub repo from remote URL: ${remoteUrl}`);
}

function parseGithubRemoteUrl(remoteUrl) {
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
  } catch (_) {
    // Fall back to regex parsing for non-URL formats.
  }

  const httpsMatch = remoteUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
    };
  }
  return null;
}

function publishPullRequest(repo, token, payload) {
  return githubRequest(repo, token, 'POST', '/pulls', payload);
}

async function createOrFindPullRequest(repo, token, payload) {
  try {
    return await publishPullRequest(repo, token, payload);
  } catch (error) {
    if (!isGithubValidationError(error)) {
      throw error;
    }
    const existing = await findPullRequestByHead(repo, token, payload.base, payload.head);
    if (existing) {
      return existing;
    }
    throw error;
  }
}

function publishReview(repo, token, pullNumber, decisionRecord) {
  const event = decisionRecord.decision === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
  return githubRequest(repo, token, 'POST', `/pulls/${pullNumber}/reviews`, {
    body: decisionRecord.publishedSummary || decisionRecord.summary || '',
    event,
  });
}

function mergePullRequest(repo, token, pullNumber, payload) {
  return githubRequest(repo, token, 'PUT', `/pulls/${pullNumber}/merge`, payload);
}

function addIssueLabels(repo, token, issueNumber, labels) {
  return githubRequest(repo, token, 'POST', `/issues/${issueNumber}/labels`, { labels });
}

function addIssueComment(repo, token, issueNumber, body) {
  return githubRequest(repo, token, 'POST', `/issues/${issueNumber}/comments`, { body });
}

async function findPullRequestByHead(repo, token, baseBranch, headBranch) {
  const pulls = await githubRequest(
    repo,
    token,
    'GET',
    `/pulls?state=all&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(`${repo.owner}:${headBranch}`)}`,
    null
  );
  if (!Array.isArray(pulls) || pulls.length === 0) {
    return null;
  }
  return pulls[0];
}

function performLocalMerge(rootDir, config, pr, actor) {
  const mergeRunDir = path.join(rootDir, '.autonomy', 'merge-runs');
  const mergePath = path.join(mergeRunDir, slugify(pr.id));
  const tempBranch = `merge-run-${slugify(pr.id)}`;
  const rootBranch = getCheckedOutBranch(rootDir);
  const syncRootWorktree = rootBranch === pr.baseBranch && isTrackedWorktreeClean(rootDir);
  ensureDir(mergeRunDir);
  cleanupWorktree(rootDir, mergePath);
  deleteLocalBranch(rootDir, tempBranch);

  try {
    const baseRef = resolveBaseRef(rootDir, pr.baseBranch);
    runGitWorktreeAdd(rootDir, ['--detach', mergePath, baseRef], mergePath, { quiet: true });
    runGitQuiet(mergePath, ['switch', '-c', tempBranch]);

    const strategy = config.mergeStrategy || 'merge';
    if (strategy === 'squash') {
      runGitQuiet(mergePath, ['merge', '--squash', pr.headBranch]);
      runGitQuiet(mergePath, ['commit', '-m', buildMergeCommitTitle(actor, pr)]);
    } else {
      runGitQuiet(mergePath, ['merge', '--no-ff', '--no-edit', pr.headBranch]);
    }

    const sha = runGitRead(mergePath, ['rev-parse', 'HEAD']).trim();
    runGitQuiet(rootDir, ['update-ref', `refs/heads/${pr.baseBranch}`, sha]);
    if (syncRootWorktree) {
      syncCheckedOutBranchWorktree(rootDir);
    }
    cleanupWorktree(rootDir, mergePath);
    deleteLocalBranch(rootDir, tempBranch);
    return { ok: true, sha };
  } catch (error) {
    cleanupWorktree(rootDir, mergePath);
    deleteLocalBranch(rootDir, tempBranch);
    return { ok: false, message: extractExecError(error) };
  }
}

function performLocalDeploy(rootDir, config) {
  const sourceBranch = String(config.integrationBranch || 'dev').trim() || 'dev';
  const targetBranch = String(config.productionBranch || 'main').trim() || 'main';
  if (sourceBranch === targetBranch) {
    return {
      ok: false,
      message: `Deploy source branch and target branch must differ. Received ${sourceBranch}.`,
    };
  }

  if (!gitWorkingTreeClean(rootDir)) {
    return {
      ok: false,
      message: 'Working tree must be clean before deploy.',
    };
  }
  const rootBranch = getCheckedOutBranch(rootDir);
  const syncRootWorktree = rootBranch === targetBranch && isTrackedWorktreeClean(rootDir);

  try {
    const targetRef = gitRefExists(rootDir, targetBranch) ? targetBranch : resolveBaseRef(rootDir, targetBranch);
    const sourceRef = gitRefExists(rootDir, sourceBranch) ? sourceBranch : resolveBaseRef(rootDir, sourceBranch);
    if (!gitIsAncestor(rootDir, targetRef, sourceRef)) {
      return {
        ok: false,
        message: `Cannot fast-forward deploy ${sourceBranch} to ${targetBranch}: ${targetBranch} has commits that are not in ${sourceBranch}.`,
      };
    }

    const sha = runGitRead(rootDir, ['rev-parse', sourceRef]).trim();
    runGitQuiet(rootDir, ['update-ref', `refs/heads/${targetBranch}`, sha]);
    if (syncRootWorktree) {
      syncCheckedOutBranchWorktree(rootDir);
    }

    let pushed = false;
    let pushMessage = 'origin remote not configured; committed locally only';
    if (gitRemoteExists(rootDir, 'origin')) {
      try {
        runGitQuiet(rootDir, gitAuthArgs().concat(['push', 'origin', targetBranch]));
        pushed = true;
        pushMessage = `pushed to origin/${targetBranch}`;
      } catch (error) {
        pushMessage = extractExecError(error);
        throw new Error(`Failed to push deploy to origin/${targetBranch}: ${pushMessage}`);
      }
    }
    return {
      ok: true,
      sha,
      sourceBranch,
      targetBranch,
      pushed,
      pushMessage,
    };
  } catch (error) {
    return { ok: false, message: extractExecError(error) };
  }
}

function cleanupWorktree(rootDir, worktreePath) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: rootDir,
      stdio: 'ignore',
    });
  } catch (_) {
    // Ignore; the path may not be a registered worktree yet.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function deleteLocalBranch(rootDir, branchName) {
  try {
    execFileSync('git', ['branch', '-D', branchName], {
      cwd: rootDir,
      stdio: 'ignore',
    });
  } catch (_) {
    // Ignore; the branch may not exist yet.
  }
}

function getCheckedOutBranch(rootDir) {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (_) {
    return null;
  }
}

function isTrackedWorktreeClean(rootDir) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() === '';
}

function syncCheckedOutBranchWorktree(rootDir) {
  execFileSync('git', ['reset', '--hard', 'HEAD'], {
    cwd: rootDir,
    stdio: 'ignore',
  });
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
      'User-Agent': 'autonomy-v2',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };

  if (body) {
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise<any>((resolve, reject) => {
    const request = https.request(options, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        const parsed: AnyRecord = raw ? JSON.parse(raw) : {};
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(parsed);
          return;
        }
        const error = new Error(`GitHub API ${response.statusCode}: ${parsed.message || raw}`);
        error.statusCode = response.statusCode;
        error.payload = parsed;
        reject(error);
      });
    });

    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function isGithubValidationError(error) {
  return Boolean(error && error.statusCode === 422);
}

function isSelfPullRequestReviewError(error) {
  if (!error) {
    return false;
  }
  const payloadErrors = Array.isArray(error.payload && error.payload.errors)
    ? error.payload.errors
    : [];
  return payloadErrors.some((entry) => String(entry || '').toLowerCase().includes('own pull request'));
}

export {
  addIssueComment,
  addIssueLabels,
  createOrFindPullRequest,
  isSelfPullRequestReviewError,
  mergePullRequest,
  performLocalDeploy,
  performLocalMerge,
  publishReview,
  resolveGithubRepo,
};
