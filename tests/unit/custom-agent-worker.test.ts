import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCustomAgentNetworkConfigOverrides,
  buildCustomAgentPrompt,
} from '../../src/server/custom-agents/custom-agent-worker.js';

test('custom agent worker allowlists configured control hosts', () => {
  const overrides = buildCustomAgentNetworkConfigOverrides(
    {
      controlPanel: {
        baseUrl: 'https://whispering-everglades-64534-f5ea8b76f95d.herokuapp.com/v0/agent-control',
      },
    },
    {
      AUTONOMY_CONTROL_PLANE_SERVER_URL: 'https://autonomy-v2-mgr-703614-45205c824326.herokuapp.com',
    } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(overrides, [
    'sandbox_workspace_write.network_access=true',
    'experimental_network.allowed_domains=["whispering-everglades-64534-f5ea8b76f95d.herokuapp.com","autonomy-v2-mgr-703614-45205c824326.herokuapp.com"]',
    'experimental_network.open_world_enabled=false',
  ]);
});

test('custom agent worker omits empty network allowlist config', () => {
  const overrides = buildCustomAgentNetworkConfigOverrides({}, {} as NodeJS.ProcessEnv);

  assert.deepEqual(overrides, []);
});

test('custom agent worker deduplicates repeated network allowlist hosts', () => {
  const overrides = buildCustomAgentNetworkConfigOverrides(
    {
      controlPanel: {
        baseUrl: 'https://control.example/v0/agent-control',
      },
    },
    {
      AUTONOMY_CONTROL_PLANE_SERVER_URL: 'https://control.example/dashboard',
    } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(overrides, [
    'sandbox_workspace_write.network_access=true',
    'experimental_network.allowed_domains=["control.example"]',
    'experimental_network.open_world_enabled=false',
  ]);
});

test('custom agent worker allowlists configured tool hosts', () => {
  const overrides = buildCustomAgentNetworkConfigOverrides(
    {
      controlPanel: {
        baseUrl: 'https://control.example/v0/agent-control',
      },
      tools: {
        autonomy: {
          baseUrl: 'https://autonomy.example/api/agent-tools',
        },
      },
    },
    {} as NodeJS.ProcessEnv,
  );

  assert.deepEqual(overrides, [
    'sandbox_workspace_write.network_access=true',
    'experimental_network.allowed_domains=["control.example","autonomy.example"]',
    'experimental_network.open_world_enabled=false',
  ]);
});

test('custom agent prompt includes tool metadata without token values', () => {
  const prompt = buildCustomAgentPrompt({
    rootDir: process.cwd(),
    agent: { id: 'feedback-bot' },
    target: { type: 'project', id: 'frontend' },
    workspacePath: '/tmp/feedback-bot',
    controlPanel: {},
    context: {},
    tools: {
      autonomy: {
        baseUrl: 'https://autonomy.example/api/agent-tools',
        authHeader: 'x-autonomy-agent-key',
        authEnv: 'FEEDBACK_BOT_AUTONOMY_TOKEN',
        value: 'secret-tool-token',
      },
    },
  });

  assert.match(prompt, /"autonomy"/);
  assert.match(prompt, /FEEDBACK_BOT_AUTONOMY_TOKEN/);
  assert.doesNotMatch(prompt, /secret-tool-token/);
});

test('custom agent worker uses configured prompt role in wrapper text', () => {
  const prompt = buildCustomAgentPrompt({
    rootDir: process.cwd(),
    promptRole: 'trading strategy operator agent',
    agent: { id: 'strategy-agent' },
    target: { type: 'strategy', id: 'target-1' },
    workspacePath: '/tmp/strategy-agent',
    controlPanel: {},
    context: {},
  });

  assert.match(prompt, /^You are a trading strategy operator agent\./);
  assert.doesNotMatch(prompt, /repo-defined custom Autonomy agent/);
});

test('custom agent worker lets agent prompt intro override prompt role', () => {
  const prompt = buildCustomAgentPrompt({
    rootDir: process.cwd(),
    promptRole: 'trading strategy operator agent',
    agent: {
      id: 'strategy-agent',
      promptIntro: 'You are the overnight crypto strategy operator.',
    },
    target: { type: 'strategy', id: 'target-1' },
    workspacePath: '/tmp/strategy-agent',
    controlPanel: {},
    context: {},
  });

  assert.match(prompt, /^You are the overnight crypto strategy operator\./);
  assert.doesNotMatch(prompt, /^You are a trading strategy operator agent\./);
});

test('custom agent prompt can allow explicit runtime-state recovery', () => {
  const prompt = buildCustomAgentPrompt({
    rootDir: process.cwd(),
    agent: { id: 'pressure-bot' },
    target: { type: 'project', id: 'fixture' },
    workspacePath: '/tmp/pressure-bot',
    controlPanel: {},
    context: {
      allowRuntimeStateChanges: true,
      workspaceReadWrite: ['.autonomy/helper-state.json'],
    },
  });

  assert.match(prompt, /"allowRuntimeStateChanges": true/);
  assert.match(prompt, /Repository runtime state changes are allowed only when explicitly required for local recovery/);
  assert.doesNotMatch(prompt, /Do not commit, push, merge, or change repository runtime state/);
});
