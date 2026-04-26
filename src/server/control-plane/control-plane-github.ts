import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

import { resolveGithubRepo } from '../../github/github-main.js';

const REPO_ASSISTANT_GITHUB_ENV_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;
const REPO_ASSISTANT_GITHUB_ALLOWED_HOSTS = ['api.github.com'] as const;
const REPO_ASSISTANT_GITHUB_SECRET_FILES = ['.env.autonomy.local', '.env.autonomy'] as const;
const DEFAULT_AUTONOMY_REPO_VALIDATION_PR = 27;
const repoAssistantGithubCapabilityCache = new Map<string, Record<string, any>>();

type GithubApiRunner = (args: string[], options: {
  token: string;
  baseEnv?: NodeJS.ProcessEnv;
  accept?: string;
}) => string;

function selectRepoAssistantGithubEnv(env: NodeJS.ProcessEnv = process.env) {
  const selected: Record<string, string> = {};
  const token = String(env.GITHUB_TOKEN || env.GH_TOKEN || '').trim();
  if (!token) {
    return selected;
  }
  REPO_ASSISTANT_GITHUB_ENV_KEYS.forEach((key) => {
    selected[key] = token;
  });
  return selected;
}

function buildRepoAssistantGithubEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...selectRepoAssistantGithubEnv(env),
  };
}

function buildRepoAssistantGithubCodexConfigOverrides() {
  return [
    `experimental_network.allowed_domains=${JSON.stringify([...REPO_ASSISTANT_GITHUB_ALLOWED_HOSTS])}`,
    'experimental_network.open_world_enabled=false',
  ];
}

function readRepoAssistantGithubEnvFromApprovedFiles(rootDir: string) {
  const raw: Record<string, string> = {};
  const loadedFrom: string[] = [];

  REPO_ASSISTANT_GITHUB_SECRET_FILES.forEach((fileName) => {
    const filePath = path.join(rootDir, fileName);
    if (!fs.existsSync(filePath)) {
      return;
    }
    loadedFrom.push(fileName);
    Object.entries(parseEnvFile(filePath)).forEach(([key, value]) => {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) {
        raw[key] = value;
      }
    });
  });

  return {
    env: selectRepoAssistantGithubEnv(raw as NodeJS.ProcessEnv),
    loadedFrom,
  };
}

function resolveRepoAssistantGithubEnv(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const runtimeEnv = selectRepoAssistantGithubEnv(env);
  if (Object.keys(runtimeEnv).length > 0) {
    return {
      env: runtimeEnv,
      loadedFrom: [] as string[],
      authSource: 'runtime-env',
    };
  }

  return {
    ...readRepoAssistantGithubEnvFromApprovedFiles(rootDir),
    authSource: 'approved-runtime-secret' as const,
  };
}

function parseEnvFile(filePath: string) {
  const parsed: Record<string, string> = {};
  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) {
      return;
    }
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  });
  return parsed;
}

function resolveValidationPullNumber(
  repo: { owner: string; repo: string },
  explicitPullNumber?: unknown,
) {
  const raw = String(explicitPullNumber || process.env.AUTONOMY_CONTROL_PLANE_GITHUB_VALIDATION_PR || '').trim();
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  if (repo.owner === 'asalaza6' && repo.repo === 'autonomy-v2') {
    return DEFAULT_AUTONOMY_REPO_VALIDATION_PR;
  }
  return null;
}

