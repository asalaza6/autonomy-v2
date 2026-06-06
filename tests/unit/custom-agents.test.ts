import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AGENT_ROLES } from '../../src/agents/role-catalog.js';
import { findDueAgents } from '../../src/server/orchestrator/orchestrator-runtime-core.js';
import {
  listConfiguredCustomAgents,
  loadCustomAgentConfig,
  loadCustomAgentConfigs,
  pollCustomAgents,
  setCustomAgentEnabledOverride,
} from '../../src/server/orchestrator/custom-agents.js';
import { isLegacyRosterEnabled } from '../../src/server/orchestrator/scheduler.js';

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

function makeRepoWithCustomConfigs(customConfigs, controlPlane = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agents-'));
  const configDir = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'feedback-bot'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'context.md'), '# Strategy context\n', 'utf8');
  fs.writeFileSync(path.join(rootDir, 'feedback.md'), '# Feedback bot context\n', 'utf8');
  fs.writeFileSync(path.join(configDir, 'control-plane.json'), `${JSON.stringify({
    schemaVersion: 1,
    repoId: 'fixture',
    spawnCustomAgents: customConfigs.map((entry) => `prompts/autonomous/v2/config/${entry.name}`),
    ...controlPlane,
  }, null, 2)}\n`, 'utf8');
  customConfigs.forEach((entry) => {
    fs.writeFileSync(path.join(configDir, entry.name), `${JSON.stringify(entry.config, null, 2)}\n`, 'utf8');
  });
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

test('loads multiple spawnCustomAgents config files when configured as an array', () => {
  const rootDir = makeRepoWithCustomConfigs([
    { name: 'strategy-agents.json', config: baseCustomConfig({ kind: 'strategy-agents' }) },
    { name: 'feedback-bots.json', config: baseCustomConfig({ kind: 'feedback-bots' }) },
  ]);

  const configs = loadCustomAgentConfigs(rootDir);

  assert.equal(configs.length, 2);
  assert.equal(configs[0].kind, 'strategy-agents');
  assert.equal(configs[1].kind, 'feedback-bots');
  assert.equal(loadCustomAgentConfig(rootDir)?.kind, 'strategy-agents');
});

test('presetAgentId expands default custom lifecycle agents from the tested consumer config shape', () => {
  const rootDir = makeRepo({
    schemaVersion: 1,
    agents: [
      { presetAgentId: 'shadow-pm-agent' },
      { presetAgentId: 'shadow-architecture-agent' },
      { presetAgentId: 'shadow-reviewer-agent' },
    ],
  }, {
    repoId: 'moving-game',
    label: 'Moving game',
  });

  const config = loadCustomAgentConfig(rootDir);
  const configured = listConfiguredCustomAgents(rootDir);

  assert.equal(config?.kind, 'moving-game-lifecycle-agents');
  assert.equal(config?.promptRole, 'Moving game command-driven autonomy agent');
  assert.equal(config?.agents[0].context.allowRuntimeStateChanges, true);
  assert.deepEqual(config?.agents[0].context.workspaceReadWrite, [
    '.autonomy/runtime/custom-lifecycle',
    '.autonomy/worktrees/shadow-architecture-agent',
    '.autonomy/worktrees/shadow-reviewer-agent',
    'prompts/autonomous/v2/specs',
  ]);
  assert.deepEqual(config?.agents.map((agent) => agent.id), [
    'shadow-pm-agent',
    'shadow-architecture-agent',
    'shadow-reviewer-agent',
  ]);
  assert.equal(config?.agents[0].target.id, 'moving-game');
  assert.deepEqual(config?.agents[1].spawn.decision.command, ['node', 'agents/architecture/should-run.mjs']);
  assert.deepEqual(config?.agents[2].finalize.command, ['node', 'agents/reviewer/finalize.mjs']);
  assert.deepEqual(configured.map((agent) => agent.runtimeKey), [
    'shadow-pm-agent:moving-game',
    'shadow-architecture-agent:shadow-architecture-agent',
    'shadow-reviewer-agent:shadow-reviewer-agent',
  ]);
});

