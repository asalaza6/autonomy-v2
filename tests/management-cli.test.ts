import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { main as cliMain, parseCli } from '../src/cli.js';
import { isProcessAlive, loadRuntime } from '../src/runtime.js';
import {
  getServerStatus,
  killServer,
  runServerCommand,
  startServer,
} from '../src/commands/server-command.js';
import {
  makeRoot,
  withEnvironment,
  writeFluxborneFixture,
  writeJson,
} from './helpers.js';

test('help restores the management commands and structured output promise', async () => {
  const variants = [[], ['help'], ['--help'], ['-h']];
  let expected = '';
  for (const argv of variants) {
    const output = await captureConsole(() => cliMain(argv));
    if (!expected) expected = output.stdout;
    assert.equal(output.stdout, expected);
  }
  [
    'init',
    'status [--sync]',
    'auth [--node-auth-token <token>] [--github-token <token>]',
    'server:start',
    'server:kill',
    'server:restart [--detached] [--foreground] [--keep-old-terminal]',
    'update [--package-manager <npm|pnpm|yarn>] [--skip-init]',
    'refresh',
    'Use --json to print structured JSON for any command.',
  ].forEach((line) => assert.match(expected, new RegExp(escapeRegExp(line))));
  assert.equal((expected.match(/^  refresh$/gm) || []).length, 1);

  const structured = await captureConsole(() => cliMain(['help', '--json']));
  const payload = JSON.parse(structured.stdout);
  assert.equal(structured.lines.length, 1);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'help');
  assert.ok(payload.commands.includes('server:kill'));
});

