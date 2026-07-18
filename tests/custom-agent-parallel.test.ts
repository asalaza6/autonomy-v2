import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCustomAgentConfig } from '../src/custom-agents/config.js';
import {
  listConfiguredCustomAgents,
  runSchedulerTick,
} from '../src/custom-agents/scheduler.js';
import { buildLifecycleEnvelope } from '../src/custom-agents/worker.js';
import { loadRuntime, writeRuntime } from '../src/runtime.js';
import type { JsonRecord, RuntimeState } from '../src/types.js';
import {
  makeRoot,
  writeExecutable,
  writeJson,
} from './helpers.js';

type ParallelFixtureOptions = {
  parallelism?: unknown;
  decisionDelayMs?: number;
};

function writeParallelFixture(
  rootDir: string,
  options: ParallelFixtureOptions = {}
) {
  const scriptsDir = path.join(rootDir, 'scripts', 'parallel-agent');
  const stateDir = path.join(rootDir, '.parallel-agent-test');
  const decisionPath = path.join(scriptsDir, 'should-run.mjs');
  const decisionLog = path.join(stateDir, 'decisions.jsonl');
  const workspace = path.join('.autonomy', 'runtime', 'parallel-agent');
  writeExecutable(decisionPath, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const envelope = JSON.parse(fs.readFileSync(0, 'utf8'));
const slot = Number(envelope.parallel?.slot);
const total = Number(envelope.parallel?.total);
if (!Number.isInteger(slot) || slot < 1 || !Number.isInteger(total) || total < slot) {
  process.stderr.write('missing parallel slot metadata\\n');
  process.exit(2);
}

fs.mkdirSync(process.env.PARALLEL_TEST_STATE_DIR, { recursive: true });
const countPath = path.join(process.env.PARALLEL_TEST_STATE_DIR, 'slot-' + slot + '.count');
const previous = fs.existsSync(countPath)
  ? Number(fs.readFileSync(countPath, 'utf8'))
  : 0;
const count = previous + 1;
fs.writeFileSync(countPath, String(count));
fs.appendFileSync(process.env.PARALLEL_TEST_DECISION_LOG, JSON.stringify({
  runtimeKey: envelope.runtimeKey,
  parallel: envelope.parallel,
  slot,
  total,
  count,
  env: {
    runtimeKey: process.env.AUTONOMY_CUSTOM_AGENT_RUNTIME_KEY,
    baseRuntimeKey: process.env.AUTONOMY_CUSTOM_AGENT_BASE_RUNTIME_KEY,
    slot: process.env.AUTONOMY_CUSTOM_AGENT_SLOT,
    parallelism: process.env.AUTONOMY_CUSTOM_AGENT_PARALLELISM,
  },
}) + '\\n');

const delayMs = Number(process.env.PARALLEL_TEST_DECISION_DELAY_MS || 0);
if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
process.stdout.write(JSON.stringify({
  shouldRun: true,
  reason: 'parallel fixture selected work',
  target: { jobId: 'job-' + slot + '-' + count },
  selectedSlot: slot,
  selectedTotal: total,
}) + '\\n');
`);

  const spawn: JsonRecord = {
    mode: 'poll',
    intervalSeconds: 1,
    singletonKey: 'agent.id',
    decision: {
      mode: 'command',
      command: process.execPath,
      args: [decisionPath],
      env: {
        PARALLEL_TEST_STATE_DIR: stateDir,
        PARALLEL_TEST_DECISION_LOG: decisionLog,
        PARALLEL_TEST_DECISION_DELAY_MS: String(options.decisionDelayMs || 0),
      },
      timeoutMs: 5_000,
    },
  };
  if (options.parallelism !== undefined) {
    spawn.parallelism = options.parallelism;
  }
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
    kind: 'parallel-test-agents',
    agents: [{
      id: 'worker',
      enabled: true,
      target: { type: 'repository', id: 'fixture' },
      workspace,
      spawn,
      conversation: { mode: 'fresh' },
    }],
  });
  return { decisionLog, stateDir, workspace };
}

function liveSpawner() {
  const child = new EventEmitter() as ChildProcess;
  Object.defineProperty(child, 'pid', { value: process.pid });
  return child;
}

function decisionEntries(filePath: string) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function completeInvocation(
  rootDir: string,
  runtimeKey: string,
  invocationId: string,
  at = '2026-07-17T12:01:00.000Z'
) {
  const runtime = loadRuntime(rootDir);
  const status = runtime.customAgents[runtimeKey];
  assert.ok(status);
  assert.equal(status.invocationId, invocationId);
  Object.assign(status, {
    status: 'idle',
    running: false,
    pid: null,
    phase: 'completed',
    finishedAt: at,
  });
  const invocation = runtime.customAgentInvocations[invocationId];
  assert.ok(invocation);
  Object.assign(invocation, {
    status: 'completed',
    phase: 'completed',
    updatedAt: at,
    finishedAt: at,
  });
  writeRuntime(rootDir, runtime);
}

test('parallel custom agents remain opt-in and default to one stable runtime key', () => {
  const rootDir = makeRoot();
  const fixture = writeParallelFixture(rootDir);
  const config = loadCustomAgentConfig(rootDir);

  assert.ok(config);
  assert.equal(config.agents.length, 1);
  assert.deepEqual(config.agents.map((agent) => ({
    runtimeKey: agent.runtimeKey,
    baseRuntimeKey: agent.baseRuntimeKey,
    parallelSlot: agent.parallelSlot,
    parallelism: agent.parallelism,
    workspace: agent.workspace,
  })), [{
    runtimeKey: 'worker:fixture',
    baseRuntimeKey: 'worker:fixture',
    parallelSlot: 1,
    parallelism: 1,
    workspace: fixture.workspace,
  }]);
});

test('parallelism rejects zero, negative, fractional, nonnumeric, and excessive values', () => {
  for (const value of [0, -1, 1.5, 'many', 33]) {
    const rootDir = makeRoot();
    writeParallelFixture(rootDir, { parallelism: value });
    assert.throws(
      () => loadCustomAgentConfig(rootDir),
      /worker\.spawn\.parallelism must be an integer between 1 and 32/,
      `expected ${JSON.stringify(value)} to be rejected`
    );
  }
});

test('parallelism rejects a repository-root workspace that cannot be isolated', () => {
  const rootDir = makeRoot();
  writeParallelFixture(rootDir, { parallelism: 2 });
  const configPath = path.join(
    rootDir,
    'prompts',
    'autonomous',
    'v2',
    'config',
    'custom-agents.json'
  );
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.agents[0].workspace = '.';
  writeJson(configPath, config);
  assert.throws(
    () => loadCustomAgentConfig(rootDir),
    /parallelism cannot exceed 1 when its workspace is the repository root/
  );
});

test('an opted-in pool starts N distinct decision-selected tasks in stable slots', async () => {
  const rootDir = makeRoot();
  const canonicalRoot = fs.realpathSync(rootDir);
  writeParallelFixture(rootDir, { parallelism: 3 });
  const config = loadCustomAgentConfig(rootDir);
  assert.ok(config);

  assert.deepEqual(config.agents.map((agent) => agent.runtimeKey), [
    'worker:fixture',
    'worker:fixture#2',
    'worker:fixture#3',
  ]);
  assert.deepEqual(config.agents.map((agent) => agent.parallelSlot), [1, 2, 3]);
  assert.deepEqual(config.agents.map((agent) => path.relative(canonicalRoot, agent.workspacePath)), [
    '.autonomy/runtime/parallel-agent-slots/slot-1',
    '.autonomy/runtime/parallel-agent-slots/slot-2',
    '.autonomy/runtime/parallel-agent-slots/slot-3',
  ]);

  const result = await runSchedulerTick(rootDir, {
    force: true,
    now: new Date('2026-07-17T12:00:00.000Z'),
    spawner: liveSpawner,
  });

  assert.equal(result.started.length, 3);
  assert.deepEqual(result.started.map((entry) => entry.runtimeKey), [
    'worker:fixture',
    'worker:fixture#2',
    'worker:fixture#3',
  ]);
  assert.deepEqual(result.started.map((entry) => entry.parallelSlot), [1, 2, 3]);
  assert.deepEqual(result.started.map((entry) => entry.parallelism), [3, 3, 3]);
  assert.deepEqual(result.started.map((entry) => entry.target.jobId).sort(), [
    'job-1-1',
    'job-2-1',
    'job-3-1',
  ]);
  assert.equal(new Set(result.started.map((entry) => entry.invocationId)).size, 3);
  const decisions = decisionEntries(path.join(
    rootDir,
    '.parallel-agent-test',
    'decisions.jsonl'
  ));
  decisions.forEach((entry) => {
    assert.equal(entry.env.runtimeKey, entry.runtimeKey);
    assert.equal(entry.env.baseRuntimeKey, 'worker:fixture');
    assert.equal(entry.env.slot, String(entry.slot));
    assert.equal(entry.env.parallelism, '3');
  });

  const listed = listConfiguredCustomAgents(rootDir);
  assert.deepEqual(listed.map((entry) => entry.runtimeKey), ['worker:fixture']);
  assert.equal(listed[0].parallelism, 3);
  assert.equal(listed[0].runningCount, 3);
  assert.deepEqual(listed[0].slots.map((slot) => slot.runtimeKey), [
    'worker:fixture',
    'worker:fixture#2',
    'worker:fixture#3',
  ]);

  for (const start of result.started) {
    const invocation = result.runtime.customAgentInvocations[start.invocationId];
    assert.deepEqual(invocation.parallel, { slot: start.parallelSlot, total: 3 });
    const context = JSON.parse(fs.readFileSync(invocation.paths.contextPath, 'utf8'));
    assert.deepEqual(context.parallel, { slot: start.parallelSlot, total: 3 });
    assert.equal(context.decision.selectedSlot, start.parallelSlot);
    assert.equal(context.decision.selectedTotal, 3);
    const envelope = buildLifecycleEnvelope(context, 'environment', {
      workspacePath: context.workspacePath,
    });
    assert.deepEqual(envelope.parallel, { slot: start.parallelSlot, total: 3 });
  }
});

test('concurrent ticks reserve each slot once and a full pool runs no decisions', async () => {
  const rootDir = makeRoot();
  const fixture = writeParallelFixture(rootDir, {
    parallelism: 2,
    decisionDelayMs: 150,
  });

  const [first, second] = await Promise.all([
    runSchedulerTick(rootDir, { force: true, spawner: liveSpawner }),
    runSchedulerTick(rootDir, { force: true, spawner: liveSpawner }),
  ]);
  assert.equal(first.started.length + second.started.length, 2);
  assert.equal(new Set([
    ...first.started.map((entry) => entry.runtimeKey),
    ...second.started.map((entry) => entry.runtimeKey),
  ]).size, 2);
  assert.equal(decisionEntries(fixture.decisionLog).length, 2);

  const fullTick = await runSchedulerTick(rootDir, {
    force: true,
    spawner: liveSpawner,
  });
  assert.equal(fullTick.started.length, 0);
  assert.equal(decisionEntries(fixture.decisionLog).length, 2);
});

test('live scale-up keeps the single-worker workspace outside the new pool', async () => {
  const rootDir = makeRoot();
  const fixture = writeParallelFixture(rootDir, { parallelism: 1 });
  const initial = await runSchedulerTick(rootDir, {
    force: true,
    spawner: liveSpawner,
  });
  assert.equal(initial.started.length, 1);
  const legacyWorkspace = path.join(fs.realpathSync(rootDir), fixture.workspace);
  assert.equal(
    loadRuntime(rootDir).customAgents['worker:fixture'].workspacePath,
    legacyWorkspace
  );

  writeParallelFixture(rootDir, { parallelism: 2 });
  const scaled = await runSchedulerTick(rootDir, {
    force: true,
    spawner: liveSpawner,
  });
  assert.deepEqual(scaled.started.map((entry) => entry.runtimeKey), ['worker:fixture#2']);

  const runtime = loadRuntime(rootDir);
  const legacy = runtime.customAgents['worker:fixture'];
  const peer = runtime.customAgents['worker:fixture#2'];
  assert.equal(legacy.running, true);
  assert.equal(legacy.parallelism, 1);
  assert.equal(legacy.workspacePath, legacyWorkspace);
  assert.equal(peer.running, true);
  assert.equal(
    peer.workspacePath,
    path.join(`${legacyWorkspace}-slots`, 'slot-2')
  );
  assert.match(path.relative(legacy.workspacePath, peer.workspacePath), /^\.\.[/\\]/);
});

test('live scale-down reports and fences a retired slot until it drains', async () => {
  const rootDir = makeRoot();
  writeParallelFixture(rootDir, { parallelism: 2 });
  const initial = await runSchedulerTick(rootDir, {
    force: true,
    spawner: liveSpawner,
  });
  assert.equal(initial.started.length, 2);
  const slotOne = initial.started.find((entry) => entry.parallelSlot === 1);
  const slotTwo = initial.started.find((entry) => entry.parallelSlot === 2);
  assert.ok(slotOne);
  assert.ok(slotTwo);
  completeInvocation(rootDir, slotOne.runtimeKey, slotOne.invocationId);

  writeParallelFixture(rootDir, { parallelism: 1 });
  const [listed] = listConfiguredCustomAgents(rootDir);
  assert.equal(listed.parallelism, 1);
  assert.equal(listed.running, true);
  assert.equal(listed.runningCount, 1);
  assert.deepEqual(listed.slots.map((slot) => ({
    runtimeKey: slot.runtimeKey,
    configured: slot.configured,
    running: slot.running,
  })), [
    { runtimeKey: 'worker:fixture', configured: true, running: false },
    { runtimeKey: 'worker:fixture#2', configured: false, running: true },
  ]);

  const fenced = await runSchedulerTick(rootDir, {
    force: true,
    spawner: liveSpawner,
  });
  assert.equal(fenced.started.length, 0);
  completeInvocation(rootDir, slotTwo.runtimeKey, slotTwo.invocationId);
  assert.deepEqual(
    listConfiguredCustomAgents(rootDir)[0].slots.map((slot) => slot.runtimeKey),
    ['worker:fixture']
  );
});

test('one synchronous spawn failure does not strand or suppress later pool slots', async () => {
  const rootDir = makeRoot();
  const fixture = writeParallelFixture(rootDir, { parallelism: 2 });
  await assert.rejects(
    () => runSchedulerTick(rootDir, {
      force: true,
      spawner: (_rootDir, entry) => {
        if (entry.parallelSlot === 1) throw new Error('fixture slot-one spawn failure');
        return liveSpawner();
      },
    }),
    /One or more custom-agent launches failed/
  );

  const runtime = loadRuntime(rootDir);
  const failed = runtime.customAgents['worker:fixture'];
  const running = runtime.customAgents['worker:fixture#2'];
  assert.equal(failed.running, false);
  assert.equal(failed.status, 'idle');
  assert.match(failed.lastError || '', /slot-one spawn failure/);
  assert.equal(runtime.customAgentInvocations[failed.invocationId as string].status, 'failed');
  assert.equal(running.running, true);
  assert.equal(running.status, 'running');
  assert.equal(runtime.customAgentInvocations[running.invocationId as string].status, 'running');
  assert.equal(decisionEntries(fixture.decisionLog).length, 2);
});

test('completing one slot refills exactly that slot while its peer remains active', async () => {
  const rootDir = makeRoot();
  const fixture = writeParallelFixture(rootDir, { parallelism: 2 });
  const initial = await runSchedulerTick(rootDir, {
    force: true,
    now: new Date('2026-07-17T12:00:00.000Z'),
    spawner: liveSpawner,
  });
  assert.equal(initial.started.length, 2);
  const completed = initial.started.find((entry) => entry.parallelSlot === 1);
  const peer = initial.started.find((entry) => entry.parallelSlot === 2);
  assert.ok(completed);
  assert.ok(peer);
  completeInvocation(rootDir, completed.runtimeKey, completed.invocationId);

  const refill = await runSchedulerTick(rootDir, {
    force: true,
    now: new Date('2026-07-17T12:02:00.000Z'),
    spawner: liveSpawner,
  });
  assert.equal(refill.started.length, 1);
  assert.equal(refill.started[0].runtimeKey, completed.runtimeKey);
  assert.equal(refill.started[0].parallelSlot, 1);
  assert.equal(refill.started[0].target.jobId, 'job-1-2');
  assert.equal(
    loadRuntime(rootDir).customAgents[peer.runtimeKey].invocationId,
    peer.invocationId
  );
  assert.equal(decisionEntries(fixture.decisionLog).length, 3);
});

test('a manual-style base runtime key starts at most one available pool slot', async () => {
  const rootDir = makeRoot();
  writeParallelFixture(rootDir, { parallelism: 3 });
  const options = {
    runtimeKey: 'worker:fixture',
    force: true,
    maxStarts: 1,
    spawner: liveSpawner,
  } as Parameters<typeof runSchedulerTick>[1] & { maxStarts: number };

  const first = await runSchedulerTick(rootDir, options);
  assert.equal(first.started.length, 1);
  assert.equal(first.started[0].runtimeKey, 'worker:fixture');

  const second = await runSchedulerTick(rootDir, options);
  assert.equal(second.started.length, 1);
  assert.equal(second.started[0].runtimeKey, 'worker:fixture#2');

  const runtime = loadRuntime(rootDir) as RuntimeState;
  assert.equal(Object.values(runtime.customAgentInvocations)
    .filter((invocation) => invocation.status === 'running').length, 2);
});

test('parallel slots coexist only within their logical pool under a shared singleton', async () => {
  const rootDir = makeRoot();
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
    agents: ['first', 'second'].map((id) => ({
      id,
      target: { type: 'shared-resource', id },
      workspace: `.autonomy/runtime/${id}`,
      spawn: {
        mode: 'poll',
        parallelism: 2,
        singletonKey: 'target.type',
        decision: { mode: 'always' },
      },
    })),
  });

  const result = await runSchedulerTick(rootDir, {
    force: true,
    spawner: liveSpawner,
  });
  assert.deepEqual(result.started.map((entry) => entry.baseRuntimeKey), [
    'first:first',
    'first:first',
  ]);
  assert.equal(result.runtime.customAgents['second:second'].lastDecision, 'blocked');
  assert.equal(result.runtime.customAgents['second:second#2'].lastDecision, 'blocked');
});
