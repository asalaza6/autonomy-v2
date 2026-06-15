import fs from 'fs';
import https from 'https';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { spawnSync } from 'child_process';
import { resolveGithubRepo } from '../../github/github-main.js';
import { ensureDir, getStringOption, printOutput } from './shared-core.js';
import type { CliOptions } from '../autonomy-types.js';

const ENV_FILE_NAME = '.env.autonomy';
const PACKAGE_NAME = '@asalaza6/autonomy-v2';
const GITHUB_API_HOST = 'api.github.com';
const REQUIRED_ENV_DEFAULTS = {
  AUTONOMY_INITIALIZED: '1',
};

type AuthStatus = 'present' | 'missing' | 'updated' | 'skipped';

interface AuthPayload {
  envPath: string;
  tokenTemplateUrl: string;
  statuses: Record<string, AuthStatus>;
  updatedKeys: string[];
  verification: AuthVerification;
}

interface AuthVerification {
  github: Record<string, any>;
  nodeAuth: Record<string, any>;
}

async function run(rootDir: string, options: CliOptions) {
  const envPath = path.join(rootDir, ENV_FILE_NAME);
  if (options.help === true) {
    printAuthHelp();
    return;
  }

  const configuredEnv = readEnvFileValues(envPath);
  const force = options.force === true;
  const updates: Record<string, string> = {};
  const statuses: Record<string, AuthStatus> = {};

  Object.entries(REQUIRED_ENV_DEFAULTS).forEach(([key, value]) => {
    if (force || !hasConfiguredValue(configuredEnv, key)) {
      updates[key] = value;
      statuses[key] = 'updated';
    } else {
      statuses[key] = 'present';
    }
  });

  const nodeAuthToken = getStringOption(options, 'node-auth-token', '');
  if (nodeAuthToken) {
    updates.NODE_AUTH_TOKEN = nodeAuthToken;
    statuses.NODE_AUTH_TOKEN = 'updated';
  } else if (force || !hasConfiguredValue(configuredEnv, 'NODE_AUTH_TOKEN')) {
    const prompted = await promptOptionalSecret('NODE_AUTH_TOKEN for GitHub Packages (blank to skip): ');
    if (prompted) {
      updates.NODE_AUTH_TOKEN = prompted;
      statuses.NODE_AUTH_TOKEN = 'updated';
    } else {
      statuses.NODE_AUTH_TOKEN = hasConfiguredValue(configuredEnv, 'NODE_AUTH_TOKEN') ? 'present' : 'skipped';
    }
  } else {
    statuses.NODE_AUTH_TOKEN = 'present';
  }

  const controlPlaneUrl = getStringOption(options, 'control-plane-url', '');
  if (controlPlaneUrl) {
    updates.AUTONOMY_CONTROL_PLANE_SERVER_URL = controlPlaneUrl;
    statuses.AUTONOMY_CONTROL_PLANE_SERVER_URL = 'updated';
  } else if (force || !hasConfiguredValue(configuredEnv, 'AUTONOMY_CONTROL_PLANE_SERVER_URL')) {
    const prompted = await promptOptionalText('AUTONOMY_CONTROL_PLANE_SERVER_URL (blank to skip): ');
    if (prompted) {
      updates.AUTONOMY_CONTROL_PLANE_SERVER_URL = prompted;
      statuses.AUTONOMY_CONTROL_PLANE_SERVER_URL = 'updated';
    } else {
      statuses.AUTONOMY_CONTROL_PLANE_SERVER_URL = hasConfiguredValue(configuredEnv, 'AUTONOMY_CONTROL_PLANE_SERVER_URL') ? 'present' : 'skipped';
    }
  } else {
    statuses.AUTONOMY_CONTROL_PLANE_SERVER_URL = 'present';
  }

  const tokenTemplateUrl = buildGithubTokenTemplateUrl(rootDir, options);
  const githubToken = getStringOption(options, 'github-token', '');
  if (githubToken) {
    updates.GITHUB_TOKEN = githubToken;
    statuses.GITHUB_TOKEN = 'updated';
  } else if (force || !hasConfiguredValue(configuredEnv, 'GITHUB_TOKEN')) {
    console.log('Create a fine-grained GitHub token with this template URL:');
    console.log(tokenTemplateUrl);
    maybeOpenUrl(tokenTemplateUrl, options);
    const prompted = await promptRequiredSecret('Paste GITHUB_TOKEN, then press Enter: ');
    updates.GITHUB_TOKEN = prompted;
    statuses.GITHUB_TOKEN = 'updated';
  } else {
    statuses.GITHUB_TOKEN = 'present';
  }

  const updatedKeys = Object.keys(updates);
  if (updatedKeys.length > 0) {
    writeEnvUpdates(envPath, updates);
    updatedKeys.forEach((key) => {
      process.env[key] = updates[key];
    });
  }

  const effectiveEnv = {
    ...configuredEnv,
    ...updates,
  };
  const tokenRepo = resolveTokenRepo(rootDir, options);
  const verification = options['skip-verify'] === true
    ? {
      github: { status: 'skipped', reason: 'skip-verify' },
      nodeAuth: { status: 'skipped', reason: 'skip-verify' },
    }
    : {
      github: await verifyGithubTokenForRepo(String(effectiveEnv.GITHUB_TOKEN || ''), tokenRepo),
      nodeAuth: verifyNodeAuthTokenCanAccessPackage(String(effectiveEnv.NODE_AUTH_TOKEN || '')),
    };

  const payload: AuthPayload = {
    envPath,
    tokenTemplateUrl,
    statuses,
    updatedKeys,
    verification,
  };

  printOutput(options, payload, () => {
    console.log(`Env file: ${envPath}`);
    Object.entries(statuses).forEach(([key, status]) => {
      console.log(`${key}: ${status}`);
    });
    if (updatedKeys.length > 0) {
      console.log(`Updated keys: ${updatedKeys.join(', ')}`);
    } else {
      console.log('Updated keys: none');
    }
    console.log('Verification:');
    console.log(`GITHUB_TOKEN: ${verification.github.status}`);
    if (verification.github.repoOnlyStatus) {
      console.log(`GITHUB_TOKEN repo scope: ${verification.github.repoOnlyStatus}`);
    }
    console.log(`NODE_AUTH_TOKEN: ${verification.nodeAuth.status}`);
  });
}

