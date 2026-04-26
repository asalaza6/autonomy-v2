import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  REPO_ASSISTANT_GITHUB_SECRET_FILES,
  buildRepoAssistantGithubCodexConfigOverrides,
  buildRepoAssistantGithubEnv,
  buildRepoAssistantGithubPromptContext,
  readRepoAssistantGithubEnvFromApprovedFiles,
  resolveRepoAssistantGithubCapability,
  selectRepoAssistantGithubEnv,
} from '../../src/server/control-plane/control-plane-github.js';

const TEST_REPO = {
  owner: 'asalaza6',
  repo: 'autonomy-v2',
};

test('repo assistant GitHub env selection only forwards whitelisted auth vars', () => {
  const selected = selectRepoAssistantGithubEnv({
    GITHUB_TOKEN: 'token-123',
    SECRET_KEY: 'should-not-forward',
  } as NodeJS.ProcessEnv);
  const injected = buildRepoAssistantGithubEnv({
    GH_TOKEN: 'token-456',
    AWS_SECRET_ACCESS_KEY: 'should-not-forward',
  } as NodeJS.ProcessEnv);

  assert.deepEqual(selected, {
    GITHUB_TOKEN: 'token-123',
    GH_TOKEN: 'token-123',
  });
  assert.deepEqual(injected, {
    GITHUB_TOKEN: 'token-456',
    GH_TOKEN: 'token-456',
  });
  assert.deepEqual(REPO_ASSISTANT_GITHUB_SECRET_FILES, ['.env.autonomy.local', '.env.autonomy']);
  assert.deepEqual(buildRepoAssistantGithubCodexConfigOverrides(), [
    'experimental_network.allowed_domains=["api.github.com"]',
    'experimental_network.open_world_enabled=false',
  ]);
});

test('repo assistant GitHub approved secret reader ignores arbitrary env files', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-repo-assistant-github-env-'));
  fs.writeFileSync(path.join(rootDir, '.env'), 'GITHUB_TOKEN=should-not-load\n', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.env.local'), 'GH_TOKEN=should-not-load-either\n', 'utf8');
  fs.writeFileSync(path.join(rootDir, '.env.autonomy'), 'GITHUB_TOKEN=approved-token\n', 'utf8');

  const injected = readRepoAssistantGithubEnvFromApprovedFiles(rootDir);

  assert.deepEqual(injected.loadedFrom, ['.env.autonomy']);
  assert.deepEqual(injected.env, {
    GITHUB_TOKEN: 'approved-token',
    GH_TOKEN: 'approved-token',
  });
});

test('repo assistant GitHub capability requires approved runtime secret files when no explicit env is injected', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-repo-assistant-github-capability-'));
  fs.writeFileSync(path.join(rootDir, '.env'), 'GITHUB_TOKEN=wrong-source-token\n', 'utf8');

  const capability: any = resolveRepoAssistantGithubCapability(rootDir, {
    repository: TEST_REPO,
    validationPullNumber: 27,
    githubApiRunner() {
      throw new Error('should not run without an approved token');
    },
  });

  assert.equal(capability.available, false);
  assert.equal(capability.status, 'missing-token');
  assert.equal(capability.authSource, 'approved-runtime-secret');
  assert.deepEqual(capability.authFiles, []);
  assert.match(capability.detail, /approved runtime GitHub token/i);
  assert.doesNotMatch(JSON.stringify(capability), /wrong-source-token/);
});

test('repo assistant GitHub capability reports missing token without exposing secret-looking values', () => {
  const capability: any = resolveRepoAssistantGithubCapability('/tmp/fixture', {
    env: {},
    repository: TEST_REPO,
    validationPullNumber: 27,
    githubApiRunner() {
      throw new Error('should not run without a token');
    },
  });

  assert.equal(capability.available, false);
  assert.equal(capability.status, 'missing-token');
  assert.equal(capability.detail.includes('token'), true);
  assert.doesNotMatch(JSON.stringify(capability), /should-not-run|ghp_|token-123/);
});

test('repo assistant GitHub capability classifies invalid and unauthorized tokens', () => {
  const invalidToken = resolveRepoAssistantGithubCapability('/tmp/fixture', {
    env: {
      GITHUB_TOKEN: 'super-secret-token',
    } as NodeJS.ProcessEnv,
    repository: TEST_REPO,
    validationPullNumber: 27,
    githubApiRunner() {
      const error = new Error('gh failed') as Error & { stderr?: string; status?: number };
      error.stderr = 'HTTP 401 Bad credentials';
      error.status = 1;
      throw error;
    },
  });
  assert.equal(invalidToken.available, false);
  assert.equal(invalidToken.status, 'invalid-token');
  assert.equal(invalidToken.statusLabel, 'GitHub token invalid');
  assert.doesNotMatch(JSON.stringify(invalidToken), /super-secret-token/);

  const unauthorizedToken = resolveRepoAssistantGithubCapability('/tmp/fixture', {
    env: {
      GH_TOKEN: 'another-secret-token',
    } as NodeJS.ProcessEnv,
    repository: TEST_REPO,
    validationPullNumber: 27,
    githubApiRunner() {
      const error = new Error('gh failed') as Error & { stderr?: string; status?: number };
      error.stderr = 'HTTP 404 Not Found';
      error.status = 1;
      throw error;
    },
  });
  assert.equal(unauthorizedToken.available, false);
  assert.equal(unauthorizedToken.status, 'unauthorized-token');
  assert.equal(unauthorizedToken.statusLabel, 'GitHub repo access denied');
  assert.doesNotMatch(JSON.stringify(unauthorizedToken), /another-secret-token/);
});

