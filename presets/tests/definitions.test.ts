import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeRepo } from '../../tests/support/custom-agent-fixture.js';
import { loadCustomAgentConfig, listConfiguredCustomAgents } from '../../src/server/orchestrator/custom-agents.js';

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
  assert.deepEqual(config?.agents[1].spawn.decision.command, ['node', fileURLToPath(new URL('../../../presets/architecture/should-run.mjs', import.meta.url))]);
  assert.deepEqual(config?.agents[2].finalize.command, ['node', fileURLToPath(new URL('../../../presets/reviewer/finalize.mjs', import.meta.url))]);
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