function printAuthHelp() {
  console.log(`
Autonomy v2 auth setup

Usage:
  autonomy-v2 auth [options]

Options:
  --node-auth-token <token>     Write NODE_AUTH_TOKEN without prompting
  --github-token <token>        Write GITHUB_TOKEN without prompting
  --control-plane-url <url>     Write AUTONOMY_CONTROL_PLANE_SERVER_URL without prompting
  --repo <owner/name>           Generate the GitHub token template for this repo
  --owner <owner> --repo <repo> Generate the GitHub token template for this repo
  --expires-in <days|none>      Token template expiration, default 90
  --open                        Open the GitHub token template URL
  --force                       Prompt for and replace existing values
  --skip-verify                 Write/check fields without remote token verification
  --json                        Print structured status without secret values
`);
}

function hasConfiguredValue(env: Record<string, string>, key: string) {
  return String(env[key] || '').trim().length > 0;
}

function readEnvFileValues(envPath: string): Record<string, string> {
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const values: Record<string, string> = {};
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const key = parseEnvLineKey(line);
    if (!key) {
      return;
    }
    values[key] = line.slice(line.indexOf('=') + 1).trim();
  });
  return values;
}

function buildGithubTokenTemplateUrl(rootDir: string, options: CliOptions) {
  const repo = resolveTokenRepo(rootDir, options);
  const expiresIn = getStringOption(options, 'expires-in', '90') || '90';
  const params = new URLSearchParams({
    name: `Autonomy ${repo.repo}`,
    description: `Autonomy repo agent for ${repo.owner}/${repo.repo}`,
    target_name: repo.owner,
    expires_in: expiresIn,
    contents: 'write',
    issues: 'write',
    pull_requests: 'write',
    metadata: 'read',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

async function verifyGithubTokenForRepo(
  token: string,
  repo: { owner: string; repo: string },
  request: typeof githubApiRequest = githubApiRequest,
) {
  if (!token.trim()) {
    return { status: 'skipped', reason: 'missing-token' };
  }

  const targetFullName = `${repo.owner}/${repo.repo}`.toLowerCase();
  const user = await request(token, `/user`);
  if (user.statusCode !== 200) {
    return {
      status: 'invalid',
      reason: statusReason(user.statusCode),
    };
  }

  const repoResult = await request(token, `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`);
  const pullRequests = await request(token, `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=open&per_page=1`);
  const issues = await request(token, `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues?state=open&per_page=1`);
  const repos = await request(token, '/user/repos?per_page=100&type=all&affiliation=owner,collaborator,organization_member');

  const permissions = repoResult.body && typeof repoResult.body === 'object'
    ? (repoResult.body as Record<string, any>).permissions || {}
    : {};
  const repoAccess = repoResult.statusCode === 200;
  const repoWrite = Boolean(permissions.admin || permissions.maintain || permissions.push);
  const pullRequestsReadable = pullRequests.statusCode === 200;
  const issuesReadable = issues.statusCode === 200;
  const repoOnly = classifyRepoOnlyScope(repos, targetFullName);
  const ok = repoAccess && repoWrite && pullRequestsReadable && issuesReadable;

  return {
    status: ok ? 'valid' : 'invalid',
    user: String(user.body && (user.body as Record<string, any>).login || ''),
    repo: `${repo.owner}/${repo.repo}`,
    repoAccess,
    repoWrite,
    pullRequestsReadable,
    issuesReadable,
    repoOnly: repoOnly.repoOnly,
    repoOnlyStatus: repoOnly.status,
    note: 'Write permissions are verified through the repository permissions exposed by GitHub; exact fine-grained permission boundaries are best-effort because GitHub does not expose full PAT policy introspection to token holders.',
  };
}

function verifyNodeAuthTokenCanAccessPackage(
  token: string,
  runner: typeof spawnSync = spawnSync,
) {
  if (!token.trim()) {
    return { status: 'skipped', reason: 'missing-token' };
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-node-auth-'));
  const npmrcPath = path.join(tempDir, '.npmrc');
  fs.writeFileSync(npmrcPath, [
    '@asalaza6:registry=https://npm.pkg.github.com',
    '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}',
    '',
  ].join('\n'), 'utf8');

  try {
    const result = runner('npm', [
      'pack',
      `${PACKAGE_NAME}@latest`,
      '--pack-destination',
      tempDir,
      '--userconfig',
      npmrcPath,
      '--registry',
      'https://npm.pkg.github.com',
      '--silent',
    ], {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_AUTH_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      status: result.status === 0 ? 'valid' : 'invalid',
      packageName: PACKAGE_NAME,
      registry: 'https://npm.pkg.github.com',
      verifiedBy: 'npm pack',
      reason: result.status === 0 ? undefined : sanitizeCommandError(result.stderr || result.stdout || 'npm pack failed'),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function classifyRepoOnlyScope(
  repos: { statusCode: number; body: unknown },
  targetFullName: string,
) {
  if (repos.statusCode !== 200 || !Array.isArray(repos.body)) {
    return {
      repoOnly: null,
      status: 'unknown-repo-list-unavailable',
    };
  }
  const visibleRepos = repos.body
    .map((entry) => String(entry && (entry as Record<string, any>).full_name || '').toLowerCase())
    .filter(Boolean);
  const privateVisibleRepos = repos.body
    .filter((entry) => Boolean(entry && ((entry as Record<string, any>).private || (entry as Record<string, any>).visibility === 'internal')))
    .map((entry) => String((entry as Record<string, any>).full_name || '').toLowerCase())
    .filter(Boolean);
  const scopeList = privateVisibleRepos.length > 0 ? privateVisibleRepos : visibleRepos;
  if (scopeList.length === 1 && scopeList[0] === targetFullName) {
    return {
      repoOnly: true,
      status: 'verified-single-visible-repo',
    };
  }
  if (scopeList.includes(targetFullName)) {
    return {
      repoOnly: false,
      status: 'not-verified-multiple-visible-repos',
    };
  }
  return {
    repoOnly: false,
    status: 'target-repo-not-visible-in-repo-list',
  };
}

function githubApiRequest(token: string, apiPath: string): Promise<{ statusCode: number; headers: Record<string, any>; body: unknown }> {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: GITHUB_API_HOST,
      path: apiPath,
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'autonomy-v2-auth',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode || 0,
          headers: response.headers,
          body: parseJson(raw),
        });
      });
    });
    request.on('error', (error) => {
      resolve({
        statusCode: 0,
        headers: {},
        body: { error: error.message },
      });
    });
    request.end();
  });
}

