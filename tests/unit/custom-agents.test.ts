import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AGENT_ROLES } from '../../src/agents/role-catalog.js';
import { findDueAgents } from '../../src/server/orchestrator/orchestrator-runtime-core.js';
import {
  loadCustomAgentConfig,
  pollCustomAgents,
} from '../../src/server/orchestrator/custom-agents.js';

function makeRepo(customConfig, controlPlane = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agents-'));
  const configDir = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'context.md'), '# Strategy context\n', 'utf8');
  fs.writeFileSync(path.join(configDir, 'control-plane.json'), `${JSON.stringify({
    schemaVersion: 1,
    repoId: 'fixture',
    spawnCustomAgents: 'prompts/autonomous/v2/config/custom-agents.json',
    ...controlPlane,
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(configDir, 'custom-agents.json'), `${JSON.stringify(customConfig, null, 2)}\n`, 'utf8');
  return rootDir;
}

function baseCustomConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'strategy-agents',
    enabled: true,
    controlPanel: {
      baseUrl: 'https://control.example',
      authHeader: 'X-Strategy-Token',
    },
    context: {
      globalReadOnly: ['context.md'],
      workspaceReadWrite: ['state.json', 'notes.md'],
    },
    agents: [
      {
        id: 'strategy-agent',
        enabled: true,
        authEnv: 'STRATEGY_TOKEN',
        target: { type: 'strategy', id: 'target-1' },
        workspace: '.autonomy/custom/target-1',
        spawn: {
          mode: 'poll',
          intervalSeconds: 60,
          singletonKey: 'target.id',
          decision: { endpoint: '/api/strategy/target-1/decision' },
        },
      },
    ],
    ...overrides,
  };
}

test('loads spawnCustomAgents config relative to the repo root', () => {
  const rootDir = makeRepo(baseCustomConfig());
  const config = loadCustomAgentConfig(rootDir);
  assert.equal(config.kind, 'strategy-agents');
  assert.equal(config.agents[0].id, 'strategy-agent');
  assert.equal(config.configPath, path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'custom-agents.json'));
});

test('missing spawnCustomAgents leaves existing repo-agent runtime untouched', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agents-'));
  const configDir = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'control-plane.json'), '{"schemaVersion":1,"repoId":"fixture"}\n', 'utf8');
  const runtime: any = {
    workers: {
      'pm-agent': { agentId: 'pm-agent', status: 'idle' },
    },
  };

  const result = pollCustomAgents(rootDir, runtime as any);

  assert.deepEqual(result.started, []);
  assert.deepEqual(runtime, {
    workers: {
      'pm-agent': { agentId: 'pm-agent', status: 'idle' },
    },
  });
});

test('disabled custom-agent config is a no-op', () => {
  const rootDir = makeRepo(baseCustomConfig({ enabled: false }));
  let decisionCalls = 0;
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    customAgentDecisionClient() {
      decisionCalls += 1;
      return { shouldRun: true };
    },
  });

  assert.equal(decisionCalls, 0);
  assert.deepEqual(result.pendingSpawnStarts, []);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].status, 'disabled');
});

test('disabled individual custom agent is not polled or spawned', () => {
  const rootDir = makeRepo(baseCustomConfig({
    agents: [
      {
        id: 'strategy-agent',
        enabled: false,
        authEnv: 'STRATEGY_TOKEN',
        target: { type: 'strategy', id: 'target-1' },
        workspace: '.autonomy/custom/target-1',
        spawn: {
          mode: 'poll',
          intervalSeconds: 60,
          singletonKey: 'target.id',
          decision: { endpoint: '/api/strategy/target-1/decision' },
        },
      },
    ],
  }));
  process.env.STRATEGY_TOKEN = 'secret-token';
  let decisionCalls = 0;
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      decisionCalls += 1;
      return { shouldRun: true };
    },
  });

  assert.equal(decisionCalls, 0);
  assert.deepEqual(result.pendingSpawnStarts, []);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].enabled, false);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].status, 'disabled');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].running, false);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecision, 'disabled');
  assert.equal(
    runtime.customAgents['strategy-agent:target-1'].lastDecisionReason,
    'agent disabled by custom-agent config',
  );
});

test('missing auth env key blocks spawn without calling the decision API', () => {
  const rootDir = makeRepo(baseCustomConfig());
  const previous = process.env.STRATEGY_TOKEN;
  delete process.env.STRATEGY_TOKEN;
  let decisionCalls = 0;
  const runtime: any = { workers: {} };

  try {
    const result = pollCustomAgents(rootDir, runtime as any, {
      nowIso: '2026-01-01T00:00:00.000Z',
      customAgentDecisionClient() {
        decisionCalls += 1;
        return { shouldRun: true };
      },
    });

    assert.equal(decisionCalls, 0);
    assert.deepEqual(result.pendingSpawnStarts, []);
    assert.equal(runtime.customAgents['strategy-agent:target-1'].status, 'blocked');
    assert.match(runtime.customAgents['strategy-agent:target-1'].lastError, /STRATEGY_TOKEN/);
  } finally {
    if (typeof previous === 'string') {
      process.env.STRATEGY_TOKEN = previous;
    }
  }
});

test('polling uses the configured decision endpoint and auth header', () => {
  const rootDir = makeRepo(baseCustomConfig());
  process.env.STRATEGY_TOKEN = 'secret-token';
  const calls: any[] = [];
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient(request) {
      calls.push(request);
      return { shouldRun: false, reason: 'not due upstream' };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://control.example/api/strategy/target-1/decision');
  assert.deepEqual(calls[0].headers, { 'X-Strategy-Token': 'secret-token' });
  assert.deepEqual(result.pendingSpawnStarts, []);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecision, 'skip');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecisionReason, 'not due upstream');
});

test('shouldRun false does not spawn a custom agent', () => {
  const rootDir = makeRepo(baseCustomConfig());
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    customAgentDecisionClient() {
      return { shouldRun: false, reason: 'quiet' };
    },
  });

  assert.deepEqual(result.started, []);
  assert.deepEqual(result.pendingSpawnStarts, []);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].running, false);
});

test('decision request failures are recorded without preventing later polls', () => {
  const rootDir = makeRepo(baseCustomConfig());
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const failed = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      throw new Error('control plane unavailable');
    },
  });
  assert.deepEqual(failed.pendingSpawnStarts, []);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecision, 'error');
  assert.match(runtime.customAgents['strategy-agent:target-1'].lastError, /control plane unavailable/);

  const later = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:01:01.000Z',
    customAgentDecisionClient() {
      return { shouldRun: false, reason: 'recovered' };
    },
  });

  assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecision, 'skip');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecisionReason, 'recovered');
  assert.deepEqual(later.pendingSpawnStarts, []);
});

test('shouldRun true spawns once and creates the configured workspace', () => {
  const rootDir = makeRepo(baseCustomConfig());
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const first = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true, reason: 'run target' };
    },
  });
  const second = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:30.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  assert.equal(first.pendingSpawnStarts.length, 1);
  assert.equal(second.pendingSpawnStarts.length, 0);
  const workspacePath = path.join(rootDir, '.autonomy', 'custom', 'target-1');
  assert.equal(fs.existsSync(workspacePath), true);
  const runtimeContext = JSON.parse(fs.readFileSync(first.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(runtimeContext.agent.id, 'strategy-agent');
  assert.deepEqual(runtimeContext.target, { type: 'strategy', id: 'target-1' });
  assert.equal(runtimeContext.workspacePath, workspacePath);
  assert.equal(runtimeContext.controlPanel.baseUrl, 'https://control.example');
  assert.equal(runtimeContext.controlPanel.authHeader, 'X-Strategy-Token');
  assert.equal(runtimeContext.auth.value, 'secret-token');
  assert.equal(runtimeContext.context.globalReadOnly[0].path, path.join(rootDir, 'context.md'));
  assert.deepEqual(runtimeContext.context.workspaceReadWrite, ['state.json', 'notes.md']);
});

test('singleton target.id prevents duplicate active target spawns', () => {
  const config = baseCustomConfig({
    agents: [
      baseCustomConfig().agents[0],
      {
        ...baseCustomConfig().agents[0],
        id: 'strategy-agent-copy',
        workspace: '.autonomy/custom/target-1-copy',
      },
    ],
  });
  const rootDir = makeRepo(config);
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  assert.equal(result.pendingSpawnStarts.length, 1);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].status, 'running');
  assert.equal(runtime.customAgents['strategy-agent-copy:target-1'].status, 'blocked');
});

test('existing PM/implementation/reviewer due-agent scheduling remains unchanged', () => {
  const config = {
    integrationBranch: 'dev',
    branchPrefixes: { task: 'task' },
    worktreesRoot: '.worktrees',
    agents: [
      { id: 'pm-agent', role: AGENT_ROLES.PM, taskQueue: 'queues/pm-agent.json' },
      { id: 'builder', role: AGENT_ROLES.IMPLEMENTATION, taskQueue: 'queues/builder.json', checks: ['npm test'] },
      { id: 'gate', role: AGENT_ROLES.REVIEW, taskQueue: 'queues/gate.json' },
    ],
  };
  const queues = {
    builder: {
      agentId: 'builder',
      role: AGENT_ROLES.IMPLEMENTATION,
      tasks: [{ id: 'task-1', status: 'queued', laneKey: 'lane-1', sprintId: 'shared', createdAt: '2026-01-01T00:00:00.000Z' }],
    },
    gate: {
      agentId: 'gate',
      role: AGENT_ROLES.REVIEW,
      tasks: [{ id: 'review-1', status: 'queued', sourceAgentId: 'builder', prId: 'pr-1' }],
    },
  };

  const dueAgents = findDueAgents(
    '/tmp/example',
    config as any,
    queues as any,
    { locks: [] } as any,
    { prds: [] } as any,
    { workers: {} } as any,
  );

  assert.deepEqual(dueAgents, [
    { agentId: 'builder', reason: 'queued_task' },
  ]);
});
