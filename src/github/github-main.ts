import { execFileSync } from 'child_process';
import type { AnyRecord } from '../types.js';

function resolveGithubRepo(rootDir: string) {
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const parsed = parseGithubRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new Error(`Could not parse GitHub repo from remote URL: ${remoteUrl}`);
  }
  return parsed;
}

function parseGithubRemoteUrl(remoteUrl: string) {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  try {
    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.hostname === 'github.com') {
      const trimmedPath = parsedUrl.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
      const segments = trimmedPath.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return { owner: segments[0], repo: segments.slice(1).join('/') };
      }
    }
  } catch (_) {
    // Fall through to regex parsing.
  }
  const httpsMatch = remoteUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  return httpsMatch ? { owner: httpsMatch[1], repo: httpsMatch[2] } : null;
}

function githubRequest(repo: AnyRecord, token: string, endpoint: string) {
  const output = execFileSync('gh', [
    'api',
    `repos/${repo.owner}/${repo.repo}${endpoint}`,
    '-H',
    'Accept: application/vnd.github+json',
    '-H',
    'X-GitHub-Api-Version: 2022-11-28',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
    },
  }).trim();
  return output ? JSON.parse(output) : null;
}

function listPullRequestsByHead(repo: AnyRecord, token: string, baseBranch: string, headBranch: string) {
  const encodedHead = encodeURIComponent(`${repo.owner}:${headBranch}`);
  const encodedBase = encodeURIComponent(baseBranch);
  const result = githubRequest(repo, token, `/pulls?state=all&base=${encodedBase}&head=${encodedHead}`);
  return Array.isArray(result) ? result : [];
}

function getPullRequest(repo: AnyRecord, token: string, pullNumber: number) {
  return githubRequest(repo, token, `/pulls/${pullNumber}`);
}

function compareBranchToBase(repo: AnyRecord, token: string, baseBranch: string, headBranch: string) {
  try {
    return githubRequest(repo, token, `/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`);
  } catch (_) {
    return null;
  }
}

function resolveGithubAuthToken(options: AnyRecord = {}) {
  const envToken = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }

  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (token) {
      return token;
    }
  } catch (_) {
    // Ignore; gh may be unavailable or not logged in.
  }

  if (options.required) {
    throw new Error('GitHub auth is required. Set GITHUB_TOKEN/GH_TOKEN or run "gh auth login".');
  }
  return '';
}

export { compareBranchToBase };
export { getPullRequest };
export { listPullRequestsByHead };
export { resolveGithubAuthToken };
export { resolveGithubRepo };
