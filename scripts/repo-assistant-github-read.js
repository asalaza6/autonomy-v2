#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const DEFAULT_REPO = 'asalaza6/autonomy-v2';
const DEFAULT_PR = 27;
const API_BASE_URL = 'https://api.github.com';
const APPROVED_ENV_FILES = ['.env.autonomy.local', '.env.autonomy'];
const CONTROL_PLANE_CONFIG_PATH = path.join('prompts', 'autonomous', 'v2', 'config', 'control-plane.json');

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

function truncateText(value, limit) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length <= limit) {
    return normalized || null;
  }
  return `${normalized.slice(0, limit)}...`;
}

function parseArgs(argv) {
  const options = {
    repo: '',
    pr: null,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repo') {
      options.repo = String(argv[index + 1] || '').trim();
      index += 1;
      continue;
    }
    if (arg === '--pr') {
      const parsed = Number(String(argv[index + 1] || '').trim());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        fail('`--pr` must be a positive integer.');
      }
      options.pr = parsed;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }

  const controlPlaneConfig = readControlPlaneConfig();
  const repoDescriptor = options.repo
    || String(controlPlaneConfig && controlPlaneConfig.githubRepository || '').trim()
    || resolveCurrentGithubRepo()
    || DEFAULT_REPO;
  const [owner, repo] = repoDescriptor.split('/');
  if (!owner || !repo) {
    fail('`--repo` must be in `owner/name` form.');
  }
  const validationPull = resolveValidationPullNumber({
    owner,
    repo,
    explicitPullNumber: options.pr,
    configuredPullNumber: controlPlaneConfig && controlPlaneConfig.repoAssistantValidationPullRequest,
  });
  if (!validationPull.pullRequestNumber) {
    fail('No pull request number was provided and no repo validation PR is configured.');
  }

  return {
    owner,
    repo,
    pr: validationPull.pullRequestNumber,
    pullRequestSource: validationPull.pullRequestSource,
    json: options.json,
  };
}

function printHelp() {
  console.log([
    'Usage: node scripts/repo-assistant-github-read.js [--repo owner/name] [--pr 27] [--json]',
    '',
    'Fetches live GitHub pull request data for the repo assistant using the current approved token.',
    'Includes PR metadata, changed files, commits, top-level comments, reviews, and unresolved review threads.',
    '',
    'Authentication:',
    'Uses `GITHUB_TOKEN` or `GH_TOKEN` from the current shell environment.',
    'If missing there, falls back to `.env.autonomy.local` and `.env.autonomy`.',
  ].join('\n'));
}

function parseEnvFile(content) {
  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function loadApprovedEnvFiles() {
  const cwd = process.cwd();
  const loadedFrom = [];
  const parsed = {};

  for (const fileName of APPROVED_ENV_FILES) {
    const filePath = path.join(cwd, fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    loadedFrom.push(fileName);
    const fileValues = parseEnvFile(fs.readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(fileValues)) {
      if (!(key in parsed)) {
        parsed[key] = value;
      }
    }
  }

  return { parsed, loadedFrom };
}

function resolveCurrentGithubRepo() {
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!remote) {
      return '';
    }
    const normalized = remote
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/^https:\/\/github\.com\//, '')
      .replace(/\.git$/, '')
      .trim();
    const [owner, repo] = normalized.split('/');
    return owner && repo ? `${owner}/${repo}` : '';
  } catch {
    return '';
  }
}

