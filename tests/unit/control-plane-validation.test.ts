import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeControlPlaneConfig,
  validatePrdAddSubmission,
} from '../../src/server/control-plane/control-plane-validation.js';
import { parseRepoRoots } from '../../src/server/control-plane/control-plane-main.js';
import { loadControlPlaneConfigFromEnv } from '../../src/server/control-plane/control-plane-config.js';

test('control plane config normalizes a default allowlist', () => {
  const config = normalizeControlPlaneConfig();
  assert.equal(config.repos.length, 1);
  assert.equal(config.repos[0].id, 'default');
});

test('prd submission validation enforces repo allowlist and required fields', () => {
  const config = normalizeControlPlaneConfig({
    repos: [
      {
        id: 'alpha',
        label: 'Alpha',
      },
    ],
  });

  assert.throws(() => validatePrdAddSubmission(config, {
    repoId: 'missing',
    id: 'prd-1',
    title: 'Example',
    specification: 'Spec text',
  }));

  assert.throws(() => validatePrdAddSubmission(config, {
    repoId: 'alpha',
    id: '',
    title: 'Example',
    specification: 'Spec text',
  }));

  const { payload } = validatePrdAddSubmission(config, {
    repoId: 'alpha',
    id: 'prd-1',
    title: 'Example',
    requirements: ['First requirement'],
  });

  assert.equal(payload.repoId, 'alpha');
  assert.equal(payload.id, 'prd-1');
  assert.deepEqual(payload.requirements, ['First requirement']);
});

test('bridge repo map defaults the current working directory when omitted', () => {
  const repoRoots = parseRepoRoots('', '/Users/me/projects/moving-game');
  assert.equal(repoRoots.default, '/Users/me/projects/moving-game');
});

test('control plane config can be provided from env json', () => {
  const originalConfigJson = process.env.AUTONOMY_CONTROL_PLANE_CONFIG_JSON;
  delete process.env.AUTONOMY_CONTROL_PLANE_CONFIG_JSON;
  try {
    process.env.AUTONOMY_CONTROL_PLANE_CONFIG_JSON = JSON.stringify({
      repos: [
        {
          id: 'alpha',
          label: 'Alpha',
        },
      ],
    });
    const config = loadControlPlaneConfigFromEnv();
    assert.equal(config.repos[0].id, 'alpha');
  } finally {
    if (typeof originalConfigJson === 'undefined') {
      delete process.env.AUTONOMY_CONTROL_PLANE_CONFIG_JSON;
    } else {
      process.env.AUTONOMY_CONTROL_PLANE_CONFIG_JSON = originalConfigJson;
    }
  }
});