test('presetAgentId entries can override selected default custom-agent config fields', () => {
  const rootDir = makeRepo({
    schemaVersion: 1,
    promptRole: 'Custom lifecycle role',
    context: {
      globalReadOnly: ['context.md'],
    },
    agents: [
      {
        presetAgentId: 'shadow-pm-agent',
        enabled: false,
        target: {
          id: 'custom-backlog',
        },
        spawn: {
          intervalSeconds: 120,
          decision: {
            mode: 'always',
          },
        },
        finalize: {
          command: ['node', 'custom/finalize.mjs'],
        },
      },
    ],
  }, {
    repoId: 'fixture-repo',
  });

  const config = loadCustomAgentConfig(rootDir);
  const agent = config?.agents[0];
  const configured = listConfiguredCustomAgents(rootDir);

  assert.equal(config?.promptRole, 'Custom lifecycle role');
  assert.deepEqual(config?.context.globalReadOnly, ['context.md']);
  assert.deepEqual(agent.context.globalReadOnly, ['context.md']);
  assert.deepEqual(agent.context.workspaceReadWrite, [
    '.autonomy/runtime/custom-lifecycle',
    '.autonomy/worktrees/shadow-architecture-agent',
    '.autonomy/worktrees/shadow-reviewer-agent',
    'prompts/autonomous/v2/specs',
  ]);
  assert.equal(agent.id, 'shadow-pm-agent');
  assert.equal(agent.type, 'pm');
  assert.equal(agent.enabled, false);
  assert.equal(agent.target.type, 'prd-backlog');
  assert.equal(agent.target.id, 'custom-backlog');
  assert.equal(agent.spawn.intervalSeconds, 120);
  assert.equal(agent.spawn.offsetSeconds, 10);
  assert.equal(agent.spawn.singletonKey, 'agent.id');
  assert.deepEqual(agent.spawn.decision, { mode: 'always' });
  assert.deepEqual(agent.finalize.command, ['node', 'custom/finalize.mjs']);
  assert.equal(configured[0].runtimeKey, 'shadow-pm-agent:custom-backlog');
  assert.equal(configured[0].enabled, false);
  assert.equal(configured[0].decisionSource, 'always');
});

test('unknown presetAgentId is reported as invalid custom-agent config', () => {
  const rootDir = makeRepo({
    schemaVersion: 1,
    agents: [
      { presetAgentId: 'missing-agent-preset' },
    ],
  });
  const runtime: any = { workers: {} };

  pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
  });

  const configured = listConfiguredCustomAgents(rootDir, runtime as any);
  assert.equal(configured[0].runtimeKey, 'missing-agent-preset:missing-agent-preset');
  assert.equal(configured[0].status, 'blocked');
  assert.match(configured[0].lastError, /unknown custom-agent presetAgentId/);
  assert.equal(runtime.customAgents['missing-agent-preset:missing-agent-preset'].lastDecision, 'invalid_config');
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

test('legacy roster defaults on and can be disabled from control-plane config', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agents-'));
  const configDir = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config');
  fs.mkdirSync(configDir, { recursive: true });

  assert.equal(isLegacyRosterEnabled(rootDir), true);

  fs.writeFileSync(path.join(configDir, 'control-plane.json'), '{"schemaVersion":1,"legacyRosterEnabled":false}\n', 'utf8');

  assert.equal(isLegacyRosterEnabled(rootDir), false);
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

test('runtime enable override disables configured custom agent before polling', () => {
  const rootDir = makeRepo(baseCustomConfig());
  process.env.STRATEGY_TOKEN = 'secret-token';
  let decisionCalls = 0;
  const runtime: any = {
    workers: {},
    customAgentEnabledOverrides: {
      'strategy-agent:target-1': false,
    },
  };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      decisionCalls += 1;
      return { shouldRun: true };
    },
  });

  assert.equal(decisionCalls, 0);
  assert.equal(result.pendingSpawnStarts.length, 0);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].enabled, false);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].enabledSource, 'runtime');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecisionReason, 'agent disabled by control-plane override');

  const configured = listConfiguredCustomAgents(rootDir, runtime as any);
  assert.equal(configured.length, 1);
  assert.equal(configured[0].runtimeKey, 'strategy-agent:target-1');
  assert.equal(configured[0].enabled, false);
  assert.equal(configured[0].enabledOverride, false);
});