function resolveRepoAssistantGithubCapability(
  rootDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    includePullRequestData?: boolean;
    validationPullNumber?: number | null;
    githubApiRunner?: GithubApiRunner;
    repository?: { owner: string; repo: string } | null;
  } = {},
): any {
  const resolved = resolveRepoAssistantGithubCapabilityBase(rootDir, options);
  if ('result' in resolved) {
    return resolved.result;
  }
  const { env, githubEnv, pullNumber, repo, base } = resolved;
  const cacheKey = buildRepoAssistantGithubCapabilityCacheKey(base, githubEnv.GITHUB_TOKEN);
  const cachedCapability = repoAssistantGithubCapabilityCache.get(cacheKey);
  if (cachedCapability) {
    return {
      ...cachedCapability,
      validation: {
        ...cachedCapability.validation,
        pullRequestNumber: pullNumber,
      },
    };
  }

  const token = githubEnv.GITHUB_TOKEN;
  const runner = options.githubApiRunner || defaultGithubApiRunner;
  try {
    const repositoryMetadata = readGithubJson(
      runner,
      [`repos/${repo.owner}/${repo.repo}`],
      { token, baseEnv: env },
    );
    const pullRequestBundle = readPullRequestBundle(
      runner,
      repo,
      pullNumber,
      token,
      env,
      options.includePullRequestData === true,
    );
    const capability = {
      ...base,
      available: true,
      status: 'enabled',
      statusLabel: 'GitHub access ready',
      detail: `Validated GitHub read access for ${repo.owner}/${repo.repo}#${pullNumber}.`,
      repositoryMetadata: {
        private: repositoryMetadata.private === true,
        visibility: String(repositoryMetadata.visibility || '').trim() || null,
        defaultBranch: String(repositoryMetadata.default_branch || '').trim() || null,
      },
      validation: {
        ...base.validation,
        validatedAt: new Date().toISOString(),
      },
      ...(pullRequestBundle ? { pullRequest: pullRequestBundle } : {}),
    };
    repoAssistantGithubCapabilityCache.set(cacheKey, capability);
    return capability;
  } catch (error) {
    const capability = buildGithubCapabilityFailure(base, error, pullNumber);
    repoAssistantGithubCapabilityCache.set(cacheKey, capability);
    return capability;
  }
}

function resolveRepoAssistantGithubCapabilityStatus(
  rootDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    validationPullNumber?: number | null;
    repository?: { owner: string; repo: string } | null;
  } = {},
): any {
  const resolved = resolveRepoAssistantGithubCapabilityBase(rootDir, options);
  if ('result' in resolved) {
    return resolved.result;
  }
  const { githubEnv, pullNumber, base } = resolved;
  const cacheKey = buildRepoAssistantGithubCapabilityCacheKey(base, githubEnv.GITHUB_TOKEN);
  const cachedCapability = repoAssistantGithubCapabilityCache.get(cacheKey);
  if (cachedCapability) {
    return {
      ...cachedCapability,
      validation: {
        ...cachedCapability.validation,
        pullRequestNumber: pullNumber,
      },
    };
  }
  return {
    ...base,
    available: false,
    status: 'validation-pending',
    statusLabel: 'GitHub validation pending',
    detail: 'GitHub access will be validated when a repo assistant session starts.',
  };
}

function resolveRepoAssistantGithubCapabilityBase(
  rootDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    validationPullNumber?: number | null;
    repository?: { owner: string; repo: string } | null;
  } = {},
): any {
  const env = options.env || process.env;
  const approvedRuntimeSecrets = options.env
    ? {
        env: selectRepoAssistantGithubEnv(options.env),
        loadedFrom: [] as string[],
        authSource: 'runtime-env' as const,
      }
    : resolveRepoAssistantGithubEnv(rootDir, env);
  const githubEnv = approvedRuntimeSecrets.env;
  const authEnvKeys = Object.keys(githubEnv);
  const authSource = approvedRuntimeSecrets.authSource;
  let repo = options.repository || null;
  if (!repo) {
    try {
      repo = resolveGithubRepo(rootDir);
    } catch {
      return {
        result: buildRepoAssistantGithubRepoUnavailable(authSource, authEnvKeys, approvedRuntimeSecrets.loadedFrom),
      };
    }
  }
  if (!repo) {
    return {
      result: buildRepoAssistantGithubRepoUnavailable(authSource, authEnvKeys, approvedRuntimeSecrets.loadedFrom),
    };
  }
  const pullNumber = resolveValidationPullNumber(repo, options.validationPullNumber);
  const base = {
    provider: 'gh',
    authSource,
    authEnvKeys,
    authFiles: approvedRuntimeSecrets.loadedFrom,
    allowedHosts: [...REPO_ASSISTANT_GITHUB_ALLOWED_HOSTS],
    repository: {
      owner: repo.owner,
      repo: repo.repo,
    },
    validation: {
      pullRequestNumber: pullNumber,
    },
  };

  if (!githubEnv.GITHUB_TOKEN) {
    return {
      result: {
        ...base,
        available: false,
        status: 'missing-token',
        statusLabel: 'GitHub access unavailable',
        detail: approvedRuntimeSecrets.loadedFrom.length > 0
          ? `No whitelisted GitHub token is configured in ${approvedRuntimeSecrets.loadedFrom.join(' or ')} for repo assistant PR inspection.`
          : 'No approved runtime GitHub token is available for repo assistant PR inspection.',
      },
    };
  }

  if (!pullNumber) {
    return {
      result: {
        ...base,
        available: false,
        status: 'validation-unconfigured',
        statusLabel: 'GitHub validation unavailable',
        detail: 'No validation pull request is configured for repo assistant GitHub inspection.',
      },
    };
  }

  return {
    env,
    githubEnv,
    pullNumber,
    repo,
    base,
  };
}

