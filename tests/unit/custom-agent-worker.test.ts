import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCustomAgentNetworkConfigOverrides } from '../../src/server/custom-agents/custom-agent-worker.js';

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
    'experimental_network.allowed_domains=["control.example"]',
    'experimental_network.open_world_enabled=false',
  ]);
});
