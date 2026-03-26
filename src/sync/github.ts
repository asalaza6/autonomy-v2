import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AnyRecord, HttpResponse } from '../types.js';
import { HTTP_REQUEST_TIMEOUT_MS } from './constants.js';
import { readGit } from './git-shared.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveGithubRepo(rootDir: string) {
  const remoteUrl = readGit(rootDir, ['config', '--get', 'remote.origin.url']);

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

  throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
}

function listPullRequestsByHead(repo: AnyRecord, token: string, baseBranch: string, headBranch: string) {
  return githubRequest(
    repo,
    token,
    'GET',
    `/pulls?state=all&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(`${repo.owner}:${headBranch}`)}&per_page=100`
  );
}

function getPullRequest(repo: AnyRecord, token: string, prNumber: number) {
  return githubRequest(repo, token, 'GET', `/pulls/${encodeURIComponent(String(prNumber))}`);
}

function compareBranchToBase(repo: AnyRecord, token: string, baseBranch: string, headBranch: string) {
  try {
    return githubRequest(
      repo,
      token,
      'GET',
      `/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`
    );
  } catch (_) {
    return null;
  }
}

function githubRequest(repo, token, method, endpoint) {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo.owner}/${repo.repo}${endpoint}`,
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'autonomy-v2-sync',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };

  const response = execHttpRequest(options);
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return response.payload;
  }
  throw new Error(`GitHub API ${response.statusCode}: ${response.payload.message || response.raw}`);
}

function execHttpRequest(options: AnyRecord): HttpResponse {
  const result: HttpResponse = {
    statusCode: 0,
    payload: {},
    raw: '',
  };

  const response = execFileSync(process.execPath, ['-e', buildHttpClientScript()], {
    cwd: __dirname,
    env: {
      ...process.env,
      AUTONOMY_HTTP_OPTIONS: JSON.stringify(options),
      AUTONOMY_HTTP_BODY: '',
      AUTONOMY_HTTP_TIMEOUT_MS: String(HTTP_REQUEST_TIMEOUT_MS),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: HTTP_REQUEST_TIMEOUT_MS + 2000,
  }).trim();

  if (response) {
    const parsed = JSON.parse(response) as AnyRecord;
    result.statusCode = parsed.statusCode;
    result.payload = parsed.payload;
    result.raw = parsed.raw;
  }
  return result;
}

function buildHttpClientScript() {
  return `
import https from 'https';
const options = JSON.parse(process.env.AUTONOMY_HTTP_OPTIONS) as AnyRecord;
const timeoutMs = Number(process.env.AUTONOMY_HTTP_TIMEOUT_MS || '15000');
const req = https.request(options, (res) => {
  let raw = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => {
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) as AnyRecord : {};
    } catch (_) {}
    process.stdout.write(JSON.stringify({ statusCode: res.statusCode, payload, raw }));
  });
});
req.on('error', (error) => {
  process.stderr.write(error.message);
  process.exit(1);
});
req.setTimeout(timeoutMs, () => {
  req.destroy(new Error(\`HTTP request timed out after \${timeoutMs}ms\`));
});
req.end();
`;
}

export {
  compareBranchToBase,
  getPullRequest,
  listPullRequestsByHead,
  resolveGithubRepo,
};