function readControlPlaneConfig() {
  const configPath = path.join(process.cwd(), CONTROL_PLANE_CONFIG_PATH);
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function resolvePositiveInteger(value) {
  const parsed = Number(String(value || '').trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveValidationPullNumber({ owner, repo, explicitPullNumber, configuredPullNumber }) {
  const override = resolvePositiveInteger(explicitPullNumber);
  if (override) {
    return {
      pullRequestNumber: override,
      pullRequestSource: 'override',
    };
  }
  const configured = resolvePositiveInteger(configuredPullNumber);
  if (configured) {
    return {
      pullRequestNumber: configured,
      pullRequestSource: 'config',
    };
  }
  const envOverride = resolvePositiveInteger(process.env.AUTONOMY_CONTROL_PLANE_GITHUB_VALIDATION_PR);
  if (envOverride) {
    return {
      pullRequestNumber: envOverride,
      pullRequestSource: 'override',
    };
  }
  if (owner === 'asalaza6' && repo === 'autonomy-v2') {
    return {
      pullRequestNumber: DEFAULT_PR,
      pullRequestSource: 'default',
    };
  }
  return {
    pullRequestNumber: null,
    pullRequestSource: 'unconfigured',
  };
}

function getToken() {
  const runtimeToken = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (runtimeToken) {
    return {
      token: runtimeToken,
      authSource: 'runtime-env',
      loadedFrom: [],
    };
  }

  const { parsed, loadedFrom } = loadApprovedEnvFiles();
  const fileToken = String(parsed.GITHUB_TOKEN || parsed.GH_TOKEN || '').trim();
  if (fileToken) {
    return {
      token: fileToken,
      authSource: 'approved-runtime-secret',
      loadedFrom,
    };
  }

  fail('Missing `GITHUB_TOKEN` or `GH_TOKEN` in the shell environment and approved `.env.autonomy` files.');
}

async function githubRequest(token, pathname, options = {}) {
  const response = await fetch(`${API_BASE_URL}${pathname}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: options.accept || 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'autonomy-v2-repo-assistant-read',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const message = json && typeof json.message === 'string'
      ? json.message
      : text || response.statusText;
    fail(`GitHub API ${response.status}: ${message}`);
  }

  return json;
}

async function readReviewThreads(token, owner, repo, pullNumber) {
  const query = [
    'query($owner:String!,$repo:String!,$number:Int!){',
    '  repository(owner:$owner,name:$repo){',
    '    pullRequest(number:$number){',
    '      reviewThreads(first:100){',
    '        nodes{',
    '          isResolved',
    '          path',
    '          line',
    '          comments(first:20){',
    '            nodes{',
    '              body',
    '              createdAt',
    '              url',
    '              author{login}',
    '            }',
    '          }',
    '        }',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('');
  const result = await githubRequest(token, '/graphql', {
    method: 'POST',
    body: {
      query,
      variables: {
        owner,
        repo,
        number: pullNumber,
      },
    },
  });
  const nodes = result
    && result.data
    && result.data.repository
    && result.data.repository.pullRequest
    && result.data.repository.pullRequest.reviewThreads
    && Array.isArray(result.data.repository.pullRequest.reviewThreads.nodes)
    ? result.data.repository.pullRequest.reviewThreads.nodes
    : [];
  return nodes.map((thread) => ({
    path: String(thread.path || '').trim() || null,
    line: Number(thread.line || 0) || null,
    isResolved: thread.isResolved === true,
    comments: Array.isArray(thread.comments && thread.comments.nodes)
      ? thread.comments.nodes.map((comment) => ({
          author: String(comment.author && comment.author.login || '').trim() || null,
          createdAt: String(comment.createdAt || '').trim() || null,
          url: String(comment.url || '').trim() || null,
          body: truncateText(String(comment.body || '').trim(), 4000),
        }))
      : [],
  }));
}

function summarizeCommit(commit) {
  const detail = commit.commit && typeof commit.commit === 'object' ? commit.commit : {};
  const author = detail.author && typeof detail.author === 'object' ? detail.author : {};
  return {
    sha: String(commit.sha || '').trim() || null,
    url: String(commit.html_url || commit.url || '').trim() || null,
    author: String(commit.author && commit.author.login || author.name || '').trim() || null,
    authoredAt: String(author.date || '').trim() || null,
    message: truncateText(String(detail.message || '').trim(), 4000),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const auth = getToken();
  const { owner, repo, pr } = options;

  const [repositoryMetadata, pullRequest, files, comments, reviews, commits, reviewThreads] = await Promise.all([
    githubRequest(auth.token, `/repos/${owner}/${repo}`),
    githubRequest(auth.token, `/repos/${owner}/${repo}/pulls/${pr}`),
    githubRequest(auth.token, `/repos/${owner}/${repo}/pulls/${pr}/files?per_page=100`),
    githubRequest(auth.token, `/repos/${owner}/${repo}/issues/${pr}/comments?per_page=100`),
    githubRequest(auth.token, `/repos/${owner}/${repo}/pulls/${pr}/reviews?per_page=100`),
    githubRequest(auth.token, `/repos/${owner}/${repo}/pulls/${pr}/commits?per_page=100`),
    readReviewThreads(auth.token, owner, repo, pr),
  ]);

  const unresolvedReviewThreads = Array.isArray(reviewThreads)
    ? reviewThreads.filter((thread) => thread.isResolved !== true)
    : [];
  const payload = {
    authSource: auth.authSource,
    authFiles: auth.loadedFrom,
    repository: {
      owner,
      repo,
      private: repositoryMetadata && repositoryMetadata.private === true,
      visibility: String(repositoryMetadata && repositoryMetadata.visibility || '').trim() || null,
      defaultBranch: String(repositoryMetadata && repositoryMetadata.default_branch || '').trim() || null,
    },
    pullRequest: {
      number: Number(pullRequest && pullRequest.number || pr),
      title: String(pullRequest && pullRequest.title || '').trim(),
      state: String(pullRequest && pullRequest.state || '').trim() || null,
      url: String(pullRequest && (pullRequest.html_url || pullRequest.url) || '').trim() || null,
      author: String(pullRequest && pullRequest.user && pullRequest.user.login || '').trim() || null,
      body: truncateText(String(pullRequest && pullRequest.body || '').trim(), 4000),
      baseRefName: String(pullRequest && pullRequest.base && pullRequest.base.ref || '').trim() || null,
      headRefName: String(pullRequest && pullRequest.head && pullRequest.head.ref || '').trim() || null,
      mergeableState: String(pullRequest && pullRequest.mergeable_state || '').trim() || null,
      summary: {
        fileCount: Array.isArray(files) ? files.length : 0,
        commitCount: Array.isArray(commits) ? commits.length : 0,
        topLevelCommentCount: Array.isArray(comments) ? comments.length : 0,
        reviewCount: Array.isArray(reviews) ? reviews.length : 0,
        unresolvedReviewThreadCount: unresolvedReviewThreads.length,
      },
      files: Array.isArray(files)
        ? files.map((file) => ({
            path: String(file.filename || '').trim(),
            status: String(file.status || '').trim() || null,
            additions: Number(file.additions || 0),
            deletions: Number(file.deletions || 0),
            changes: Number(file.changes || 0),
            patch: truncateText(String(file.patch || '').trim(), 4000),
          }))
        : [],
      commits: Array.isArray(commits) ? commits.map(summarizeCommit) : [],
      topLevelComments: Array.isArray(comments)
        ? comments.map((comment) => ({
            author: String(comment.user && comment.user.login || '').trim() || null,
            url: String(comment.html_url || comment.url || '').trim() || null,
            createdAt: String(comment.created_at || '').trim() || null,
            body: truncateText(String(comment.body || '').trim(), 4000),
          }))
        : [],
      reviews: Array.isArray(reviews)
        ? reviews.map((review) => ({
            author: String(review.user && review.user.login || '').trim() || null,
            state: String(review.state || '').trim() || null,
            submittedAt: String(review.submitted_at || '').trim() || null,
            url: String(review.html_url || review.url || '').trim() || null,
            body: truncateText(String(review.body || '').trim(), 4000),
          }))
        : [],
      unresolvedReviewThreads,
    },
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write([
    `${owner}/${repo} PR #${payload.pullRequest.number}: ${payload.pullRequest.title}`,
    `State: ${payload.pullRequest.state || 'unknown'} | Base: ${payload.pullRequest.baseRefName || 'unknown'} | Head: ${payload.pullRequest.headRefName || 'unknown'}`,
    `Files: ${payload.pullRequest.summary.fileCount} | Commits: ${payload.pullRequest.summary.commitCount} | Comments: ${payload.pullRequest.summary.topLevelCommentCount} | Reviews: ${payload.pullRequest.summary.reviewCount} | Unresolved threads: ${payload.pullRequest.summary.unresolvedReviewThreadCount}`,
    payload.pullRequest.url || '',
  ].filter(Boolean).join('\n') + '\n');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
