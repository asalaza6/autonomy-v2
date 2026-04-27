import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { runCodexExec, runCodexStructured } from '../../src/codex/cli.js';

test('runCodexStructured can launch Codex with a restricted env and GitHub-only network config', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-codex-cli-'));
  const capturePath = path.join(fixtureDir, 'capture.json');
  const fakeCodexPath = path.join(fixtureDir, 'fake-codex.mjs');
  const originalCodexBin = process.env.AUTONOMY_CODEX_BIN;
  const originalUnrelatedSecret = process.env.UNRELATED_SECRET;

  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    "import fs from 'fs';",
    'const args = process.argv.slice(2);',
    "const outputIndex = args.indexOf('--output-last-message');",
    'const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";',
    `const capturePath = ${JSON.stringify(capturePath)};`,
    'fs.writeFileSync(capturePath, JSON.stringify({',
    '  args,',
    '  env: {',
    "    GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,",
    "    GH_TOKEN: process.env.GH_TOKEN || null,",
    "    UNRELATED_SECRET: process.env.UNRELATED_SECRET || null,",
    "    PATH: process.env.PATH || null,",
    "    HOME: process.env.HOME || null,",
    '  },',
    '}, null, 2));',
    'fs.writeFileSync(outputPath, JSON.stringify({ answer: "ok", prdProposal: null }));',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  process.env.AUTONOMY_CODEX_BIN = fakeCodexPath;
  process.env.UNRELATED_SECRET = 'host-only-secret';

  try {
    const output: any = await runCodexStructured({
      cwd: fixtureDir,
      prompt: 'Summarize the repo.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer', 'prdProposal'],
        properties: {
          answer: { type: 'string' },
          prdProposal: { type: 'null' },
        },
      },
      readOnly: true,
      env: {
        GITHUB_TOKEN: 'repo-assistant-token',
        GH_TOKEN: 'repo-assistant-token',
      } as NodeJS.ProcessEnv,
      inheritHostEnv: false,
      configOverrides: [
        'experimental_network.allowed_domains=["api.github.com"]',
        'experimental_network.open_world_enabled=false',
      ],
    });

    assert.equal(output.answer, 'ok');

    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(captured.env.GITHUB_TOKEN, 'repo-assistant-token');
    assert.equal(captured.env.GH_TOKEN, 'repo-assistant-token');
    assert.equal(captured.env.UNRELATED_SECRET, null);
    assert.equal(typeof captured.env.PATH, 'string');
    assert.equal(typeof captured.env.HOME, 'string');
    assert.equal(captured.args.includes('--sandbox'), true);
    assert.equal(captured.args.includes('read-only'), true);
    assert.equal(captured.args.includes('experimental_network.allowed_domains=["api.github.com"]'), true);
    assert.equal(captured.args.includes('experimental_network.open_world_enabled=false'), true);
  } finally {
    restoreEnv('AUTONOMY_CODEX_BIN', originalCodexBin);
    restoreEnv('UNRELATED_SECRET', originalUnrelatedSecret);
  }
});