test('setCustomAgentEnabledOverride persists a runtime source of truth', () => {
  const rootDir = makeRepo(baseCustomConfig());

  const disabled = setCustomAgentEnabledOverride(rootDir, 'strategy-agent:target-1', false);
  const runtimePath = path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json');
  const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));

  assert.equal(disabled?.runtimeKey, 'strategy-agent:target-1');
  assert.equal(disabled?.enabled, false);
  assert.equal(runtime.customAgentEnabledOverrides['strategy-agent:target-1'], false);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].enabledSource, 'runtime');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].status, 'disabled');

  const enabled = setCustomAgentEnabledOverride(rootDir, 'strategy-agent:target-1', true);
  const updated = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));

  assert.equal(enabled?.enabled, true);
  assert.equal(updated.customAgentEnabledOverrides['strategy-agent:target-1'], true);
  assert.equal(updated.customAgents['strategy-agent:target-1'].enabled, true);
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

test('decision mode always spawns without a remote decision endpoint or auth env', () => {
  const baseAgent = baseCustomConfig().agents[0];
  const rootDir = makeRepo(baseCustomConfig({
    agents: [
      {
        ...baseAgent,
        authEnv: '',
        spawn: {
          ...baseAgent.spawn,
          decision: {
            mode: 'always',
          },
        },
      },
    ],
  }));
  const previous = process.env.STRATEGY_TOKEN;
  delete process.env.STRATEGY_TOKEN;
  const runtime: any = { workers: {} };
  let decisionCalls = 0;

  try {
    const result = pollCustomAgents(rootDir, runtime as any, {
      nowIso: '2026-01-01T00:00:00.000Z',
      customAgentDecisionClient() {
        decisionCalls += 1;
        return { shouldRun: false };
      },
    });

    assert.equal(decisionCalls, 0);
    assert.equal(result.pendingSpawnStarts.length, 1);
    assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecision, 'run');
    assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecisionReason, 'decision mode always');
    const runtimeContext = JSON.parse(fs.readFileSync(result.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
    assert.equal(runtimeContext.auth.envKey, '');
    assert.equal(runtimeContext.auth.value, '');
    assert.deepEqual(runtimeContext.decision, {
      shouldRun: true,
      reason: 'decision mode always',
    });
  } finally {
    if (typeof previous === 'string') {
      process.env.STRATEGY_TOKEN = previous;
    }
  }
});

test('local decision command controls custom-agent spawn without remote auth', () => {
  const baseAgent = baseCustomConfig().agents[0];
  const rootDir = makeRepo(baseCustomConfig({
    agents: [
      {
        ...baseAgent,
        authEnv: '',
        spawn: {
          ...baseAgent.spawn,
          decision: {
            command: ['node', 'decision.js'],
          },
        },
      },
    ],
  }));
  fs.writeFileSync(
    path.join(rootDir, 'decision.js'),
    'console.log(JSON.stringify({ shouldRun: false, reason: "local quiet" }));\n',
    'utf8',
  );
  const previous = process.env.STRATEGY_TOKEN;
  delete process.env.STRATEGY_TOKEN;
  const runtime: any = { workers: {} };
  let decisionCalls = 0;

  try {
    const result = pollCustomAgents(rootDir, runtime as any, {
      nowIso: '2026-01-01T00:00:00.000Z',
      customAgentDecisionClient() {
        decisionCalls += 1;
        return { shouldRun: true };
      },
    });

    assert.equal(decisionCalls, 0);
    assert.equal(result.pendingSpawnStarts.length, 0);
    assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecision, 'skip');
    assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecisionReason, 'local quiet');
  } finally {
    if (typeof previous === 'string') {
      process.env.STRATEGY_TOKEN = previous;
    }
  }
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