function parseJson(raw: string) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function statusReason(statusCode: number) {
  if (statusCode === 401) {
    return 'token-rejected';
  }
  if (statusCode === 403) {
    return 'token-forbidden';
  }
  if (statusCode === 404) {
    return 'not-found-or-not-authorized';
  }
  if (statusCode === 0) {
    return 'request-failed';
  }
  return `http-${statusCode}`;
}

function sanitizeCommandError(value: string) {
  return String(value || '')
    .replace(/(npm ERR! code E401|npm ERR! code E403)/g, '$1')
    .split(/\r?\n/)
    .slice(0, 5)
    .join('\n')
    .trim();
}

function resolveTokenRepo(rootDir: string, options: CliOptions) {
  const explicitRepo = getStringOption(options, 'repo', '');
  const explicitOwner = getStringOption(options, 'owner', '');
  if (explicitRepo && explicitOwner) {
    return { owner: explicitOwner, repo: explicitRepo };
  }
  if (explicitRepo && explicitRepo.includes('/')) {
    const [owner, ...repoParts] = explicitRepo.split('/');
    return { owner, repo: repoParts.join('/') };
  }
  try {
    return resolveGithubRepo(rootDir);
  } catch (error) {
    throw new Error(
      'Could not infer GitHub owner/repo from origin. Pass --repo owner/name or --owner <owner> --repo <repo>.'
    );
  }
}