test('runCodexStructured does not inherit host env when no explicit child env is provided', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-codex-cli-empty-env-'));
  const capturePath = path.join(fixtureDir, 'capture.json');
  const fakeCodexPath = path.join(fixtureDir, 'fake-codex.mjs');
  const originalCodexBin = process.env.AUTONOMY_CODEX_BIN;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  const originalUnrelatedSecret = process.env.UNRELATED_SECRET;

  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    "import fs from 'fs';",
    'const args = process.argv.slice(2);',
    "const outputIndex = args.indexOf('--output-last-message');",
    'const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";',
    `const capturePath = ${JSON.stringify(capturePath)};`,
    'fs.writeFileSync(capturePath, JSON.stringify({',
    '  env: {',
    "    GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,",
    "    GH_TOKEN: process.env.GH_TOKEN || null,",
    "    UNRELATED_SECRET: process.env.UNRELATED_SECRET || null,",
    "    PATH: process.env.PATH || null,",
    '  },',
    '}, null, 2));',
    'fs.writeFileSync(outputPath, JSON.stringify({ answer: "ok", prdProposal: null }));',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  process.env.AUTONOMY_CODEX_BIN = fakeCodexPath;
  process.env.GITHUB_TOKEN = 'host-github-token';
  process.env.GH_TOKEN = 'host-gh-token';
  process.env.UNRELATED_SECRET = 'host-only-secret';

  try {
    const output: any = await runCodexStructured({
      cwd: fixtureDir,
      prompt: 'Summarize the repo.',
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer', 'prdProposal'],
        properties: {
          answer: { type: 'string' },
          prdProposal: { type: 'null' },
        },
      },
      readOnly: true,
      inheritHostEnv: false,
    });

    assert.equal(output.answer, 'ok');

    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(captured.env.GITHUB_TOKEN, null);
    assert.equal(captured.env.GH_TOKEN, null);
    assert.equal(captured.env.UNRELATED_SECRET, null);
    assert.equal(typeof captured.env.PATH, 'string');
  } finally {
    restoreEnv('AUTONOMY_CODEX_BIN', originalCodexBin);
    restoreEnv('GITHUB_TOKEN', originalGithubToken);
    restoreEnv('GH_TOKEN', originalGhToken);
    restoreEnv('UNRELATED_SECRET', originalUnrelatedSecret);
  }
});

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === 'undefined') {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

test('runCodexExec enforces the configured wall-clock timeout', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-codex-cli-timeout-'));
  const fakeCodexPath = path.join(fixtureDir, 'fake-codex-delay.mjs');
  const originalCodexBin = process.env.AUTONOMY_CODEX_BIN;
  const originalTimeout = process.env.AUTONOMY_CODEX_EXEC_TIMEOUT_MS;

  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    'setTimeout(() => {',
    "  process.stdout.write(JSON.stringify({ session_id: 'sess-timeout' }) + '\\n');",
    '  process.exit(0);',
    '}, 200);',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  process.env.AUTONOMY_CODEX_BIN = fakeCodexPath;
  process.env.AUTONOMY_CODEX_EXEC_TIMEOUT_MS = '50';

  try {
    await assert.rejects(
      runCodexExec({
        cwd: fixtureDir,
        prompt: 'Make a small change.',
        readOnly: false,
        captureConversationId: true,
      }),
      /Codex CLI failed: Codex exceeded wall-clock timeout of 50ms/
    );
  } finally {
    restoreEnv('AUTONOMY_CODEX_BIN', originalCodexBin);
    restoreEnv('AUTONOMY_CODEX_EXEC_TIMEOUT_MS', originalTimeout);
  }
});

test('runCodexExec disables the wall-clock timeout when configured to 0', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-codex-cli-no-timeout-'));
  const fakeCodexPath = path.join(fixtureDir, 'fake-codex-delay.mjs');
  const originalCodexBin = process.env.AUTONOMY_CODEX_BIN;
  const originalTimeout = process.env.AUTONOMY_CODEX_EXEC_TIMEOUT_MS;

  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    'setTimeout(() => {',
    "  process.stdout.write(JSON.stringify({ session_id: 'sess-no-timeout' }) + '\\n');",
    '  process.exit(0);',
    '}, 200);',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  process.env.AUTONOMY_CODEX_BIN = fakeCodexPath;
  process.env.AUTONOMY_CODEX_EXEC_TIMEOUT_MS = '0';

  try {
    const output: any = await runCodexExec({
      cwd: fixtureDir,
      prompt: 'Make a small change.',
      readOnly: false,
      captureConversationId: true,
    });

    assert.equal(output.conversationId, 'sess-no-timeout');
  } finally {
    restoreEnv('AUTONOMY_CODEX_BIN', originalCodexBin);
    restoreEnv('AUTONOMY_CODEX_EXEC_TIMEOUT_MS', originalTimeout);
  }
});
