import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runAuth } from '../src/commands/auth-command.js';
import { makeRoot, withEnvironment } from './helpers.js';

const AUTH_ENV_KEYS = [
  'AUTONOMY_INITIALIZED',
  'NODE_AUTH_TOKEN',
  'AUTONOMY_CONTROL_PLANE_SERVER_URL',
  'GITHUB_TOKEN',
];

test('auth writes a mode-0600 env file and returns no secret values', async () => {
  const rootDir = makeRoot();
  const envPath = path.join(rootDir, '.env.autonomy');
  await withClearedAuthEnvironment(async () => {
    const payload = await runAuth(rootDir, {
      json: true,
      repo: 'asalaza6/fluxborne',
      'node-auth-token': 'node-secret-value',
      'github-token': 'github-secret-value',
      'control-plane-url': 'https://control.example.test',
      'skip-verify': true,
    });

    const content = fs.readFileSync(envPath, 'utf8');
    assert.match(content, /^AUTONOMY_INITIALIZED=1$/m);
    assert.match(content, /^NODE_AUTH_TOKEN=node-secret-value$/m);
    assert.match(content, /^GITHUB_TOKEN=github-secret-value$/m);
    assert.match(
      content,
      /^AUTONOMY_CONTROL_PLANE_SERVER_URL=https:\/\/control\.example\.test$/m,
    );
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
    assert.deepEqual(payload.verification, {
      github: { status: 'skipped', reason: 'skip-verify' },
      nodeAuth: { status: 'skipped', reason: 'skip-verify' },
    });
    assert.equal(payload.repo.fullName, 'asalaza6/fluxborne');

    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /node-secret-value/);
    assert.doesNotMatch(serialized, /github-secret-value/);
    assert.doesNotMatch(serialized, /control\.example\.test/);
  });
});

test('auth infers the GitHub origin and preserves comments while deduplicating env keys', async () => {
  const rootDir = makeRoot();
  const envPath = path.join(rootDir, '.env.autonomy');
  execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'git@github.com:asalaza6/fluxborne.git'],
    { cwd: rootDir, stdio: 'ignore' },
  );
  fs.writeFileSync(envPath, [
    '# preserve this comment',
    'GITHUB_TOKEN=first-github-secret',
    'GITHUB_TOKEN=duplicate-github-secret',
    'CUSTOM_VALUE=first',
    'CUSTOM_VALUE=duplicate',
    'NODE_AUTH_TOKEN=existing-node-secret',
    'AUTONOMY_CONTROL_PLANE_SERVER_URL=https://control.example.test',
    'AUTONOMY_INITIALIZED=1',
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o644 });

  await withClearedAuthEnvironment(async () => {
    const payload = await runAuth(rootDir, { json: true, 'skip-verify': true });
    const content = fs.readFileSync(envPath, 'utf8');

    assert.equal(payload.repo.fullName, 'asalaza6/fluxborne');
    assert.equal(payload.repo.source, 'origin');
    assert.deepEqual(payload.updatedKeys, []);
    assert.match(content, /^# preserve this comment$/m);
    assert.equal((content.match(/^GITHUB_TOKEN=/gm) || []).length, 1);
    assert.equal((content.match(/^CUSTOM_VALUE=/gm) || []).length, 1);
    assert.match(content, /^GITHUB_TOKEN=first-github-secret$/m);
    assert.match(content, /^CUSTOM_VALUE=first$/m);
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);

    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, /github-secret/);
    assert.doesNotMatch(serialized, /node-secret/);
  });
});

test('non-interactive JSON auth requires an explicit or existing GitHub token', async () => {
  const rootDir = makeRoot();
  await withClearedAuthEnvironment(async () => {
    await assert.rejects(
      runAuth(rootDir, {
        json: true,
        repo: 'asalaza6/fluxborne',
        'skip-verify': true,
      }),
      /Missing required GITHUB_TOKEN/,
    );
    assert.equal(fs.existsSync(path.join(rootDir, '.env.autonomy')), false);
  });
});

async function withClearedAuthEnvironment(callback: () => Promise<void>) {
  await withEnvironment(
    Object.fromEntries(AUTH_ENV_KEYS.map((key) => [key, undefined])),
    callback,
  );
}
