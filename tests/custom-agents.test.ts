import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCustomAgentConfig } from '../src/custom-agents/config.js';
import {
  listConfiguredCustomAgents,
  runSchedulerTick,
} from '../src/custom-agents/scheduler.js';
import { loadRuntime } from '../src/runtime.js';
import {
  makeRoot,
  waitForChild,
  withEnvironment,
  writeFluxborneFixture,
} from './helpers.js';

test('loads the Fluxborne-shaped config directly without control-plane files', () => {
  const fixture = writeFluxborneFixture(makeRoot());
  const config = loadCustomAgentConfig(fixture.rootDir);
  assert.equal(config?.agents[0].runtimeKey, 'game-agent:fluxborne');
  assert.equal(config?.agents[0].singletonKey, 'agent.id');
  assert.equal(config?.agents[0].context.allowRuntimeStateChanges, true);
  assert.equal(fs.existsSync(path.join(fixture.rootDir, 'prompts/autonomous/v2/config/control-plane.json')), false);
  assert.deepEqual(
    listConfiguredCustomAgents(fixture.rootDir).map((agent) => agent.runtimeKey),
    ['game-agent:fluxborne']
  );
});

test('a skipped local decision records state and starts no process', async () => {
  const fixture = writeFluxborneFixture(makeRoot(), { shouldRun: false });
  const result = await runSchedulerTick(fixture.rootDir);
  assert.equal(result.started.length, 0);
  const status = loadRuntime(fixture.rootDir).customAgents['game-agent:fluxborne'];
  assert.equal(status.lastDecision, 'skip');
  assert.equal(status.lastDecisionReason, 'fixture decision');
  assert.equal(status.running, false);
});

test('runs the complete repo-owned lifecycle in a directory with no Git metadata', async () => {
  const fixture = writeFluxborneFixture(makeRoot());
  assert.equal(fs.existsSync(path.join(fixture.rootDir, '.git')), false);
  await withEnvironment({
    AUTONOMY_CODEX_BIN: fixture.codexPath,
    FIXTURE_CODEX_LOG: fixture.codexLog,
  }, async () => {
    const result = await runSchedulerTick(fixture.rootDir, {
      detached: false,
      streamOutput: false,
    });
    assert.equal(result.started.length, 1);
    assert.match(
      result.started[0].invocationId,
      /^game-agent-fluxborne-[a-f0-9]{12}-\d{4}-\d{2}-\d{2}t/
    );
    const exit = await waitForChild(result.launched[0].child);
    assert.equal(exit.code, 0);
  });

  const envelopes = fs.readFileSync(fixture.lifecycleLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(envelopes.map((entry) => entry.phase), ['environment', 'prompt', 'finalize']);
  assert.ok(envelopes.every((entry) => entry.runtimeKey === 'game-agent:fluxborne'));
  assert.ok(envelopes.every((entry) => entry.baseRuntimeKey === 'game-agent:fluxborne'));
  assert.ok(envelopes.every((entry) => (
    entry.parallel.slot === 1 && entry.parallel.total === 1
  )));
  assert.equal(envelopes[0].decision.jobId, 'job-1');
  assert.equal(envelopes[2].run.status, 'completed');
  assert.equal(envelopes[2].previous.environment.cwd, fixture.workspace);

  const codex = JSON.parse(fs.readFileSync(fixture.codexLog, 'utf8'));
  assert.equal(codex.prompt, 'implement the fixture task');
  assert.ok(codex.args.includes('danger-full-access'));
  assert.ok(codex.args.includes('--ephemeral'));

  const runtime = loadRuntime(fixture.rootDir);
  const status = runtime.customAgents['game-agent:fluxborne'];
  const invocation = runtime.customAgentInvocations[status.invocationId as string];
  assert.equal(status.running, false);
  assert.equal(status.status, 'idle');
  assert.equal(status.pid, null);
  assert.equal(invocation.status, 'completed');
  assert.equal(invocation.phase, 'completed');
});

test('finalize receives a failed run when Codex fails so repo recovery can run', async () => {
  const fixture = writeFluxborneFixture(makeRoot(), { codexFails: true });
  await withEnvironment({
    AUTONOMY_CODEX_BIN: fixture.codexPath,
    FIXTURE_CODEX_LOG: fixture.codexLog,
  }, async () => {
    const result = await runSchedulerTick(fixture.rootDir, { detached: false });
    const exit = await waitForChild(result.launched[0].child);
    assert.equal(exit.code, 1);
  });
  const envelopes = fs.readFileSync(fixture.lifecycleLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const finalize = envelopes.at(-1);
  assert.equal(finalize.phase, 'finalize');
  assert.equal(finalize.run.status, 'failed');
  assert.match(finalize.run.error, /fixture Codex failure/);
  const runtime = loadRuntime(fixture.rootDir);
  const status = runtime.customAgents['game-agent:fluxborne'];
  assert.equal(status.running, false);
  assert.equal(runtime.customAgentInvocations[status.invocationId as string].status, 'failed');
});

test('rejects config and workspace paths outside the consumer repository', () => {
  const rootDir = makeRoot();
  assert.throws(
    () => loadCustomAgentConfig(rootDir, '../custom-agents.json'),
    /must resolve inside the repository root/
  );
});
