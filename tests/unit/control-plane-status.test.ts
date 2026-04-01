import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStatusSnapshot } from '../../src/autonomy-v2/control-plane/status-service.js';
import {
  CLI_BIN,
  createFixtureRepo,
  initAutonomyRepo,
  runNode,
} from '../smoke/package-smoke.helpers.js';

test('status snapshots include the current runtime and PRD state', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-fixture-');
  initAutonomyRepo(repoDir);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-status-001',
    '--title',
    'Status snapshot PRD',
    '--specification',
    'Validate the control plane status snapshot.',
  ]);

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.integrationBranch, 'dev');
  assert.equal(snapshot.prds.prds.length, 1);
  assert.equal(snapshot.prds.prds[0].id, 'prd-status-001');
  assert.equal(Array.isArray(snapshot.agentStatuses), true);
  assert.equal(snapshot.queues.length > 0, true);
});