async function promptOptionalText(message: string) {
  if (!input.isTTY) {
    return '';
  }
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

async function promptOptionalSecret(message: string) {
  return promptOptionalText(message);
}

async function promptRequiredSecret(message: string) {
  const value = await promptOptionalSecret(message);
  if (!value) {
    throw new Error('Missing required GITHUB_TOKEN. Re-run with --github-token <token> or paste a token when prompted.');
  }
  return value;
}

function maybeOpenUrl(url: string, options: CliOptions) {
  if (options.open !== true) {
    return;
  }
  try {
    spawnSync('open', [url], { stdio: 'ignore' });
  } catch (_) {
    // Printing the URL above is the reliable fallback.
  }
}

function writeEnvUpdates(envPath: string, updates: Record<string, string>) {
  ensureDir(path.dirname(envPath));
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(updates));
  const seen = new Set<string>();
  const nextLines: string[] = [];

  lines.forEach((line, index) => {
    if (index === lines.length - 1 && line === '') {
      return;
    }
    const key = parseEnvLineKey(line);
    if (key && seen.has(key)) {
      return;
    }
    if (!key || !Object.prototype.hasOwnProperty.call(updates, key)) {
      nextLines.push(line);
      return;
    }
    seen.add(key);
    nextLines.push(`${key}=${remaining.get(key)}`);
    remaining.delete(key);
  });

  remaining.forEach((value, key) => {
    nextLines.push(`${key}=${value}`);
  });

  fs.writeFileSync(envPath, `${nextLines.join('\n')}\n`, 'utf8');
}

function parseEnvLineKey(line: string) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? match[1] : '';
}

export {
  buildGithubTokenTemplateUrl,
  run,
  verifyGithubTokenForRepo,
  verifyNodeAuthTokenCanAccessPackage,
  writeEnvUpdates,
};
