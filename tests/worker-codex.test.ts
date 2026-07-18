import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexArgs, runCodex } from '../src/custom-agents/codex.js';
import {
  buildLifecycleEnvelope,
  finalizeRuntime,
  runCustomAgent,
} from '../src/custom-agents/worker.js';
import { loadRuntime } from '../src/runtime.js';
import {
  makeRoot,
  withEnvironment,
  writeExecutable,
  writeJson,
} from './helpers.js';

test('fresh conversations are ephemeral and scoped conversations can resume', () => {
  const base = {
    cwd: '/tmp/workspace',
    prompt: 'work',
    sandboxMode: 'workspace-write' as const,
  };
  assert.ok(buildCodexArgs(base).includes('--ephemeral'));
  assert.ok(buildCodexArgs(base).includes('--skip-git-repo-check'));
  const resumed = buildCodexArgs({
    ...base,
    persistConversation: true,
    resumeSessionId: 'thread-123',
  });
  assert.ok(resumed.includes('--json'));
  assert.deepEqual(resumed.slice(-3), ['resume', 'thread-123', '-']);
});

test('captures an early conversation id before later verbose output is trimmed', async () => {
  const rootDir = makeRoot();
  const fakeCodex = `${rootDir}/fake-codex`;
  writeExecutable(fakeCodex, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ thread_id: 'thread-early' }) + '\\n');
  process.stdout.write('x'.repeat(80 * 1024));
});
`);
  await withEnvironment({ AUTONOMY_CODEX_BIN: fakeCodex }, async () => {
    const result = await runCodex({
      cwd: rootDir,
      prompt: 'work',
      sandboxMode: 'workspace-write',
      persistConversation: true,
    });
    assert.equal(result.conversationId, 'thread-early');
  });
});

test('lifecycle envelopes preserve the Fluxborne protocol fields', () => {
  const envelope = buildLifecycleEnvelope({
    invocationId: 'invocation-1',
    rootDir: '/repo',
    kind: 'game-agents',
    agent: { id: 'game-agent' },
    target: { jobId: 'job-1' },
    workspacePath: '/repo/workspace',
    paths: { contextPath: '/repo/context.json' },
    decision: { jobId: 'job-1' },
  }, 'finalize', {
    workspacePath: '/repo/workspace',
    previous: { environment: { ready: true } },
    run: { status: 'completed' },
  });
  assert.equal(envelope.invocationId, 'invocation-1');
  assert.equal(envelope.repoRoot, '/repo');
  assert.equal(envelope.decision.jobId, 'job-1');
  assert.equal(envelope.previous.environment.ready, true);
  assert.equal(envelope.run.status, 'completed');
});

test('a repo-defined prompt can execute without any lifecycle defaults', async () => {
  const rootDir = makeRoot();
  const workspacePath = `${rootDir}/workspace`;
  const calls: Array<Parameters<typeof runCodex>[0]> = [];
  const result = await runCustomAgent({
    invocationId: 'invocation-1',
    runtimeKey: 'agent:repo',
    rootDir,
    kind: 'test',
    agent: { id: 'agent', instructions: 'do the work' },
    target: { id: 'repo' },
    workspacePath,
    paths: {},
    decision: { shouldRun: true },
    context: { allowRuntimeStateChanges: false },
    conversation: { mode: 'fresh', persist: false },
    lifecycle: {},
  }, {
    codexRunner: async (options) => {
      calls.push(options);
      return { conversationId: '' };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(calls[0].sandboxMode, 'workspace-write');
  assert.match(calls[0].prompt, /do the work/);
});

test('repo lifecycle hooks can return prompts larger than the log capture window', async () => {
  const rootDir = makeRoot();
  const workspacePath = `${rootDir}/workspace`;
  const promptScript = `${rootDir}/large-prompt.mjs`;
  const promptLength = 70 * 1024;
  writeExecutable(promptScript, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ prompt: 'x'.repeat(${promptLength}) }));
});
`);
  let observedPrompt = '';
  await runCustomAgent({
    invocationId: 'large-prompt-invocation',
    runtimeKey: 'agent:large-prompt',
    rootDir,
    kind: 'test',
    agent: { id: 'agent' },
    target: { id: 'large-prompt' },
    workspacePath,
    paths: {},
    decision: { shouldRun: true },
    context: { allowRuntimeStateChanges: false },
    conversation: { mode: 'fresh', persist: false },
    lifecycle: {
      prompt: {
        command: process.execPath,
        args: [promptScript],
        cwd: rootDir,
        env: {},
        shell: false,
        timeoutMs: 5_000,
      },
    },
  }, {
    codexRunner: async (options) => {
      observedPrompt = options.prompt;
      return { conversationId: '' };
    },
  });
  assert.equal(observedPrompt.length, promptLength);
});

test('a stale worker cannot clear a newer invocation status', () => {
  const rootDir = makeRoot();
  writeJson(`${rootDir}/.autonomy/runtime/state/runtime.json`, {
    schemaVersion: 1,
    customAgents: {
      'agent:repo': {
        agentId: 'agent',
        runtimeKey: 'agent:repo',
        enabled: true,
        status: 'running',
        running: true,
        pid: 123,
        target: { id: 'repo' },
        workspacePath: `${rootDir}/workspace`,
        singletonKey: 'agent.id',
        singletonValue: 'agent',
        intervalSeconds: 10,
        invocationId: 'new-invocation',
      },
    },
    customAgentInvocations: {
      'old-invocation': {
        invocationId: 'old-invocation',
        runtimeKey: 'agent:repo',
        agentId: 'agent',
        status: 'running',
        phase: 'run',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        target: { id: 'repo' },
        workspace: { cwd: `${rootDir}/workspace` },
        paths: { invocationDir: '', contextPath: '' },
        lastError: null,
      },
    },
  });
  finalizeRuntime({
    rootDir,
    runtimeKey: 'agent:repo',
    invocationId: 'old-invocation',
  }, { status: 'completed' }, null);
  const runtime = loadRuntime(rootDir);
  assert.equal(runtime.customAgents['agent:repo'].running, true);
  assert.equal(runtime.customAgents['agent:repo'].invocationId, 'new-invocation');
  assert.equal(runtime.customAgentInvocations['old-invocation'].status, 'completed');
});
