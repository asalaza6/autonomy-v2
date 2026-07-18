import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { CliOptions } from '../types.js';
import { ensureDir } from '../runtime.js';

const ENV_FILE_NAME = '.env.autonomy';
const PACKAGE_NAME = '@asalaza6/autonomy-v2';
const GITHUB_API_HOST = 'api.github.com';
const GITHUB_REGISTRY = 'https://npm.pkg.github.com';
const REQUEST_TIMEOUT_MS = 15_000;

type AuthFieldStatus = 'present' | 'updated' | 'skipped';

type GithubRepo = {
  owner: string;
  repo: string;
  fullName: string;
  source: 'option' | 'origin';
};

type VerificationResult = Record<string, unknown> & {
  status: 'valid' | 'invalid' | 'skipped';
};

type AuthPayload = {
  envPath: string;
  repo: GithubRepo;
  tokenTemplateUrl: string;
  statuses: Record<string, AuthFieldStatus>;
  updatedKeys: string[];
  verification: {
    github: VerificationResult;
    nodeAuth: VerificationResult;
  };
};

type GithubResponse = {
  statusCode: number;
  body: unknown;
};

async function runAuth(rootDir: string, options: CliOptions = {}): Promise<AuthPayload> {
  const envPath = path.join(rootDir, ENV_FILE_NAME);
  const configuredEnv = readEnvFileValues(envPath);
  const interactive = options.json !== true;
  const updates: Record<string, string> = {};
  const statuses: Record<string, AuthFieldStatus> = {};

  setDefaultValue(configuredEnv, updates, statuses, 'AUTONOMY_INITIALIZED', '1');

  let nodeAuthToken = getStringOption(options, 'node-auth-token');
  if (nodeAuthToken) {
    nodeAuthToken = validateEnvValue('NODE_AUTH_TOKEN', nodeAuthToken);
    updates.NODE_AUTH_TOKEN = nodeAuthToken;
    statuses.NODE_AUTH_TOKEN = 'updated';
  } else if (hasConfiguredValue(configuredEnv, 'NODE_AUTH_TOKEN')) {
    nodeAuthToken = configuredEnv.NODE_AUTH_TOKEN;
    statuses.NODE_AUTH_TOKEN = 'present';
  } else {
    const prompted = interactive
      ? await promptHidden('NODE_AUTH_TOKEN for GitHub Packages (blank to skip): ')
      : '';
    if (prompted) {
      nodeAuthToken = validateEnvValue('NODE_AUTH_TOKEN', prompted);
      updates.NODE_AUTH_TOKEN = nodeAuthToken;
      statuses.NODE_AUTH_TOKEN = 'updated';
    } else {
      statuses.NODE_AUTH_TOKEN = 'skipped';
    }
  }

  let controlPlaneUrl = getStringOption(options, 'control-plane-url');
  if (controlPlaneUrl) {
    controlPlaneUrl = validateEnvValue('AUTONOMY_CONTROL_PLANE_SERVER_URL', controlPlaneUrl);
    updates.AUTONOMY_CONTROL_PLANE_SERVER_URL = controlPlaneUrl;
    statuses.AUTONOMY_CONTROL_PLANE_SERVER_URL = 'updated';
  } else if (hasConfiguredValue(configuredEnv, 'AUTONOMY_CONTROL_PLANE_SERVER_URL')) {
    controlPlaneUrl = configuredEnv.AUTONOMY_CONTROL_PLANE_SERVER_URL;
    statuses.AUTONOMY_CONTROL_PLANE_SERVER_URL = 'present';
  } else {
    const prompted = interactive
      ? await promptText('AUTONOMY_CONTROL_PLANE_SERVER_URL (blank to skip): ')
      : '';
    if (prompted) {
      controlPlaneUrl = validateEnvValue('AUTONOMY_CONTROL_PLANE_SERVER_URL', prompted);
      updates.AUTONOMY_CONTROL_PLANE_SERVER_URL = controlPlaneUrl;
      statuses.AUTONOMY_CONTROL_PLANE_SERVER_URL = 'updated';
    } else {
      statuses.AUTONOMY_CONTROL_PLANE_SERVER_URL = 'skipped';
    }
  }

  const repo = resolveGithubRepo(rootDir, options);
  const tokenTemplateUrl = buildGithubTokenTemplateUrl(repo);
  let githubToken = getStringOption(options, 'github-token');
  if (githubToken) {
    githubToken = validateEnvValue('GITHUB_TOKEN', githubToken);
    updates.GITHUB_TOKEN = githubToken;
    statuses.GITHUB_TOKEN = 'updated';
  } else if (hasConfiguredValue(configuredEnv, 'GITHUB_TOKEN')) {
    githubToken = configuredEnv.GITHUB_TOKEN;
    statuses.GITHUB_TOKEN = 'present';
  } else {
    if (interactive) {
      output.write(`Create a fine-grained GitHub token with this template URL:\n${tokenTemplateUrl}\n`);
      if (options.open === true) {
        openUrl(tokenTemplateUrl);
      }
      githubToken = await promptHidden('Paste GITHUB_TOKEN, then press Enter: ');
    }
    if (!githubToken) {
      throw new Error(
        'Missing required GITHUB_TOKEN. Re-run with --github-token <token> or use interactive auth setup.'
      );
    }
    githubToken = validateEnvValue('GITHUB_TOKEN', githubToken);
    updates.GITHUB_TOKEN = githubToken;
    statuses.GITHUB_TOKEN = 'updated';
  }

  const nextContent = mergeEnvContent(readEnvContent(envPath), updates);
  writeEnvFileAtomic(envPath, nextContent);
  Object.entries(updates).forEach(([key, value]) => {
    process.env[key] = value;
  });

  const verification = options['skip-verify'] === true
    ? {
      github: { status: 'skipped', reason: 'skip-verify' } as VerificationResult,
      nodeAuth: { status: 'skipped', reason: 'skip-verify' } as VerificationResult,
    }
    : {
      github: await verifyGithubTokenForRepo(githubToken, repo),
      nodeAuth: verifyNodeAuthTokenCanAccessPackage(nodeAuthToken),
    };

  return {
    envPath,
    repo,
    tokenTemplateUrl,
    statuses,
    updatedKeys: Object.keys(updates),
    verification,
  };
}

