import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildGithubTokenTemplateUrl,
  run,
  verifyGithubTokenForRepo,
  verifyNodeAuthTokenCanAccessPackage,
  writeEnvUpdates,
} from '../../src/autonomy-v2/commands/auth-command.js';

test('auth command writes required auth values to .env.autonomy without printing secrets', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-auth-command-'));
  const envPath = path.join(rootDir, '.env.autonomy');
  const restore = clearEnv([
    'AUTONOMY_INITIALIZED',
    'NODE_AUTH_TOKEN',
    'AUTONOMY_CONTROL_PLANE_SERVER_URL',
    'GITHUB_TOKEN',
  ]);
  const originalLog = console.log;
  const lines: string[] = [];

  try {
    fs.writeFileSync(envPath, '# keep this comment\nGITHUB_TOKEN=old-token\nGITHUB_TOKEN=duplicate-token\n', 'utf8');
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };

    await run(rootDir, {
      json: true,
      repo: 'asalaza6/example-repo',
      'node-auth-token': 'node-secret',
      'github-token': 'github-secret',
      'control-plane-url': 'https://control.example.test',
      'skip-verify': true,
    });

    const content = fs.readFileSync(envPath, 'utf8');
    assert.match(content, /^# keep this comment/m);
    assert.match(content, /^AUTONOMY_INITIALIZED=1/m);
    assert.match(content, /^NODE_AUTH_TOKEN=node-secret/m);
    assert.match(content, /^GITHUB_TOKEN=github-secret/m);
    assert.match(content, /^AUTONOMY_CONTROL_PLANE_SERVER_URL=https:\/\/control\.example\.test/m);
    assert.equal((content.match(/^GITHUB_TOKEN=/gm) || []).length, 1);

    const output = lines.join('\n');
    assert.doesNotMatch(output, /node-secret/);
    assert.doesNotMatch(output, /github-secret/);
    const payload = JSON.parse(output);
    assert.deepEqual(payload.updatedKeys.sort(), [
      'AUTONOMY_CONTROL_PLANE_SERVER_URL',
      'AUTONOMY_INITIALIZED',
      'GITHUB_TOKEN',
      'NODE_AUTH_TOKEN',
    ].sort());
    assert.equal(payload.verification.github.status, 'skipped');
    assert.equal(payload.verification.nodeAuth.status, 'skipped');
  } finally {
    console.log = originalLog;
    restore();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('github token verifier checks repo access and best-effort single-repo scope', async () => {
  const calls: string[] = [];
  const result = await verifyGithubTokenForRepo('github-secret', {
    owner: 'asalaza6',
    repo: 'moving-game',
  }, async (_token, apiPath) => {
    calls.push(apiPath);
    if (apiPath === '/user') {
      return { statusCode: 200, headers: {}, body: { login: 'octo-user' } };
    }
    if (apiPath === '/repos/asalaza6/moving-game') {
      return { statusCode: 200, headers: {}, body: { permissions: { push: true } } };
    }
    if (apiPath.startsWith('/repos/asalaza6/moving-game/pulls')) {
      return { statusCode: 200, headers: {}, body: [] };
    }
    if (apiPath.startsWith('/repos/asalaza6/moving-game/issues')) {
      return { statusCode: 200, headers: {}, body: [] };
    }
    if (apiPath.startsWith('/user/repos')) {
      return { statusCode: 200, headers: {}, body: [{ full_name: 'asalaza6/moving-game', private: true }] };
    }
    return { statusCode: 404, headers: {}, body: null };
  });

  assert.equal(result.status, 'valid');
  assert.equal(result.repoAccess, true);
  assert.equal(result.repoWrite, true);
  assert.equal(result.pullRequestsReadable, true);
  assert.equal(result.issuesReadable, true);
  assert.equal(result.repoOnly, true);
  assert.equal(result.repoOnlyStatus, 'verified-single-visible-repo');
  assert.deepEqual(calls, [
    '/user',
    '/repos/asalaza6/moving-game',
    '/repos/asalaza6/moving-game/pulls?state=open&per_page=1',
    '/repos/asalaza6/moving-game/issues?state=open&per_page=1',
    '/user/repos?per_page=100&type=all&affiliation=owner,collaborator,organization_member',
  ]);
});

test('node auth verifier downloads package with token through temporary npmrc', () => {
  const runner = ((_command, args, options) => {
    assert.equal(_command, 'npm');
    assert.equal(args[0], 'pack');
    assert.equal(args[1], '@asalaza6/autonomy-v2@latest');
    assert.equal(options.env.NODE_AUTH_TOKEN, 'node-secret');
    const userConfigIndex = args.indexOf('--userconfig');
    assert.ok(userConfigIndex > -1);
    const npmrcPath = args[userConfigIndex + 1];
    assert.match(fs.readFileSync(npmrcPath, 'utf8'), /npm\.pkg\.github\.com/);
    return {
      status: 0,
      signal: null,
      output: [],
      pid: 123,
      stdout: 'asalaza6-autonomy-v2-1.0.0.tgz\n',
      stderr: '',
    };
  }) as any;
  const result = verifyNodeAuthTokenCanAccessPackage('node-secret', runner);

  assert.equal(result.status, 'valid');
  assert.equal(result.packageName, '@asalaza6/autonomy-v2');
  assert.equal(result.verifiedBy, 'npm pack');
});

test('auth token template URL includes fine-grained repo permissions', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-auth-url-'));
  try {
    const templateUrl = buildGithubTokenTemplateUrl(rootDir, {
      repo: 'asalaza6/moving-game',
      'expires-in': '45',
    });
    const parsed = new URL(templateUrl);
    assert.equal(parsed.hostname, 'github.com');
    assert.equal(parsed.pathname, '/settings/personal-access-tokens/new');
    assert.equal(parsed.searchParams.get('target_name'), 'asalaza6');
    assert.equal(parsed.searchParams.get('expires_in'), '45');
    assert.equal(parsed.searchParams.get('contents'), 'write');
    assert.equal(parsed.searchParams.get('issues'), 'write');
    assert.equal(parsed.searchParams.get('pull_requests'), 'write');
    assert.equal(parsed.searchParams.get('metadata'), 'read');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('writeEnvUpdates updates existing keys and appends missing keys', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-auth-env-write-'));
  const envPath = path.join(rootDir, '.env.autonomy');
  try {
    fs.writeFileSync(envPath, 'A=1\n# comment\nB=old\nB=duplicate\n', 'utf8');
    writeEnvUpdates(envPath, {
      B: 'new',
      C: '3',
    });
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'A=1\n# comment\nB=new\nC=3\n');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function clearEnv(keys: string[]) {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => {
    delete process.env[key];
  });
  return () => {
    previous.forEach((value, key) => {
      if (typeof value === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  };
}