test('built CLI failures honor the JSON-only output contract', () => {
  const binary = fileURLToPath(new URL('../bin/autonomy-v2.js', import.meta.url));
  const rootDir = makeRoot();
  try {
    const result = spawnSync(process.execPath, [
      binary,
      'unknown-command',
      '--root',
      rootDir,
      '--json',
    ], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error.message, /Unknown command/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('the parser accepts restored options and global options before commands', () => {
  assert.deepEqual(parseCli([
    '--root', '/tmp/example',
    'auth',
    '--node-auth-token', 'node-secret',
    '--github-token', 'github-secret',
    '--control-plane-url', 'https://control.example',
    '--repo', 'owner/repo',
    '--open',
    '--skip-verify',
    '--json',
  ]), {
    command: 'auth',
    options: {
      root: '/tmp/example',
      'node-auth-token': 'node-secret',
      'github-token': 'github-secret',
      'control-plane-url': 'https://control.example',
      repo: 'owner/repo',
      open: true,
      'skip-verify': true,
      json: true,
    },
  });
  assert.deepEqual(parseCli([
    'server:restart',
    '--detached',
    '--foreground',
    '--keep-old-terminal',
  ]).options, {
    detached: true,
    foreground: true,
    'keep-old-terminal': true,
  });
});

test('init, refresh, and status use the minimal custom-agent scaffold', async () => {
  const rootDir = makeRoot();
  try {
    const initialized = await captureConsole(() => cliMain([
      'init', '--root', rootDir, '--json',
    ]));
    const initPayload = JSON.parse(initialized.stdout);
    assert.equal(initPayload.rootDir, fs.realpathSync(rootDir));
    assert.equal(initPayload.agentCount, 0);
    assert.equal(initialized.lines.length, 1);

    const configPath = path.join(
      rootDir,
      'prompts',
      'autonomous',
      'v2',
      'config',
      'custom-agents.json'
    );
    const customConfig = {
      schemaVersion: 1,
      enabled: false,
      kind: 'fixture-kind',
      agents: [],
    };
    fs.writeFileSync(configPath, `${JSON.stringify(customConfig, null, 2)}\n`, 'utf8');

    const refreshed: any = await cliMain(['refresh', '--root', rootDir]);
    assert.equal(refreshed.refreshed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), customConfig);

    const status: any = await cliMain(['status', '--root', rootDir, '--sync']);
    assert.equal(status.initialized, true);
    assert.equal(status.synced, true);
    assert.equal(status.config.enabled, false);
    assert.equal(status.server.running, false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('auth JSON output is one parseable secret-free document', async () => {
  const rootDir = makeRoot();
  const nodeSecret = 'node-cli-secret-sentinel';
  const githubSecret = 'github-cli-secret-sentinel';
  try {
    await withEnvironment({
      AUTONOMY_INITIALIZED: undefined,
      NODE_AUTH_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      AUTONOMY_CONTROL_PLANE_SERVER_URL: undefined,
    }, async () => {
      const output = await captureConsole(() => cliMain([
        'auth',
        '--root', rootDir,
        '--repo', 'owner/repository',
        '--node-auth-token', nodeSecret,
        '--github-token', githubSecret,
        '--control-plane-url', 'https://control.example.test',
        '--skip-verify',
        '--json',
      ]));
      const payload = JSON.parse(output.stdout);
      assert.equal(output.lines.length, 1);
      assert.equal(payload.verification.github.status, 'skipped');
      assert.doesNotMatch(output.stdout, new RegExp(`${nodeSecret}|${githubSecret}`));
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('status sync clears an expired decision reservation without starting work', async () => {
  const fixture = writeFluxborneFixture(makeRoot());
  writeJson(path.join(fixture.rootDir, '.autonomy', 'runtime', 'state', 'runtime.json'), {
    schemaVersion: 1,
    customAgents: {
      'game-agent:fluxborne': {
        agentId: 'game-agent',
        runtimeKey: 'game-agent:fluxborne',
        baseRuntimeKey: 'game-agent:fluxborne',
        parallelSlot: 1,
        parallelism: 1,
        enabled: true,
        status: 'idle',
        running: false,
        pid: null,
        target: { type: 'repository', id: 'fluxborne' },
        workspacePath: fixture.workspace,
        singletonKey: 'agent.id',
        singletonValue: 'game-agent',
        intervalSeconds: 10,
        phase: 'deciding',
        lastPollAt: new Date().toISOString(),
        lastDecision: 'pending',
        lastDecisionReason: 'decision command running',
        decisionToken: 'expired-token',
        decisionExpiresAt: new Date(Date.now() - 5_000).toISOString(),
      },
    },
    customAgentInvocations: {
      'stale-invocation': {
        invocationId: 'stale-invocation',
        runtimeKey: 'game-agent:fluxborne',
        agentId: 'game-agent',
        status: 'running',
        phase: 'run',
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        updatedAt: new Date(Date.now() - 120_000).toISOString(),
        target: { jobId: 'stale-job' },
        workspace: { cwd: fixture.workspace },
        paths: { invocationDir: fixture.workspace, contextPath: fixture.workspace },
        lastError: null,
      },
    },
  });

  const result: any = await cliMain(['status', '--root', fixture.rootDir, '--sync']);
  const runtime = loadRuntime(fixture.rootDir);
  const agent = runtime.customAgents['game-agent:fluxborne'];
  assert.equal(result.synced, true);
  assert.equal(agent.phase, 'idle');
  assert.equal(agent.lastDecision, 'expired');
  assert.equal(agent.decisionToken, undefined);
  assert.equal(agent.decisionExpiresAt, undefined);
  assert.equal(agent.running, false);
  assert.equal(runtime.customAgentInvocations['stale-invocation'].status, 'failed');
  assert.equal(runtime.customAgentInvocations['stale-invocation'].phase, 'failed');
  assert.equal(result.runtime.invocationCounts.running, 0);
  assert.equal(result.runtime.invocationCounts.failed, 1);
});

test('server discovery ignores unrelated processes with a server-like argument', async () => {
  const rootDir = makeRoot();
  const decoy = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1000)',
    'autonomy-v2-server',
  ], {
    cwd: rootDir,
    stdio: 'ignore',
  });
  try {
    await waitUntil(() => Boolean(decoy.pid && isProcessAlive(decoy.pid)));
    assert.equal(getServerStatus(rootDir).running, false);
    const stopped = await killServer(rootDir);
    assert.equal(stopped.alreadyStopped, true);
    assert.equal(Boolean(decoy.pid && isProcessAlive(decoy.pid)), true);
  } finally {
    if (decoy.pid && isProcessAlive(decoy.pid)) decoy.kill('SIGKILL');
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('an explicit different root cannot be overridden by the process cwd', async () => {
  const parentRoot = makeRoot();
  const cwdRoot = path.join(parentRoot, 'cwd-root');
  const serverRoot = path.join(parentRoot, 'server-root');
  fs.mkdirSync(cwdRoot, { recursive: true });
  fs.mkdirSync(serverRoot, { recursive: true });
  const binary = fileURLToPath(new URL('../bin/autonomy-v2-server.js', import.meta.url));
  const child = spawn(process.execPath, [
    binary,
    'serve',
    '--root',
    serverRoot,
  ], {
    cwd: cwdRoot,
    stdio: 'ignore',
  });
  try {
    await waitUntil(() => getServerStatus(serverRoot).running);
    assert.equal(getServerStatus(cwdRoot).running, false);
    const wrongRootKill = await killServer(cwdRoot);
    assert.equal(wrongRootKill.alreadyStopped, true);
    assert.equal(Boolean(child.pid && isProcessAlive(child.pid)), true);
    assert.equal(getServerStatus(serverRoot).running, true);
  } finally {
    await killServer(serverRoot);
    if (child.pid && isProcessAlive(child.pid)) child.kill('SIGKILL');
    fs.rmSync(parentRoot, { recursive: true, force: true });
  }
});

test('real and symlinked roots share one canonical server owner', async () => {
  const parentRoot = makeRoot();
  const realRoot = path.join(parentRoot, 'real-root');
  const aliasRoot = path.join(parentRoot, 'alias-root');
  fs.mkdirSync(realRoot, { recursive: true });
  fs.symlinkSync(realRoot, aliasRoot, 'dir');
  let pid = 0;
  try {
    const started: any = await startServer(realRoot, { detached: true });
    pid = Number(started.pid);
    const throughAlias: any = await startServer(aliasRoot, { detached: true });
    assert.equal(throughAlias.started, false);
    assert.equal(throughAlias.alreadyRunning, true);
    assert.equal(throughAlias.pid, pid);
    assert.equal(getServerStatus(aliasRoot).pid, pid);
    assert.equal(getServerStatus(aliasRoot).pids.length, 1);
  } finally {
    await killServer(aliasRoot);
    if (pid && isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    fs.rmSync(parentRoot, { recursive: true, force: true });
  }
});

test('server lifecycle is root-scoped across start, restart, status, and kill', async () => {
  const parentRoot = makeRoot();
  const targetRoot = path.join(parentRoot, 'app');
  const decoyRoot = path.join(targetRoot, 'nested-repository');
  fs.mkdirSync(decoyRoot, { recursive: true });
  let targetPid = 0;
  let decoyPid = 0;
  try {
    const decoy: any = await startServer(decoyRoot, { detached: true });
    decoyPid = Number(decoy.pid);
    assert.equal(decoy.started, true);
    assert.equal(isProcessAlive(decoyPid), true);

    const staleLockPath = path.join(targetRoot, '.autonomy', 'server-lock', 'owner.json');
    fs.mkdirSync(path.dirname(staleLockPath), { recursive: true });
    fs.writeFileSync(staleLockPath, `${JSON.stringify({
      pid: process.pid,
      token: 'stale-reused-pid',
      startedAt: new Date().toISOString(),
    })}\n`, 'utf8');
    const target: any = await startServer(targetRoot, { detached: true });
    targetPid = Number(target.pid);
    assert.equal(target.started, true);
    assert.equal(isProcessAlive(targetPid), true);

    const restarted: any = await runServerCommand(
      targetRoot,
      { detached: true },
      'server:restart'
    );
    assert.equal(restarted.ok, true);
    assert.equal(restarted.action, 'restart');
    assert.notEqual(restarted.pid, targetPid);
    assert.equal(isProcessAlive(targetPid), false);
    targetPid = Number(restarted.pid);
    assert.equal(isProcessAlive(targetPid), true);

    const decoyStatus = getServerStatus(decoyRoot);
    assert.equal(decoyStatus.running, true);
    assert.equal(decoyStatus.pid, decoyPid);
    assert.equal(isProcessAlive(decoyPid), true);

    const stopped: any = await runServerCommand(targetRoot, {}, 'server:kill');
    assert.equal(stopped.ok, true);
    assert.equal(stopped.stopped, true);
    assert.equal(getServerStatus(targetRoot).running, false);
    assert.equal(isProcessAlive(decoyPid), true);
  } finally {
    await killServer(targetRoot);
    await killServer(decoyRoot);
    if (targetPid && isProcessAlive(targetPid)) process.kill(targetPid, 'SIGKILL');
    if (decoyPid && isProcessAlive(decoyPid)) process.kill(decoyPid, 'SIGKILL');
    fs.rmSync(parentRoot, { recursive: true, force: true });
  }
});

test('server kill recovers a malformed owner lock when no server exists', async () => {
  const rootDir = makeRoot();
  const lockDir = path.join(rootDir, '.autonomy', 'server-lock');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), '{not-json', 'utf8');
  const old = new Date(Date.now() - 5_000);
  fs.utimesSync(lockDir, old, old);
  try {
    const result = await killServer(rootDir);
    assert.equal(result.ok, true);
    assert.equal(result.alreadyStopped, true);
    assert.equal(fs.existsSync(lockDir), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('server start validates an explicit config before spawning', async () => {
  const rootDir = makeRoot();
  try {
    await assert.rejects(
      startServer(rootDir, { config: 'missing-custom-agents.json' }),
      /Custom-agent config does not exist/
    );
    assert.equal(getServerStatus(rootDir).running, false);
  } finally {
    await killServer(rootDir);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('concurrent starts serialize to one server owner', async () => {
  const rootDir = makeRoot();
  try {
    const results: any[] = await Promise.all(
      Array.from({ length: 5 }, () => startServer(rootDir, { detached: true }))
    );
    assert.equal(results.filter((result) => result.started).length, 1);
    assert.equal(results.filter((result) => result.alreadyRunning).length, 4);
    assert.equal(new Set(results.map((result) => result.pid)).size, 1);
    assert.equal(getServerStatus(rootDir).running, true);
  } finally {
    await killServer(rootDir);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

async function captureConsole(callback: () => unknown | Promise<unknown>) {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...values: unknown[]) => {
    lines.push(values.map((value) => String(value)).join(' '));
  };
  try {
    const result = await callback();
    return { result, lines, stdout: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms.`);
}