function setDefaultValue(
  configuredEnv: Record<string, string>,
  updates: Record<string, string>,
  statuses: Record<string, AuthFieldStatus>,
  key: string,
  value: string,
) {
  if (hasConfiguredValue(configuredEnv, key)) {
    statuses[key] = 'present';
    return;
  }
  updates[key] = value;
  statuses[key] = 'updated';
}

function getStringOption(options: CliOptions, key: string) {
  const value = options[key];
  return typeof value === 'string' ? value.trim() : '';
}

function validateEnvValue(key: string, value: string) {
  const normalized = value.trim();
  if (/\r|\n/.test(normalized)) {
    throw new Error(`${key} must be a single-line value.`);
  }
  return normalized;
}

function hasConfiguredValue(env: Record<string, string>, key: string) {
  return String(env[key] || '').trim().length > 0;
}

function readEnvContent(envPath: string) {
  try {
    return fs.readFileSync(envPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function readEnvFileValues(envPath: string) {
  const values: Record<string, string> = {};
  readEnvContent(envPath).split(/\r?\n/).forEach((line) => {
    const key = parseEnvLineKey(line);
    if (!key || Object.prototype.hasOwnProperty.call(values, key)) return;
    let value = line.slice(line.indexOf('=') + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  });
  return values;
}

function mergeEnvContent(existing: string, updates: Record<string, string>) {
  const remaining = new Map(Object.entries(updates));
  const seen = new Set<string>();
  const lines = existing.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const nextLines: string[] = [];

  lines.forEach((line) => {
    const key = parseEnvLineKey(line);
    if (!key) {
      nextLines.push(line);
      return;
    }
    if (seen.has(key)) return;
    seen.add(key);
    if (remaining.has(key)) {
      nextLines.push(`${key}=${remaining.get(key)}`);
      remaining.delete(key);
      return;
    }
    nextLines.push(line);
  });
  remaining.forEach((value, key) => nextLines.push(`${key}=${value}`));
  return `${nextLines.join('\n')}\n`;
}

function parseEnvLineKey(line: string) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? match[1] : '';
}

function writeEnvFileAtomic(envPath: string, content: string) {
  ensureDir(path.dirname(envPath));
  const tempPath = path.join(
    path.dirname(envPath),
    `.${path.basename(envPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(tempPath, envPath);
    fs.chmodSync(envPath, 0o600);
  } catch (error) {
    if (descriptor !== null) fs.closeSync(descriptor);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

function resolveGithubRepo(rootDir: string, options: CliOptions): GithubRepo {
  const explicit = getStringOption(options, 'repo');
  if (explicit) {
    const parsed = parseRepoName(explicit);
    if (!parsed) {
      throw new Error('--repo must be a GitHub repository in owner/name form.');
    }
    return { ...parsed, fullName: `${parsed.owner}/${parsed.repo}`, source: 'option' };
  }

  let remote = '';
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // The error below deliberately excludes command output and credentials.
  }
  const parsed = parseGithubRemote(remote);
  if (!parsed) {
    throw new Error(
      'Could not infer a GitHub repository from origin. Pass --repo owner/name.'
    );
  }
  return { ...parsed, fullName: `${parsed.owner}/${parsed.repo}`, source: 'origin' };
}

function parseGithubRemote(remote: string) {
  let repoPath = '';
  const scpMatch = remote.match(/^git@github\.com:(.+)$/i);
  if (scpMatch) {
    repoPath = scpMatch[1];
  } else {
    try {
      const parsed = new URL(remote);
      if (parsed.hostname.toLowerCase() !== 'github.com') return null;
      repoPath = parsed.pathname;
    } catch {
      return null;
    }
  }
  return parseRepoName(repoPath.replace(/^\/+/, '').replace(/\.git$/, ''));
}

function parseRepoName(value: string) {
  const parts = value.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9.-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return { owner, repo };
}

function buildGithubTokenTemplateUrl(repo: GithubRepo) {
  const params = new URLSearchParams({
    name: `Autonomy ${repo.repo}`,
    description: `Autonomy repo agent for ${repo.fullName}`,
    target_name: repo.owner,
    expires_in: '90',
    contents: 'write',
    issues: 'write',
    pull_requests: 'write',
    metadata: 'read',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

async function verifyGithubTokenForRepo(
  token: string,
  repo: GithubRepo,
): Promise<VerificationResult> {
  if (!token) return { status: 'skipped', reason: 'missing-token' };
  const user = await githubApiRequest(token, '/user');
  if (user.statusCode !== 200) {
    return { status: 'invalid', reason: statusReason(user.statusCode) };
  }

  const repoPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
  const [repoResult, pullRequests, issues, repositories] = await Promise.all([
    githubApiRequest(token, repoPath),
    githubApiRequest(token, `${repoPath}/pulls?state=open&per_page=1`),
    githubApiRequest(token, `${repoPath}/issues?state=open&per_page=1`),
    githubApiRequest(token, '/user/repos?per_page=100&type=all&affiliation=owner,collaborator,organization_member'),
  ]);
  const repoBody = isRecord(repoResult.body) ? repoResult.body : {};
  const permissions = isRecord(repoBody.permissions) ? repoBody.permissions : {};
  const repoAccess = repoResult.statusCode === 200;
  const repoWrite = Boolean(permissions.admin || permissions.maintain || permissions.push);
  const pullRequestsReadable = pullRequests.statusCode === 200;
  const issuesReadable = issues.statusCode === 200;
  const repoOnly = classifyRepoOnlyScope(repositories, repo.fullName.toLowerCase());
  const valid = repoAccess && repoWrite && pullRequestsReadable && issuesReadable;
  const userBody = isRecord(user.body) ? user.body : {};

  return {
    status: valid ? 'valid' : 'invalid',
    user: String(userBody.login || ''),
    repo: repo.fullName,
    repoAccess,
    repoWrite,
    pullRequestsReadable,
    issuesReadable,
    repoOnly: repoOnly.repoOnly,
    repoOnlyStatus: repoOnly.status,
  };
}

function verifyNodeAuthTokenCanAccessPackage(token: string): VerificationResult {
  if (!token) return { status: 'skipped', reason: 'missing-token' };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-node-auth-'));
  const npmrcPath = path.join(tempDir, '.npmrc');
  fs.writeFileSync(npmrcPath, [
    '@asalaza6:registry=https://npm.pkg.github.com',
    '//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o600 });

  try {
    const result = spawnSync('npm', [
      'pack',
      `${PACKAGE_NAME}@latest`,
      '--pack-destination',
      tempDir,
      '--userconfig',
      npmrcPath,
      '--registry',
      GITHUB_REGISTRY,
      '--silent',
    ], {
      cwd: tempDir,
      encoding: 'utf8',
      env: { ...process.env, NODE_AUTH_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    return {
      status: result.status === 0 ? 'valid' : 'invalid',
      packageName: PACKAGE_NAME,
      registry: GITHUB_REGISTRY,
      verifiedBy: 'npm pack',
      reason: result.status === 0 ? undefined : 'npm-pack-failed',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function githubApiRequest(token: string, apiPath: string): Promise<GithubResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: GithubResponse) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = httpsRequest({
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
      response.on('data', (chunk: string) => {
        if (raw.length <= 2_000_000) raw += chunk;
      });
      response.on('end', () => finish({
        statusCode: response.statusCode || 0,
        body: parseJson(raw),
      }));
    });
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy());
    request.on('error', () => finish({ statusCode: 0, body: null }));
    request.end();
  });
}

function classifyRepoOnlyScope(repositories: GithubResponse, targetFullName: string) {
  if (repositories.statusCode !== 200 || !Array.isArray(repositories.body)) {
    return { repoOnly: null, status: 'unknown-repo-list-unavailable' };
  }
  const visible = repositories.body
    .filter(isRecord)
    .map((entry) => ({
      fullName: String(entry.full_name || '').toLowerCase(),
      restricted: Boolean(entry.private || entry.visibility === 'internal'),
    }))
    .filter((entry) => entry.fullName);
  const restricted = visible.filter((entry) => entry.restricted);
  const scope = restricted.length > 0 ? restricted : visible;
  if (scope.length === 1 && scope[0].fullName === targetFullName) {
    return { repoOnly: true, status: 'verified-single-visible-repo' };
  }
  if (scope.some((entry) => entry.fullName === targetFullName)) {
    return { repoOnly: false, status: 'not-verified-multiple-visible-repos' };
  }
  return { repoOnly: false, status: 'target-repo-not-visible-in-repo-list' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseJson(raw: string) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function statusReason(statusCode: number) {
  if (statusCode === 401) return 'token-rejected';
  if (statusCode === 403) return 'token-forbidden';
  if (statusCode === 404) return 'not-found-or-not-authorized';
  if (statusCode === 0) return 'request-failed';
  return `http-${statusCode}`;
}

async function promptText(message: string) {
  if (!input.isTTY) return '';
  const readline = createInterface({ input, output });
  try {
    return (await readline.question(message)).trim();
  } finally {
    readline.close();
  }
}

async function promptHidden(message: string) {
  if (!input.isTTY || !output.isTTY) return '';
  let muted = true;
  const mutedOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) output.write(chunk);
      callback();
    },
  });
  output.write(message);
  const readline = createInterface({ input, output: mutedOutput, terminal: true });
  try {
    const value = (await readline.question('')).trim();
    muted = false;
    output.write('\n');
    return value;
  } finally {
    muted = false;
    readline.close();
  }
}

function openUrl(url: string) {
  try {
    if (process.platform === 'darwin') {
      spawnSync('open', [url], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else {
      spawnSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch {
    // The printed URL remains the reliable fallback.
  }
}

export { runAuth };
export type { AuthPayload };
