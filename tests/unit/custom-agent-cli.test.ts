import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { main } from '../../src/autonomy-v2/commands/commands-main.js';

function makeCustomAgentRepo() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agent-cli-'));
  const configDir = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config');
  const scriptsDir = path.join(rootDir, 'scripts');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'context.md'), '# CLI custom agent context\n', 'utf8');
  fs.writeFileSync(path.join(configDir, 'agents.json'), '{"schemaVersion":1,"agents":[]}\n', 'utf8');
  fs.writeFileSync(path.join(configDir, 'control-plane.json'), `${JSON.stringify({
    schemaVersion: 1,
    repoId: 'fixture',
    spawnCustomAgents: 'prompts/autonomous/v2/config/custom-agents.json',
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(configDir, 'custom-agents.json'), `${JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    context: {
      globalReadOnly: ['context.md'],
      workspaceReadWrite: ['state.json'],
      allowRuntimeStateChanges: true,
    },
    agents: [
      {
        id: 'cli-agent',
        enabled: false,
        target: { type: 'fixture', id: 'target-1' },
        workspace: '.autonomy/custom/cli-agent-target-1',
        spawn: {
          mode: 'poll',
          intervalSeconds: 3600,
          singletonKey: 'target.id',
          decision: {
            mode: 'command',
            command: ['node', 'scripts/should-run.mjs'],
          },
        },
        environment: {
          command: ['node', 'scripts/environment.mjs'],
        },
        execution: {
          prompt: {
            command: ['node', 'scripts/prompt.mjs'],
          },
        },
        finalize: {
          command: ['node', 'scripts/finalize.mjs'],
        },
        conversation: {
          scope: ['agent.id', 'decision.taskId'],
        },
      },
    ],
  }, null, 2)}\n`, 'utf8');

  fs.writeFileSync(path.join(scriptsDir, 'should-run.mjs'), [
    "import fs from 'fs';",
    "fs.writeFileSync('decision-ran.txt', 'yes\\n');",
    "process.stdout.write(JSON.stringify({ shouldRun: true, reason: 'manual cli run', taskId: 'task-1' }) + '\\n');",
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'environment.mjs'), [
    "import fs from 'fs';",
    "fs.writeFileSync('environment-ran.txt', 'yes\\n');",
    "process.stdout.write(JSON.stringify({ workspacePath: '.autonomy/custom/prepared' }) + '\\n');",
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'prompt.mjs'), [
    "import fs from 'fs';",
    "fs.writeFileSync('prompt-ran.txt', 'yes\\n');",
    "process.stdout.write(JSON.stringify({ prompt: 'Run the CLI custom agent fixture.' }) + '\\n');",
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(scriptsDir, 'finalize.mjs'), [
    "import fs from 'fs';",
    "fs.writeFileSync('finalize-ran.txt', 'yes\\n');",
    "process.stdout.write(JSON.stringify({ finalized: true }) + '\\n');",
  ].join('\n'), 'utf8');

  const fakeCodexPath = path.join(scriptsDir, 'fake-codex.mjs');
  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    'process.stdin.resume();',
    "process.stdin.on('end', () => {",
    "  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'cli-session-1' }) + '\\n');",
    '});',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  return { rootDir, fakeCodexPath };
}

test('custom-agent:toggle is registered and persists an enabled override', async () => {
  const { rootDir } = makeCustomAgentRepo();

  await main([
    'custom-agent:toggle',
    '--root',
    rootDir,
    '--runtime-key',
    'cli-agent:target-1',
    '--disable',
  ]);

  const runtime = JSON.parse(fs.readFileSync(path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json'), 'utf8'));
  assert.equal(runtime.customAgentEnabledOverrides['cli-agent:target-1'], false);
  assert.equal(runtime.customAgents['cli-agent:target-1'].enabled, false);
});

test('custom-agent:list is registered and prints configured runtime keys', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const output = await captureConsoleLog(async () => {
    await main([
      'custom-agent:list',
      '--root',
      rootDir,
    ]);
  });

  assert.match(output, /cli-agent:target-1/);
  assert.equal(fs.existsSync(path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json')), false);
});

test('custom-agent:run is registered and manually runs disabled agents through decision, lifecycle, Codex, and finalize', async () => {
  const { rootDir, fakeCodexPath } = makeCustomAgentRepo();
  const originalCodexBin = process.env.AUTONOMY_CODEX_BIN;
  process.env.AUTONOMY_CODEX_BIN = fakeCodexPath;

  try {
    await main([
      'custom-agent:run',
      '--root',
      rootDir,
      '--runtime-key',
      'cli-agent:target-1',
    ]);
  } finally {
    if (typeof originalCodexBin === 'string') {
      process.env.AUTONOMY_CODEX_BIN = originalCodexBin;
    } else {
      delete process.env.AUTONOMY_CODEX_BIN;
    }
  }

  assert.equal(fs.readFileSync(path.join(rootDir, 'decision-ran.txt'), 'utf8'), 'yes\n');
  assert.equal(fs.readFileSync(path.join(rootDir, 'environment-ran.txt'), 'utf8'), 'yes\n');
  assert.equal(fs.readFileSync(path.join(rootDir, 'prompt-ran.txt'), 'utf8'), 'yes\n');
  assert.equal(fs.readFileSync(path.join(rootDir, 'finalize-ran.txt'), 'utf8'), 'yes\n');

  const runtime = JSON.parse(fs.readFileSync(path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json'), 'utf8'));
  const status = runtime.customAgents['cli-agent:target-1'];
  assert.equal(status.status, 'idle');
  assert.equal(status.conversationKey, 'cli-agent:task-1');
  assert.equal(status.conversationId, 'cli-session-1');
  assert.equal(status.lastResult.finalize.finalized, true);
});

async function captureConsoleLog(callback: () => Promise<void>) {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
}
