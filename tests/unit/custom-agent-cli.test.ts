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
      workspaceReadWrite: ['context.md', 'notes.md', 'recent-summary.md'],
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
      '--no-trace-window',
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

test('custom-agent:reset rejects an unknown runtime key with available keys', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const error = await captureConsoleError(async () => {
    await main([
      'custom-agent:reset',
      '--root',
      rootDir,
      '--runtime-key',
      'missing-agent:target-1',
      '--clear-context',
    ]);
  });

  assert.match(error, /Unknown custom agent runtime key "missing-agent:target-1"/);
  assert.match(error, /cli-agent:target-1/);
});

test('custom-agent:reset rejects multiple runtime keys', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const repeatedError = await captureConsoleError(async () => {
    await main([
      'custom-agent:reset',
      '--root',
      rootDir,
      '--runtime-key',
      'cli-agent:target-1',
      '--runtime-key',
      'cli-agent:target-2',
      '--clear-context',
    ]);
  });
  const commaError = await captureConsoleError(async () => {
    await main([
      'custom-agent:reset',
      '--root',
      rootDir,
      '--runtime-key',
      'cli-agent:target-1,cli-agent:target-2',
      '--clear-context',
    ]);
  });

  assert.match(repeatedError, /Multiple --runtime-key flags are not supported/);
  assert.match(commaError, /Comma-separated runtime keys are not supported/);
});

test('custom-agent:reset rejects no-op invocation', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const error = await captureConsoleError(async () => {
    await main([
      'custom-agent:reset',
      '--root',
      rootDir,
      '--runtime-key',
      'cli-agent:target-1',
    ]);
  });

  assert.match(error, /Provide at least one of --archive-existing/);
});

test('custom-agent:reset archives existing workspace files without deleting them', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const workspacePath = prepareResetWorkspace(rootDir, {
    'context.md': 'old context\n',
    'notes.md': 'old notes\n',
    'recent-summary.md': 'old summary\n',
  });

  const output = await captureConsoleLog(async () => {
    await main([
      'custom-agent:reset',
      '--root',
      rootDir,
      '--runtime-key',
      'cli-agent:target-1',
      '--archive-existing',
      '--json',
    ]);
  });
  const payload = JSON.parse(output);

  assert.equal(payload.runtimeKey, 'cli-agent:target-1');
  assert.equal(payload.workspace, workspacePath);
  assert.deepEqual(payload.archivedFiles, ['context.md', 'notes.md', 'recent-summary.md']);
  assert.deepEqual(payload.rewrittenFiles, []);
  assert.deepEqual(payload.skippedMissingFiles, []);
  assert.equal(fs.readFileSync(path.join(workspacePath, 'context.md'), 'utf8'), 'old context\n');
  assert.equal(fs.readFileSync(path.join(payload.archiveDirectory, 'context.md'), 'utf8'), 'old context\n');
  assert.equal(fs.readFileSync(path.join(payload.archiveDirectory, 'notes.md'), 'utf8'), 'old notes\n');
  assert.equal(fs.readFileSync(path.join(payload.archiveDirectory, 'recent-summary.md'), 'utf8'), 'old summary\n');
});

test('custom-agent:reset skips missing optional files during archive', async () => {
  const { rootDir } = makeCustomAgentRepo();
  prepareResetWorkspace(rootDir, {
    'context.md': 'only context exists\n',
  });

  const output = await captureConsoleLog(async () => {
    await main([
      'custom-agent:reset',
      '--root',
      rootDir,
      '--runtime-key',
      'cli-agent:target-1',
      '--archive-existing',
      '--json',
    ]);
  });
  const payload = JSON.parse(output);

  assert.deepEqual(payload.archivedFiles, ['context.md']);
  assert.deepEqual(payload.skippedMissingFiles, ['notes.md', 'recent-summary.md']);
});

test('custom-agent:reset rewrites context with generic starter content', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const workspacePath = prepareResetWorkspace(rootDir, {
    'context.md': 'stock crypto trading personality\n',
  });

  await main([
    'custom-agent:reset',
    '--root',
    rootDir,
    '--runtime-key',
    'cli-agent:target-1',
    '--clear-context',
  ]);

  const context = fs.readFileSync(path.join(workspacePath, 'context.md'), 'utf8');
  assert.match(context, /# Custom Agent Context/);
  assert.doesNotMatch(context, /stock|crypto|trading|personality/i);
});

test('custom-agent:reset rewrites notes with generic starter content', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const workspacePath = prepareResetWorkspace(rootDir, {
    'notes.md': 'old notes\n',
  });

  await main([
    'custom-agent:reset',
    '--root',
    rootDir,
    '--runtime-key',
    'cli-agent:target-1',
    '--clear-notes',
  ]);

  const notes = fs.readFileSync(path.join(workspacePath, 'notes.md'), 'utf8');
  assert.match(notes, /# Notes/);
  assert.match(notes, /Fresh reset/);
  assert.doesNotMatch(notes, /old notes/);
});

test('custom-agent:reset rewrites recent summary with generic starter content', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const workspacePath = prepareResetWorkspace(rootDir, {
    'recent-summary.md': 'old summary\n',
  });

  await main([
    'custom-agent:reset',
    '--root',
    rootDir,
    '--runtime-key',
    'cli-agent:target-1',
    '--clear-recent-summary',
  ]);

  const summary = fs.readFileSync(path.join(workspacePath, 'recent-summary.md'), 'utf8');
  assert.match(summary, /# Recent Summary/);
  assert.match(summary, /Fresh reset/);
  assert.doesNotMatch(summary, /old summary/);
});

test('custom-agent:reset JSON output shape is stable', async () => {
  const { rootDir } = makeCustomAgentRepo();
  const workspacePath = prepareResetWorkspace(rootDir, {});

  const output = await captureConsoleLog(async () => {
    await main([
      'custom-agent:reset',
      '--root',
      rootDir,
      '--runtime-key',
      'cli-agent:target-1',
      '--clear-context',
      '--json',
    ]);
  });
  const payload = JSON.parse(output);

  assert.deepEqual(Object.keys(payload), [
    'runtimeKey',
    'workspace',
    'archiveDirectory',
    'archivedFiles',
    'rewrittenFiles',
    'skippedMissingFiles',
  ]);
  assert.equal(payload.runtimeKey, 'cli-agent:target-1');
  assert.equal(payload.workspace, workspacePath);
  assert.equal(payload.archiveDirectory, null);
  assert.deepEqual(payload.archivedFiles, []);
  assert.deepEqual(payload.rewrittenFiles, ['context.md']);
  assert.deepEqual(payload.skippedMissingFiles, []);
});

function prepareResetWorkspace(rootDir, files) {
  const workspacePath = path.join(rootDir, '.autonomy', 'custom', 'cli-agent-target-1');
  fs.mkdirSync(workspacePath, { recursive: true });
  Object.entries(files).forEach(([relativeFile, contents]) => {
    const filePath = path.join(workspacePath, relativeFile);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, String(contents), 'utf8');
  });
  return workspacePath;
}

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

async function captureConsoleError(callback: () => Promise<void>) {
  const originalError = console.error;
  const previousExitCode = process.exitCode;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    process.exitCode = undefined;
    await callback();
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
  return lines.join('\n');
}