function buildRepoAssistantGithubRepoUnavailable(
  authSource: string,
  authEnvKeys: string[],
  authFiles: string[],
) {
  return {
    provider: 'gh',
    authSource,
    authEnvKeys,
    authFiles,
    allowedHosts: [...REPO_ASSISTANT_GITHUB_ALLOWED_HOSTS],
    repository: null,
    validation: {
      pullRequestNumber: null,
    },
    available: false,
    status: 'repo-unavailable',
    statusLabel: 'GitHub repo unavailable',
    detail: 'The repo assistant could not resolve a GitHub origin for this repository.',
  };
}

function buildRepoAssistantGithubCapabilityCacheKey(base: Record<string, any>, token: string) {
  const repository = base.repository || {};
  return JSON.stringify({
    owner: repository.owner || '',
    repo: repository.repo || '',
    pullRequestNumber: base.validation && base.validation.pullRequestNumber || null,
    authSource: base.authSource || '',
    authFiles: Array.isArray(base.authFiles) ? base.authFiles : [],
    token,
  });
}

function buildRepoAssistantGithubPromptContext(capability: Record<string, any> | null | undefined) {
  const github = capability && typeof capability === 'object' ? capability : {};
  const pullRequest = github.pullRequest && typeof github.pullRequest === 'object'
    ? github.pullRequest
    : null;
  return {
    status: github.status || 'unavailable',
    statusLabel: github.statusLabel || 'GitHub access unavailable',
    available: github.available === true,
    detail: github.detail || 'GitHub PR inspection is unavailable.',
    provider: github.provider || 'gh',
    authSource: github.authSource || 'runtime-env',
    authEnvKeys: Array.isArray(github.authEnvKeys) ? github.authEnvKeys : [],
    authFiles: Array.isArray(github.authFiles) ? github.authFiles : [],
    allowedHosts: Array.isArray(github.allowedHosts) ? github.allowedHosts : [],
    repository: github.repository || null,
    validation: github.validation || null,
    pullRequest,
  };
}

function buildGithubCapabilityFailure(base: Record<string, any>, error: unknown, pullNumber: number | null) {
  const classification = classifyGithubFailure(error);
  const detail = classification === 'invalid-token'
    ? 'The runtime GitHub token was rejected during repo assistant validation.'
    : classification === 'unauthorized-token'
      ? `The runtime GitHub token does not have read access to ${base.repository.owner}/${base.repository.repo}${pullNumber ? `#${pullNumber}` : ''}.`
      : 'GitHub validation failed for repo assistant PR inspection.';
  return {
    ...base,
    available: false,
    status: classification,
    statusLabel: classification === 'invalid-token'
      ? 'GitHub token invalid'
      : classification === 'unauthorized-token'
        ? 'GitHub repo access denied'
        : 'GitHub validation failed',
    detail,
  };
}

