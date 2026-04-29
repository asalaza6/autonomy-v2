#!/usr/bin/env node

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
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

  const repoDescriptor = options.repo || resolveCurrentGithubRepo() || DEFAULT_REPO;
  const [owner, repo] = repoDescriptor.split('/');
  if (!owner || !repo) {
    fail('`--repo` must be in `owner/name` form.');
  }
  const controlPlaneConfig = readControlPlaneConfig();
  const validationPull = resolveValidationPullNumber({
    owner,
    repo,
    explicitPullNumber: options.pr,
    configuredPullNumber: controlPlaneConfig && controlPlaneConfig.repoAssistantValidationPullRequest,
  });

  return {
    ...options,
    repo: repoDescriptor,
    owner,
    repo,
    pr: validationPull.pullRequestNumber,
    pullRequestSource: validationPull.pullRequestSource,
  };
}

function printHelp() {
  console.log(
    [
      'Usage: node scripts/check-repo-assistant-github.js [--repo owner/name] [--pr 27] [--json]',
      '',
      'Checks the same GitHub repo + validation PR access path the control plane uses.',
      `Defaults: detected git origin or ${DEFAULT_REPO}; PR from CLI, control-plane config, env override, or repo default (${DEFAULT_PR})`,
      '',
      'Authentication:',
      'Uses `GITHUB_TOKEN` or `GH_TOKEN` from the current shell environment.',
      'If missing there, falls back to `.env.autonomy.local` and `.env.autonomy`.',
    ].join('\n')
  );
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
      authEnvKey: process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'GH_TOKEN',
      authSource: 'runtime-env',
      loadedFrom: [],
    };
  }

  const { parsed, loadedFrom } = loadApprovedEnvFiles();
  const fileToken = String(parsed.GITHUB_TOKEN || parsed.GH_TOKEN || '').trim();
  if (fileToken) {
    return {
      token: fileToken,
      authEnvKey: parsed.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'GH_TOKEN',
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
      'User-Agent': 'autonomy-v2-repo-assistant-check',
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

  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    text,
    json,
  };
}