test('repo assistant GitHub capability returns validated PR read context for enabled access', () => {
  const calls: string[] = [];
  const capability: any = resolveRepoAssistantGithubCapability('/tmp/fixture', {
    env: {
      GITHUB_TOKEN: 'enabled-secret-token',
    } as NodeJS.ProcessEnv,
    repository: TEST_REPO,
    validationPullNumber: 27,
    includePullRequestData: true,
    githubApiRunner(args) {
      calls.push(args.join(' '));
      const route = args[0] === 'graphql' ? 'graphql' : args[0];
      if (route === 'repos/asalaza6/autonomy-v2') {
        return JSON.stringify({
          private: true,
          visibility: 'private',
          default_branch: 'dev',
        });
      }
      if (route === 'repos/asalaza6/autonomy-v2/pulls/27') {
        return JSON.stringify({
          number: 27,
          title: 'Repo assistant session GitHub reads',
          state: 'open',
          html_url: 'https://github.com/asalaza6/autonomy-v2/pull/27',
          user: { login: 'asalaza6' },
          base: { ref: 'dev' },
          head: { ref: 'feature/repo-assistant' },
        });
      }
      if (route === 'repos/asalaza6/autonomy-v2/pulls/27/files?per_page=100') {
        return JSON.stringify([
          {
            filename: 'src/server/control-plane/control-plane-chat.ts',
            status: 'modified',
            additions: 10,
            deletions: 2,
            changes: 12,
            patch: '@@ -1,2 +1,10 @@\n+new behavior',
          },
        ]);
      }
      if (route === 'repos/asalaza6/autonomy-v2/issues/27/comments?per_page=100') {
        return JSON.stringify([
          {
            body: 'Top-level comment',
            created_at: '2026-04-26T10:00:00.000Z',
            html_url: 'https://github.com/asalaza6/autonomy-v2/pull/27#issuecomment-1',
            user: { login: 'reviewer' },
          },
        ]);
      }
      if (route === 'repos/asalaza6/autonomy-v2/pulls/27/reviews?per_page=100') {
        return JSON.stringify([
          {
            state: 'COMMENTED',
            body: 'Review body',
            submitted_at: '2026-04-26T11:00:00.000Z',
            html_url: 'https://github.com/asalaza6/autonomy-v2/pull/27#pullrequestreview-1',
            user: { login: 'reviewer' },
          },
        ]);
      }
      if (route === 'graphql') {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      isResolved: false,
                      path: 'src/server/control-plane/control-plane-chat.ts',
                      line: 42,
                      comments: {
                        nodes: [
                          {
                            body: 'Unresolved thread',
                            createdAt: '2026-04-26T11:30:00.000Z',
                            url: 'https://github.com/asalaza6/autonomy-v2/pull/27#discussion_r1',
                            author: { login: 'reviewer' },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected route: ${route}`);
    },
  });

  assert.equal(capability.available, true);
  assert.equal(capability.status, 'enabled');
  assert.equal(capability.pullRequest.summary.fileCount, 1);
  assert.equal(capability.pullRequest.summary.topLevelCommentCount, 1);
  assert.equal(capability.pullRequest.summary.reviewCount, 1);
  assert.equal(capability.pullRequest.summary.unresolvedReviewThreadCount, 1);
  assert.equal(capability.pullRequest.topLevelComments[0].author, 'reviewer');
  assert.equal(capability.pullRequest.reviews[0].state, 'COMMENTED');
  assert.equal(capability.pullRequest.unresolvedReviewThreads[0].comments[0].author, 'reviewer');
  assert.equal(calls.some((call) => call.startsWith('graphql ')), true);

  const promptContext = buildRepoAssistantGithubPromptContext(capability);
  assert.equal(promptContext.available, true);
  assert.equal(promptContext.pullRequest.summary.unresolvedReviewThreadCount, 1);
  assert.equal(promptContext.authSource, 'runtime-env');
  assert.doesNotMatch(JSON.stringify(promptContext), /enabled-secret-token/);
});

test('repo assistant GitHub capability loads approved runtime secrets from .env.autonomy for validation and injection', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-repo-assistant-github-approved-'));
  fs.writeFileSync(path.join(rootDir, '.env.autonomy'), 'GH_TOKEN=approved-secret-token\n', 'utf8');
  const calls: string[] = [];

  const capability: any = resolveRepoAssistantGithubCapability(rootDir, {
    repository: TEST_REPO,
    validationPullNumber: 27,
    githubApiRunner(args, options) {
      calls.push(args.join(' '));
      assert.equal(options.token, 'approved-secret-token');
      if (args[0] === `repos/${TEST_REPO.owner}/${TEST_REPO.repo}`) {
        return JSON.stringify({
          private: false,
          visibility: 'public',
          default_branch: 'dev',
        });
      }
      if (args[0] === `repos/${TEST_REPO.owner}/${TEST_REPO.repo}/pulls/27`) {
        return JSON.stringify({
          number: 27,
          title: 'Approved runtime secret validation',
          state: 'open',
          html_url: 'https://github.com/asalaza6/autonomy-v2/pull/27',
          user: { login: 'asalaza6' },
          base: { ref: 'dev' },
          head: { ref: 'feature/repo-assistant' },
        });
      }
      if (args[0].includes('/files?per_page=100')) {
        return '[]';
      }
      if (args[0].includes('/comments?per_page=100')) {
        return '[]';
      }
      if (args[0].includes('/reviews?per_page=100')) {
        return '[]';
      }
      if (args[0] === 'graphql') {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected route: ${args[0]}`);
    },
  });

  assert.equal(capability.available, true);
  assert.equal(capability.authSource, 'approved-runtime-secret');
  assert.deepEqual(capability.authFiles, ['.env.autonomy']);
  assert.equal(calls.length > 0, true);
});