function classifyGithubFailure(error: unknown) {
  const stderr = String(
    error && typeof error === 'object' && 'stderr' in error
      ? (error as { stderr?: string }).stderr
      : '',
  ).toLowerCase();
  const stdout = String(
    error && typeof error === 'object' && 'stdout' in error
      ? (error as { stdout?: string }).stdout
      : '',
  ).toLowerCase();
  const status = Number(
    error && typeof error === 'object' && 'status' in error
      ? (error as { status?: number }).status
      : 0,
  );
  const content = `${stderr}\n${stdout}`;
  if (content.includes('http 401') || content.includes('requires authentication') || content.includes('bad credentials')) {
    return 'invalid-token';
  }
  if (content.includes('http 403') || content.includes('http 404') || content.includes('resource not accessible')) {
    return 'unauthorized-token';
  }
  if (status === 1 && content.includes('authentication')) {
    return 'invalid-token';
  }
  return 'validation-failed';
}

function readPullRequestBundle(
  runner: GithubApiRunner,
  repo: { owner: string; repo: string },
  pullNumber: number,
  token: string,
  baseEnv: NodeJS.ProcessEnv,
  includePullRequestData: boolean,
) {
  const metadata = readGithubJson(
    runner,
    [`repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}`],
    { token, baseEnv },
  );
  const files = readGithubJson(
    runner,
    [`repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/files?per_page=100`],
    { token, baseEnv },
  );
  const comments = readGithubJson(
    runner,
    [`repos/${repo.owner}/${repo.repo}/issues/${pullNumber}/comments?per_page=100`],
    { token, baseEnv },
  );
  const reviews = readGithubJson(
    runner,
    [`repos/${repo.owner}/${repo.repo}/pulls/${pullNumber}/reviews?per_page=100`],
    { token, baseEnv },
  );
  const reviewThreads = readGithubReviewThreads(runner, repo, pullNumber, token, baseEnv);
  const unresolvedThreads = reviewThreads.filter((thread) => thread.isResolved !== true);
  return {
    number: Number(metadata.number || pullNumber),
    title: String(metadata.title || '').trim(),
    state: String(metadata.state || '').trim() || null,
    url: String(metadata.html_url || metadata.url || '').trim() || null,
    author: String(metadata.user && metadata.user.login || '').trim() || null,
    baseRefName: String(metadata.base && metadata.base.ref || '').trim() || null,
    headRefName: String(metadata.head && metadata.head.ref || '').trim() || null,
    summary: {
      fileCount: Array.isArray(files) ? files.length : 0,
      topLevelCommentCount: Array.isArray(comments) ? comments.length : 0,
      reviewCount: Array.isArray(reviews) ? reviews.length : 0,
      unresolvedReviewThreadCount: unresolvedThreads.length,
    },
    ...(includePullRequestData
      ? {
          files: Array.isArray(files) ? files.map(summarizePullRequestFile).slice(0, 100) : [],
          topLevelComments: Array.isArray(comments) ? comments.map(summarizeIssueComment).slice(0, 100) : [],
          reviews: Array.isArray(reviews) ? reviews.map(summarizeReview).slice(0, 100) : [],
          unresolvedReviewThreads: unresolvedThreads.map(summarizeReviewThread).slice(0, 100),
        }
      : {}),
  };
}

function summarizePullRequestFile(file: Record<string, any>) {
  return {
    path: String(file.filename || '').trim(),
    status: String(file.status || '').trim() || null,
    additions: Number(file.additions || 0),
    deletions: Number(file.deletions || 0),
    changes: Number(file.changes || 0),
    patch: truncateText(String(file.patch || '').trim(), 4000),
  };
}

function summarizeIssueComment(comment: Record<string, any>) {
  return {
    author: String(comment.user && comment.user.login || '').trim() || null,
    url: String(comment.html_url || comment.url || '').trim() || null,
    createdAt: String(comment.created_at || '').trim() || null,
    body: truncateText(String(comment.body || '').trim(), 4000),
  };
}

