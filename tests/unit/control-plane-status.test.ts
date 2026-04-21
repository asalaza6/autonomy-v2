import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildStatusSnapshot } from '../../src/autonomy-v2/control-plane/status-service.js';
import {
  CLI_BIN,
  createFixtureRepo,
  git,
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

  const output = runNode(CLI_BIN, [
    'status',
    '--root',
    repoDir,
  ]);
  assert.match(output, /PRDs:/);
  assert.match(output, /Active PRD:/);
});

test('status snapshots include deployment branch comparison details', () => {
  const repoDir = createFixtureRepo('autonomy-v2-status-deploy-');
  initAutonomyRepo(repoDir);
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ version: '1.0.0' }, null, 2) + '\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'add package version']);
  git(repoDir, ['branch', '-f', 'dev', 'main']);

  git(repoDir, ['checkout', 'dev']);
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ version: '1.1.0' }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'deploy.js'), 'export const deploy = true;\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'advance dev']);

  const snapshot = buildStatusSnapshot(repoDir);
  assert.equal(snapshot.deployment.sourceBranch, 'dev');
  assert.equal(snapshot.deployment.targetBranch, 'main');
  assert.equal(snapshot.deployment.branchesAligned, false);
  assert.equal(snapshot.deployment.hasChanges, true);
  assert.equal(snapshot.deployment.sourceAheadBy > 0, true);
  assert.match(snapshot.deployment.detail, /ahead of main/);
  assert.match(snapshot.deployment.version.currentVersion, /^1\.0\.0\+build\.\d+\.[a-f0-9]+$/);
  assert.match(snapshot.deployment.version.sourceVersion, /^1\.1\.0\+build\.\d+\.[a-f0-9]+$/);
  assert.match(snapshot.deployment.version.targetVersion, /^1\.0\.0\+build\.\d+\.[a-f0-9]+$/);
  assert.equal(snapshot.deployment.version.packageVersion, '1.0.0');
  assert.equal(snapshot.deployment.version.sourcePackageVersion, '1.1.0');
  assert.equal(snapshot.deployment.version.targetPackageVersion, '1.0.0');
  assert.equal(snapshot.deployment.version.isNewVersion, false);
});
