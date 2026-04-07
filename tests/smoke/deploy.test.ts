import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CLI_BIN,
  createFixtureRepo,
  initAutonomyRepo,
  git,
  runNode,
} from './package-smoke.helpers.js';

test('deploy command fast-forwards main to dev without creating a merge commit', () => {
  const repoDir = createFixtureRepo('autonomy-v2-deploy-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  git(repoDir, ['checkout', 'dev']);
  git(repoDir, ['merge', '--ff-only', 'main']);
  git(repoDir, ['checkout', 'main']);

  const originDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-deploy-origin-'));
  git(originDir, ['init', '--bare']);
  git(repoDir, ['remote', 'add', 'origin', originDir]);
  git(repoDir, ['push', '-u', 'origin', 'main']);
  git(repoDir, ['push', '-u', 'origin', 'dev']);

  git(repoDir, ['switch', 'dev']);
  fs.appendFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), '\nexport const deployed = true;\n', 'utf8');
  git(repoDir, ['add', 'src/apps/fixture/index.js']);
  git(repoDir, ['commit', '-m', 'feature on dev']);
  git(repoDir, ['switch', 'main']);

  const mainBefore = git(repoDir, ['rev-parse', 'main']);
  const devBefore = git(repoDir, ['rev-parse', 'dev']);
  assert.notEqual(mainBefore, devBefore);

  const output = runNode(CLI_BIN, [
    'deploy',
    '--root',
    repoDir,
  ]);

  const mainAfter = git(repoDir, ['rev-parse', 'main']);
  const remoteMainAfter = git(originDir, ['rev-parse', 'main']);
  const mainParents = git(repoDir, ['rev-list', '--parents', '-n', '1', 'main']).split(/\s+/);

  assert.equal(mainAfter, remoteMainAfter);
  assert.equal(mainAfter, devBefore);
  assert.equal(mainParents.length, 2);
  assert.match(output, /Deployed dev to main/);
  assert.match(output, /pushed to origin\/main/);
  assert.equal(git(repoDir, ['status', '--short']), '');
});