function summarizeReview(review: Record<string, any>) {
  return {
    author: String(review.user && review.user.login || '').trim() || null,
    state: String(review.state || '').trim() || null,
    submittedAt: String(review.submitted_at || '').trim() || null,
    url: String(review.html_url || review.url || '').trim() || null,
    body: truncateText(String(review.body || '').trim(), 4000),
  };
}

function summarizeReviewThread(thread: Record<string, any>) {
  const comments = Array.isArray(thread.comments) ? thread.comments : [];
  return {
    path: String(thread.path || '').trim() || null,
    line: Number(thread.line || 0) || null,
    isResolved: thread.isResolved === true,
    comments: comments.map((comment) => ({
      author: String(comment.author || '').trim() || null,
      createdAt: String(comment.createdAt || '').trim() || null,
      url: String(comment.url || '').trim() || null,
      body: truncateText(String(comment.body || '').trim(), 4000),
    })),
  };
}

function readGithubReviewThreads(
  runner: GithubApiRunner,
  repo: { owner: string; repo: string },
  pullNumber: number,
  token: string,
  baseEnv: NodeJS.ProcessEnv,
) {
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
  const result = readGithubJson(
    runner,
    [
      'graphql',
      '-f', `query=${query}`,
      '-F', `owner=${repo.owner}`,
      '-F', `repo=${repo.repo}`,
      '-F', `number=${pullNumber}`,
    ],
    { token, baseEnv },
  );
  const nodes = result
    && result.data
    && result.data.repository
    && result.data.repository.pullRequest
    && result.data.repository.pullRequest.reviewThreads
    && Array.isArray(result.data.repository.pullRequest.reviewThreads.nodes)
    ? result.data.repository.pullRequest.reviewThreads.nodes
    : [];
  return nodes.map((thread: Record<string, any>) => ({
    path: String(thread.path || '').trim() || null,
    line: Number(thread.line || 0) || null,
    isResolved: thread.isResolved === true,
    comments: Array.isArray(thread.comments && thread.comments.nodes)
      ? thread.comments.nodes.map((comment: Record<string, any>) => ({
          author: String(comment.author && comment.author.login || '').trim() || null,
          body: String(comment.body || '').trim(),
          url: String(comment.url || '').trim() || null,
          createdAt: String(comment.createdAt || '').trim() || null,
        }))
      : [],
  }));
}

function readGithubJson(
  runner: GithubApiRunner,
  args: string[],
  options: {
    token: string;
    baseEnv: NodeJS.ProcessEnv;
    accept?: string;
  },
) {
  const raw = runner(args, options).trim();
  return raw ? JSON.parse(raw) : null;
}

function defaultGithubApiRunner(
  args: string[],
  options: {
    token: string;
    baseEnv?: NodeJS.ProcessEnv;
    accept?: string;
  },
) {
  const headers = [
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
  ];
  if (options.accept) {
    headers.push('-H', `Accept: ${options.accept}`);
  }
  return execFileSync('gh', ['api', ...args, ...headers], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...(options.baseEnv || process.env),
      GITHUB_TOKEN: options.token,
      GH_TOKEN: options.token,
    },
  });
}

function truncateText(value: string, limit: number) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length <= limit) {
    return normalized || null;
  }
  return `${normalized.slice(0, limit)}...`;
}

export {
  buildRepoAssistantGithubCodexConfigOverrides,
  REPO_ASSISTANT_GITHUB_ALLOWED_HOSTS,
  REPO_ASSISTANT_GITHUB_ENV_KEYS,
  REPO_ASSISTANT_GITHUB_SECRET_FILES,
  buildRepoAssistantGithubEnv,
  buildRepoAssistantGithubPromptContext,
  readRepoAssistantGithubEnvFromApprovedFiles,
  resolveRepoAssistantGithubCapabilityStatus,
  resolveRepoAssistantGithubEnv,
  resolveRepoAssistantGithubCapability,
  selectRepoAssistantGithubEnv,
};
