import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCustomAgentConfig } from '../src/custom-agents/config.js';
import { runSchedulerTick } from '../src/custom-agents/scheduler.js';
import { loadRuntime, writeRuntime } from '../src/runtime.js';
import type { JsonRecord } from '../src/types.js';
import { makeRoot, writeExecutable, writeJson } from './helpers.js';

type AgentDefinition = {
  id: string;
  targetId: string;
  intervalSeconds?: number;
  singletonKey?: string;
  decision?: JsonRecord;
};

function writeAgentConfig(rootDir: string, agents: AgentDefinition[]) {
  writeJson(path.join(
    rootDir,
    'prompts',
    'autonomous',
    'v2',
    'config',
    'custom-agents.json'
  ), {
    schemaVersion: 1,
    enabled: true,
    agents: agents.map((agent, index) => ({
      id: agent.id,
      enabled: true,
      target: { type: 'repository', id: agent.targetId },
      workspace: path.join('.autonomy', 'runtime', 'workspaces', String(index)),
      spawn: {
        mode: 'poll',
        intervalSeconds: agent.intervalSeconds ?? 60,
        singletonKey: agent.singletonKey ?? 'target.id',
        decision: agent.decision ?? { mode: 'always' },
      },
      conversation: { mode: 'fresh' },
    })),
  });
}

function inertSpawner() {
  return new EventEmitter() as unknown as ChildProcess;
}

test('runtime keys that slugify identically get distinct invocations in the same tick', async () => {
  const rootDir = makeRoot();
  writeAgentConfig(rootDir, [
    { id: 'a-b', targetId: 'c' },
    { id: 'a', targetId: 'b-c' },
  ]);

  const result = await runSchedulerTick(rootDir, {
    now: new Date('2026-07-17T12:00:00.000Z'),
    spawner: inertSpawner,
  });

  assert.equal(result.started.length, 2);
  assert.equal(new Set(result.started.map((entry) => entry.invocationId)).size, 2);
  assert.equal(Object.keys(result.runtime.customAgentInvocations).length, 2);
  assert.equal(new Set(Object.values(result.runtime.customAgentInvocations)
    .map((entry) => entry.paths.contextPath)).size, 2);
});

test('a thrown decision command is recorded without preventing other agents from running', async () => {
  const rootDir = makeRoot();
  writeAgentConfig(rootDir, [
    {
      id: 'throws',
      targetId: 'bad-decision',
      decision: {
        mode: 'command',
        command: process.execPath,
        args: ['argument-with-a-null-byte\0'],
      },
    },
    { id: 'healthy', targetId: 'healthy-decision' },
  ]);

  const result = await runSchedulerTick(rootDir, {
    now: new Date('2026-07-17T12:01:00.000Z'),
    spawner: inertSpawner,
  });

  assert.deepEqual(result.started.map((entry) => entry.runtimeKey), [
    'healthy:healthy-decision',
  ]);
  const runtime = loadRuntime(rootDir);
  assert.equal(runtime.customAgents['throws:bad-decision'].lastDecision, 'error');
  assert.equal(runtime.customAgents['throws:bad-decision'].running, false);
  assert.equal(runtime.customAgents['healthy:healthy-decision'].running, true);
});

test('an expired decision reservation is retried even when its poll interval is not due', async () => {
  const rootDir = makeRoot();
  writeAgentConfig(rootDir, [{
    id: 'recover',
    targetId: 'expired-reservation',
    intervalSeconds: 600,
  }]);
  const config = loadCustomAgentConfig(rootDir);
  assert.ok(config);
  const agent = config.agents[0];
  writeRuntime(rootDir, {
    schemaVersion: 1,
    customAgents: {
      [agent.runtimeKey]: {
        agentId: agent.id,
        runtimeKey: agent.runtimeKey,
        enabled: true,
        status: 'idle',
        running: false,
        pid: null,
        target: agent.target,
        workspacePath: agent.workspacePath,
        singletonKey: agent.singletonKey,
        singletonValue: agent.singletonValue,
        intervalSeconds: agent.intervalSeconds,
        lastPollAt: '2026-07-17T12:01:59.500Z',
        phase: 'deciding',
        lastDecision: 'pending',
        decisionToken: 'abandoned-reservation',
        decisionExpiresAt: '2026-07-17T12:01:59.999Z',
      },
    },
    customAgentInvocations: {},
  });

  const result = await runSchedulerTick(rootDir, {
    now: new Date('2026-07-17T12:02:00.000Z'),
    spawner: inertSpawner,
  });

  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].runtimeKey, agent.runtimeKey);
  assert.equal(result.runtime.customAgents[agent.runtimeKey].running, true);
  assert.equal(result.runtime.customAgents[agent.runtimeKey].decisionToken, undefined);
});

test('agents sharing a singleton do not both execute side-effectful decision hooks', async () => {
  const rootDir = makeRoot();
  const decisionLog = path.join(rootDir, 'decision-hooks.jsonl');
  const decisionScript = path.join(rootDir, 'scripts', 'decision.mjs');
  writeExecutable(decisionScript, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.DECISION_LOG, JSON.stringify({ pid: process.pid }) + '\\n');
process.stdout.write(JSON.stringify({ shouldRun: true, reason: 'singleton work is ready' }) + '\\n');
`);
  const decision = {
    mode: 'command',
    command: process.execPath,
    args: [decisionScript],
    env: { DECISION_LOG: decisionLog },
  };
  writeAgentConfig(rootDir, [
    {
      id: 'shared-agent',
      targetId: 'first-target',
      singletonKey: 'agent.id',
      decision,
    },
    {
      id: 'shared-agent',
      targetId: 'second-target',
      singletonKey: 'agent.id',
      decision,
    },
  ]);

  const result = await runSchedulerTick(rootDir, {
    now: new Date('2026-07-17T12:03:00.000Z'),
    spawner: inertSpawner,
  });

  assert.equal(result.started.length, 1);
  const decisionRuns = fs.readFileSync(decisionLog, 'utf8').trim().split('\n');
  assert.equal(decisionRuns.length, 1);
});

test('a persisted singleton decision fences a concurrent scheduler tick', async () => {
  const rootDir = makeRoot();
  const decisionLog = path.join(rootDir, 'concurrent-decisions.jsonl');
  const decisionScript = path.join(rootDir, 'scripts', 'slow-decision.mjs');
  writeExecutable(decisionScript, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.DECISION_LOG, process.env.DECISION_LABEL + '\\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify({ shouldRun: true, reason: 'ready' }) + '\\n');
}, 250);
`);
  const decision = (label: string) => ({
    mode: 'command',
    command: process.execPath,
    args: [decisionScript],
    env: { DECISION_LOG: decisionLog, DECISION_LABEL: label },
    timeoutMs: 2_000,
  });
  writeAgentConfig(rootDir, [
    {
      id: 'shared-agent',
      targetId: 'first-target',
      singletonKey: 'agent.id',
      decision: decision('first'),
    },
    {
      id: 'shared-agent',
      targetId: 'second-target',
      singletonKey: 'agent.id',
      decision: decision('second'),
    },
  ]);

  const firstTick = runSchedulerTick(rootDir, { spawner: inertSpawner });
  await waitForFile(decisionLog);
  const secondTick = runSchedulerTick(rootDir, { spawner: inertSpawner });
  const [first, second] = await Promise.all([firstTick, secondTick]);

  assert.equal(first.started.length + second.started.length, 1);
  assert.deepEqual(fs.readFileSync(decisionLog, 'utf8').trim().split('\n'), ['first']);
});

async function waitForFile(filePath: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${filePath}`);
}