test('offsetSeconds staggers polling within epoch interval windows', () => {
  const agent = {
    ...baseCustomConfig().agents[0],
    spawn: {
      ...baseCustomConfig().agents[0].spawn,
      intervalSeconds: 1800,
      offsetSeconds: 540,
    },
  };
  const rootDir = makeRepo(baseCustomConfig({ agents: [agent] }));
  process.env.STRATEGY_TOKEN = 'secret-token';
  const calls: string[] = [];
  const runtime: any = { workers: {} };

  pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:08:59.000Z',
    customAgentDecisionClient() {
      calls.push('before');
      return { shouldRun: false };
    },
  });
  pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:09:00.000Z',
    customAgentDecisionClient() {
      calls.push('first-window');
      return { shouldRun: false, reason: 'first' };
    },
  });
  pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:20:00.000Z',
    customAgentDecisionClient() {
      calls.push('duplicate-window');
      return { shouldRun: false };
    },
  });
  pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:39:00.000Z',
    customAgentDecisionClient() {
      calls.push('second-window');
      return { shouldRun: false, reason: 'second' };
    },
  });

  assert.deepEqual(calls, ['first-window', 'second-window']);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].offsetSeconds, 540);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].intervalSeconds, 1800);
  assert.equal(
    runtime.customAgents['strategy-agent:target-1'].lastPollWindowStart,
    Date.parse('2026-01-01T00:30:00.000Z') / 1000,
  );
});

test('invalid offsetSeconds is reported as a custom-agent config warning and not polled', () => {
  const agent = {
    ...baseCustomConfig().agents[0],
    spawn: {
      ...baseCustomConfig().agents[0].spawn,
      intervalSeconds: 60,
      offsetSeconds: 60,
    },
  };
  const rootDir = makeRepo(baseCustomConfig({ agents: [agent] }));
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
  assert.equal(runtime.customAgents['strategy-agent:target-1'].status, 'blocked');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].lastDecision, 'invalid_config');
  assert.match(runtime.customAgents['strategy-agent:target-1'].lastError, /offsetSeconds/);
});

test('shouldRun true spawns once and creates the configured workspace', () => {
  const rootDir = makeRepo(baseCustomConfig({
    promptRole: 'trading strategy operator agent',
  }));
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
  assert.equal(runtimeContext.promptRole, 'trading strategy operator agent');
  assert.deepEqual(runtimeContext.target, { type: 'strategy', id: 'target-1' });
  assert.equal(runtimeContext.workspacePath, workspacePath);
  assert.equal(runtimeContext.controlPanel.baseUrl, 'https://control.example');
  assert.equal(runtimeContext.controlPanel.authHeader, 'X-Strategy-Token');
  assert.equal(runtimeContext.auth.value, 'secret-token');
  assert.deepEqual(runtimeContext.spawn, {
    intervalSeconds: 60,
    offsetSeconds: null,
    pollWindowStart: null,
  });
  assert.equal(runtimeContext.context.globalReadOnly[0].path, path.join(rootDir, 'context.md'));
  assert.deepEqual(runtimeContext.context.workspaceReadWrite, ['state.json', 'notes.md']);
  assert.equal(runtimeContext.context.allowRuntimeStateChanges, false);
});