function buildGraphqlReviewThreadsQuery() {
  return [
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
}

function summarizeError(response) {
  if (response.json && typeof response.json.message === 'string') {
    return response.json.message;
  }
  return response.text.trim() || `HTTP ${response.status}`;
}

function classifyFailure(stage, response) {
  if (response.status === 401) {
    return 'invalid-token';
  }
  if (stage === 'repository' && (response.status === 403 || response.status === 404)) {
    return 'unauthorized-repo';
  }
  if (stage === 'pull-request' && response.status === 404) {
    return 'stale-validation-pull';
  }
  if (stage.startsWith('pull-request') && response.status === 403) {
    return 'unauthorized-pull';
  }
  if (stage.startsWith('pull-request') && response.status === 404) {
    return 'stale-validation-pull';
  }
  return 'validation-failed';
}

function formatResult(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const lines = [
    `Status: ${result.status}`,
    `Repository: ${result.repository}`,
    `Validation PR: #${result.pullRequestNumber}`,
    `Validation PR source: ${result.pullRequestSource || 'unknown'}`,
    `Auth env key: ${result.authEnvKey || '(none)'}`,
    `Auth source: ${result.authSource || '(unknown)'}`,
  ];

  if (Array.isArray(result.authFiles) && result.authFiles.length > 0) {
    lines.push(`Auth files: ${result.authFiles.join(', ')}`);
  }

  if (result.tokenIdentity) {
    lines.push(`Token identity: ${result.tokenIdentity}`);
  }

  if (result.grantedScopes) {
    lines.push(`Granted scopes: ${result.grantedScopes}`);
  }

  lines.push(`Detail: ${result.detail}`);

  if (result.summary) {
    lines.push(
      `PR summary: ${result.summary.fileCount} files, ${result.summary.topLevelCommentCount} comments, ${result.summary.reviewCount} reviews, ${result.summary.unresolvedReviewThreadCount} unresolved threads`
    );
  }

  if (Array.isArray(result.checkedEndpoints) && result.checkedEndpoints.length > 0) {
    lines.push('Checked endpoints:');
    for (const endpoint of result.checkedEndpoints) {
      lines.push(`- ${endpoint}`);
    }
  }

  console.log(lines.join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.pr) {
    fail(`No validation pull request is configured. Checked CLI args, ${CONTROL_PLANE_CONFIG_PATH}, AUTONOMY_CONTROL_PLANE_GITHUB_VALIDATION_PR, and the repo default.`);
  }
  const tokenConfig = getToken();
  const token = tokenConfig.token;
  const authEnvKey = tokenConfig.authEnvKey;
  const checkedEndpoints = [];

  const viewer = await githubRequest(token, '/user');
  checkedEndpoints.push('GET /user');
  if (!viewer.ok) {
    const status = classifyFailure('user', viewer);
    formatResult({
      status,
      repository: `${options.owner}/${options.repo}`,
      pullRequestNumber: options.pr,
      pullRequestSource: options.pullRequestSource,
      authEnvKey,
      authSource: tokenConfig.authSource,
      authFiles: tokenConfig.loadedFrom,
      detail: `GitHub rejected the token while checking the authenticated user: ${summarizeError(viewer)}.`,
      checkedEndpoints,
    }, options.json);
    process.exit(status === 'invalid-token' ? 1 : 2);
  }

  const repositoryResponse = await githubRequest(token, `/repos/${options.owner}/${options.repo}`);
  checkedEndpoints.push(`GET /repos/${options.owner}/${options.repo}`);
  if (!repositoryResponse.ok) {
    const status = classifyFailure('repository', repositoryResponse);
    formatResult({
      status,
      repository: `${options.owner}/${options.repo}`,
      pullRequestNumber: options.pr,
      pullRequestSource: options.pullRequestSource,
      authEnvKey,
      authSource: tokenConfig.authSource,
      authFiles: tokenConfig.loadedFrom,
      tokenIdentity: viewer.json && viewer.json.login ? viewer.json.login : null,
      grantedScopes: repositoryResponse.headers.get('x-oauth-scopes') || null,
      detail: `Repository validation failed: ${summarizeError(repositoryResponse)}.`,
      checkedEndpoints,
    }, options.json);
    process.exit(2);
  }

  const checks = [
    {
      stage: 'pull-request',
      label: `GET /repos/${options.owner}/${options.repo}/pulls/${options.pr}`,
      pathname: `/repos/${options.owner}/${options.repo}/pulls/${options.pr}`,
    },
    {
      stage: 'pull-request-files',
      label: `GET /repos/${options.owner}/${options.repo}/pulls/${options.pr}/files?per_page=100`,
      pathname: `/repos/${options.owner}/${options.repo}/pulls/${options.pr}/files?per_page=100`,
    },
    {
      stage: 'pull-request-comments',
      label: `GET /repos/${options.owner}/${options.repo}/issues/${options.pr}/comments?per_page=100`,
      pathname: `/repos/${options.owner}/${options.repo}/issues/${options.pr}/comments?per_page=100`,
    },
    {
      stage: 'pull-request-reviews',
      label: `GET /repos/${options.owner}/${options.repo}/pulls/${options.pr}/reviews?per_page=100`,
      pathname: `/repos/${options.owner}/${options.repo}/pulls/${options.pr}/reviews?per_page=100`,
    },
  ];

  const results = {};
  for (const check of checks) {
    const response = await githubRequest(token, check.pathname);
    checkedEndpoints.push(check.label);
    if (!response.ok) {
      const status = classifyFailure(check.stage, response);
      formatResult({
        status,
        repository: `${options.owner}/${options.repo}`,
        pullRequestNumber: options.pr,
        pullRequestSource: options.pullRequestSource,
        authEnvKey,
        authSource: tokenConfig.authSource,
        authFiles: tokenConfig.loadedFrom,
        tokenIdentity: viewer.json && viewer.json.login ? viewer.json.login : null,
        grantedScopes: response.headers.get('x-oauth-scopes') || repositoryResponse.headers.get('x-oauth-scopes') || null,
        detail: `${check.label} failed: ${summarizeError(response)}.`,
        checkedEndpoints,
      }, options.json);
      process.exit(2);
    }
    results[check.stage] = response.json;
  }

  const graphqlResponse = await githubRequest(token, '/graphql', {
    method: 'POST',
    body: {
      query: buildGraphqlReviewThreadsQuery(),
      variables: {
        owner: options.owner,
        repo: options.repo,
        number: options.pr,
      },
    },
  });
  checkedEndpoints.push('POST /graphql reviewThreads');
  if (!graphqlResponse.ok || (graphqlResponse.json && Array.isArray(graphqlResponse.json.errors) && graphqlResponse.json.errors.length > 0)) {
    const status = graphqlResponse.status === 401
      ? 'invalid-token'
      : graphqlResponse.status === 403
        ? 'unauthorized-pull'
        : 'validation-failed';
    const errorMessage = graphqlResponse.json && Array.isArray(graphqlResponse.json.errors) && graphqlResponse.json.errors.length > 0
      ? graphqlResponse.json.errors.map((entry) => entry && entry.message).filter(Boolean).join('; ')
      : summarizeError(graphqlResponse);
    formatResult({
      status,
      repository: `${options.owner}/${options.repo}`,
      pullRequestNumber: options.pr,
      pullRequestSource: options.pullRequestSource,
      authEnvKey,
      authSource: tokenConfig.authSource,
      authFiles: tokenConfig.loadedFrom,
      tokenIdentity: viewer.json && viewer.json.login ? viewer.json.login : null,
      grantedScopes: graphqlResponse.headers.get('x-oauth-scopes') || repositoryResponse.headers.get('x-oauth-scopes') || null,
      detail: `POST /graphql reviewThreads failed: ${errorMessage}.`,
      checkedEndpoints,
    }, options.json);
    process.exit(2);
  }

  const reviewThreads = graphqlResponse.json
    && graphqlResponse.json.data
    && graphqlResponse.json.data.repository
    && graphqlResponse.json.data.repository.pullRequest
    && graphqlResponse.json.data.repository.pullRequest.reviewThreads
    && Array.isArray(graphqlResponse.json.data.repository.pullRequest.reviewThreads.nodes)
    ? graphqlResponse.json.data.repository.pullRequest.reviewThreads.nodes
    : [];
  const unresolvedReviewThreadCount = reviewThreads.filter((thread) => thread && thread.isResolved !== true).length;

  formatResult({
    status: 'enabled',
    repository: `${options.owner}/${options.repo}`,
    pullRequestNumber: options.pr,
    pullRequestSource: options.pullRequestSource,
    authEnvKey,
    authSource: tokenConfig.authSource,
    authFiles: tokenConfig.loadedFrom,
    tokenIdentity: viewer.json && viewer.json.login ? viewer.json.login : null,
    grantedScopes: repositoryResponse.headers.get('x-oauth-scopes') || null,
    detail: `Validated GitHub read access for ${options.owner}/${options.repo}#${options.pr}.`,
    summary: {
      fileCount: Array.isArray(results['pull-request-files']) ? results['pull-request-files'].length : 0,
      topLevelCommentCount: Array.isArray(results['pull-request-comments']) ? results['pull-request-comments'].length : 0,
      reviewCount: Array.isArray(results['pull-request-reviews']) ? results['pull-request-reviews'].length : 0,
      unresolvedReviewThreadCount,
    },
    checkedEndpoints,
  }, options.json);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