test('custom-agent lifecycle command config is carried into runtime context', () => {
  const baseAgent = baseCustomConfig().agents[0];
  const rootDir = makeRepo(baseCustomConfig({
    agents: [
      {
        ...baseAgent,
        environment: {
          command: ['node', '../agents/prepare-env.js'],
        },
        execution: {
          prompt: {
            command: {
              command: 'node',
              args: ['../agents/build-prompt.js'],
            },
          },
        },
        finalize: {
          command: ['node', '../agents/finalize.js'],
        },
      },
    ],
  }));
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  const runtimeContext = JSON.parse(fs.readFileSync(result.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(runtimeContext.invocationId, 'strategy-agent-target-1-2026-01-01t00-00-00-000z');
  assert.equal(runtimeContext.lifecycle.environment.command, 'node');
  assert.deepEqual(runtimeContext.lifecycle.environment.args, ['../agents/prepare-env.js']);
  assert.equal(runtimeContext.lifecycle.prompt.command, 'node');
  assert.deepEqual(runtimeContext.lifecycle.prompt.args, ['../agents/build-prompt.js']);
  assert.equal(runtimeContext.lifecycle.finalize.command, 'node');
  assert.equal(runtime.customAgentInvocations[runtimeContext.invocationId].phase, 'scheduled');
  assert.equal(runtime.customAgentInvocations[runtimeContext.invocationId].paths.contextPath, result.pendingSpawnStarts[0].runtimeContextPath);
});

test('custom-agent default conversation scope reuses only the same day', () => {
  process.env.STRATEGY_TOKEN = 'secret';
  const rootDir = makeRepo(baseCustomConfig());
  const runtime: any = {
    workers: {},
    customAgents: {
      'strategy-agent:target-1': {
        agentId: 'strategy-agent',
        conversationKey: 'server-a:strategy-agent:target-1:2026-01-01',
        conversationId: 'session-existing',
        conversations: {
          'server-a:strategy-agent:target-1:2026-01-01': {
            conversationId: 'session-existing',
          },
        },
      },
    },
  };

  const sameDay = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T12:00:00.000Z',
    serverInstanceId: 'server-a',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  const sameDayContext = JSON.parse(fs.readFileSync(sameDay.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(sameDayContext.conversation.resumeSessionId, 'session-existing');
  assert.equal(sameDayContext.conversation.key, 'server-a:strategy-agent:target-1:2026-01-01');
  assert.deepEqual(sameDayContext.conversation.scope, ['server.instanceId', 'agent.id', 'target.id', 'date.local']);

  runtime.customAgents['strategy-agent:target-1'].running = false;
  runtime.customAgents['strategy-agent:target-1'].status = 'idle';
  const nextDay = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-02T12:00:00.000Z',
    serverInstanceId: 'server-a',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  const nextDayContext = JSON.parse(fs.readFileSync(nextDay.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(nextDayContext.conversation.key, 'server-a:strategy-agent:target-1:2026-01-02');
  assert.equal(nextDayContext.conversation.resumeSessionId, '');
});

test('custom-agent default conversation scope starts fresh for a new server instance', () => {
  process.env.STRATEGY_TOKEN = 'secret';
  const rootDir = makeRepo(baseCustomConfig());
  const runtime: any = {
    workers: {},
    customAgents: {
      'strategy-agent:target-1': {
        agentId: 'strategy-agent',
        conversations: {
          'server-a:strategy-agent:target-1:2026-01-01': {
            conversationId: 'session-server-a',
          },
        },
      },
    },
  };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T12:00:00.000Z',
    serverInstanceId: 'server-b',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  const context = JSON.parse(fs.readFileSync(result.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(context.conversation.key, 'server-b:strategy-agent:target-1:2026-01-01');
  assert.equal(context.conversation.resumeSessionId, '');
});

test('custom-agent conversation scope can rotate by UTC day', () => {
  process.env.STRATEGY_TOKEN = 'secret';
  const rootDir = makeRepo(baseCustomConfig({
    agents: [
      {
        ...baseCustomConfig().agents[0],
        conversation: {
          scope: ['agent.id', 'target.id', 'date.utc'],
        },
      },
    ],
  }));
  const runtime: any = {
    workers: {},
    customAgents: {
      'strategy-agent:target-1': {
        agentId: 'strategy-agent',
        conversations: {
          'strategy-agent:target-1:2026-01-01': {
            conversationId: 'session-day-1',
          },
        },
      },
    },
  };

  const sameDay = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T12:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });
  const sameDayContext = JSON.parse(fs.readFileSync(sameDay.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(sameDayContext.conversation.key, 'strategy-agent:target-1:2026-01-01');
  assert.equal(sameDayContext.conversation.resumeSessionId, 'session-day-1');

  runtime.customAgents['strategy-agent:target-1'].running = false;
  runtime.customAgents['strategy-agent:target-1'].status = 'idle';
  const nextDay = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-02T12:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });
  const nextDayContext = JSON.parse(fs.readFileSync(nextDay.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(nextDayContext.conversation.key, 'strategy-agent:target-1:2026-01-02');
  assert.equal(nextDayContext.conversation.resumeSessionId, '');
});

test('custom-agent conversation scope can follow a decision task id', () => {
  process.env.STRATEGY_TOKEN = 'secret';
  const rootDir = makeRepo(baseCustomConfig({
    agents: [
      {
        ...baseCustomConfig().agents[0],
        conversation: {
          scope: ['agent.id', 'decision.taskId'],
        },
      },
    ],
  }));
  const runtime: any = {
    workers: {},
    customAgents: {
      'strategy-agent:target-1': {
        agentId: 'strategy-agent',
        conversations: {
          'strategy-agent:task-7': {
            conversationId: 'session-task-7',
          },
        },
      },
    },
  };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true, taskId: 'task-7' };
    },
  });

  const context = JSON.parse(fs.readFileSync(result.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(context.conversation.key, 'strategy-agent:task-7');
  assert.equal(context.conversation.resumeSessionId, 'session-task-7');
});

test('custom-agent runtime context carries explicit runtime recovery permission', () => {
  const rootDir = makeRepo(baseCustomConfig({
    context: {
      globalReadOnly: ['context.md'],
      workspaceReadWrite: ['state.json', 'notes.md'],
      allowRuntimeStateChanges: true,
    },
  }));
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  const runtimeContext = JSON.parse(fs.readFileSync(result.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(runtimeContext.context.allowRuntimeStateChanges, true);
});

test('per-agent context overrides top-level context', () => {
  const rootDir = makeRepo(baseCustomConfig({
    context: {
      globalReadOnly: ['context.md'],
      workspaceReadWrite: ['state.json'],
      allowRuntimeStateChanges: true,
    },
    agents: [
      {
        ...baseCustomConfig().agents[0],
        context: {
          globalReadOnly: ['feedback.md'],
          allowRuntimeStateChanges: false,
        },
      },
    ],
  }));
  fs.writeFileSync(path.join(rootDir, 'feedback.md'), '# Feedback context\n', 'utf8');
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  const runtimeContext = JSON.parse(fs.readFileSync(result.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.equal(runtimeContext.context.globalReadOnly[0].path, path.join(rootDir, 'feedback.md'));
  assert.deepEqual(runtimeContext.context.workspaceReadWrite, ['state.json']);
  assert.equal(runtimeContext.context.allowRuntimeStateChanges, false);
});

test('declared custom-agent tools are passed into runtime context with env values', () => {
  const rootDir = makeRepo(baseCustomConfig({
    agentTools: {
      autonomy: {
        baseUrl: 'https://autonomy.example/api/agent-tools',
        authHeader: 'x-autonomy-agent-key',
      },
    },
    agents: [
      {
        ...baseCustomConfig().agents[0],
        tools: {
          autonomy: {
            authEnv: 'FEEDBACK_BOT_AUTONOMY_TOKEN',
          },
        },
      },
    ],
  }));
  process.env.STRATEGY_TOKEN = 'secret-token';
  process.env.FEEDBACK_BOT_AUTONOMY_TOKEN = 'tool-secret';
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  const runtimeContext = JSON.parse(fs.readFileSync(result.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.deepEqual(runtimeContext.tools.autonomy, {
    baseUrl: 'https://autonomy.example/api/agent-tools',
    authHeader: 'x-autonomy-agent-key',
    authEnv: 'FEEDBACK_BOT_AUTONOMY_TOKEN',
    value: 'tool-secret',
  });
  assert.equal(runtime.customAgents['strategy-agent:target-1'].tools.autonomy.envPresent, true);
});

test('missing declared custom-agent tool env blocks spawn after a run decision', () => {
  const rootDir = makeRepo(baseCustomConfig({
    agentTools: {
      autonomy: {
        baseUrl: 'https://autonomy.example/api/agent-tools',
        authHeader: 'x-autonomy-agent-key',
      },
    },
    agents: [
      {
        ...baseCustomConfig().agents[0],
        tools: {
          autonomy: {
            authEnv: 'FEEDBACK_BOT_AUTONOMY_TOKEN',
          },
        },
      },
    ],
  }));
  const previous = process.env.FEEDBACK_BOT_AUTONOMY_TOKEN;
  delete process.env.FEEDBACK_BOT_AUTONOMY_TOKEN;
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  try {
    const result = pollCustomAgents(rootDir, runtime as any, {
      nowIso: '2026-01-01T00:00:00.000Z',
      customAgentDecisionClient() {
        return { shouldRun: true };
      },
    });

    assert.equal(result.pendingSpawnStarts.length, 0);
    assert.equal(runtime.customAgents['strategy-agent:target-1'].status, 'blocked');
    assert.match(runtime.customAgents['strategy-agent:target-1'].lastError, /FEEDBACK_BOT_AUTONOMY_TOKEN/);
  } finally {
    if (typeof previous === 'string') {
      process.env.FEEDBACK_BOT_AUTONOMY_TOKEN = previous;
    }
  }
});

test('multiple custom-agent files keep independent status keys while preserving singleton blocking', () => {
  const strategy = baseCustomConfig({
    kind: 'strategy-agents',
    agents: [baseCustomConfig().agents[0]],
  });
  const feedback = baseCustomConfig({
    kind: 'feedback-bots',
    context: { globalReadOnly: ['feedback.md'] },
    agents: [
      {
        ...baseCustomConfig().agents[0],
        id: 'feedback-bot',
        workspace: '.autonomy/custom/feedback-target-1',
      },
    ],
  });
  const rootDir = makeRepoWithCustomConfigs([
    { name: 'strategy-agents.json', config: strategy },
    { name: 'feedback-bots.json', config: feedback },
  ]);
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:00:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  assert.equal(result.pendingSpawnStarts.length, 1);
  const statusKeys = Object.keys(runtime.customAgents).sort();
  assert.equal(statusKeys.length, 2);
  assert.equal(statusKeys.some((key) => key.includes('strategy-agents-json:strategy-agent:target-1')), true);
  assert.equal(statusKeys.some((key) => key.includes('feedback-bots-json:feedback-bot:target-1')), true);
  assert.equal(Object.values(runtime.customAgents).filter((status: any) => status.status === 'blocked').length, 1);
});

test('offsetSeconds is included in runtime context when an offset agent spawns', () => {
  const agent = {
    ...baseCustomConfig().agents[0],
    spawn: {
      ...baseCustomConfig().agents[0].spawn,
      intervalSeconds: 1800,
      offsetSeconds: 540,
    },
  };
  const rootDir = makeRepo(baseCustomConfig({ agents: [agent] }));
  process.env.STRATEGY_TOKEN = 'secret-token';
  const runtime: any = { workers: {} };

  const result = pollCustomAgents(rootDir, runtime as any, {
    nowIso: '2026-01-01T00:09:00.000Z',
    customAgentDecisionClient() {
      return { shouldRun: true };
    },
  });

  assert.equal(result.pendingSpawnStarts.length, 1);
  const runtimeContext = JSON.parse(fs.readFileSync(result.pendingSpawnStarts[0].runtimeContextPath, 'utf8'));
  assert.deepEqual(runtimeContext.spawn, {
    intervalSeconds: 1800,
    offsetSeconds: 540,
    pollWindowStart: Date.parse('2026-01-01T00:00:00.000Z') / 1000,
  });
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
