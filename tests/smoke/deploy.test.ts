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

test('deploy command runs configured deploy hook after main is updated', () => {
  const repoDir = createFixtureRepo('autonomy-v2-deploy-command-');
  initAutonomyRepo(repoDir);

  const markerPath = path.join(os.tmpdir(), `autonomy-v2-deploy-command-${Date.now()}.json`);
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.deployCommand = {
    command: process.execPath,
    args: [
      '-e',
      [
        "const fs = require('fs');",
        "const cp = require('child_process');",
        'const markerPath = process.argv[1];',
        "const read = (args) => cp.execFileSync('git', args, { encoding: 'utf8' }).trim();",
        'fs.writeFileSync(markerPath, JSON.stringify({',
        "  branch: read(['rev-parse', '--abbrev-ref', 'HEAD']),",
        "  main: read(['rev-parse', 'main']),",
        "  dev: read(['rev-parse', 'dev']),",
        '  source: process.env.AUTONOMY_DEPLOY_SOURCE_BRANCH,',
        '  target: process.env.AUTONOMY_DEPLOY_TARGET_BRANCH,',
        '  sha: process.env.AUTONOMY_DEPLOY_SHA,',
        "}) + '\\n', 'utf8');",
        "console.log('custom deploy hook ran');",
      ].join('\n'),
      markerPath,
    ],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');

  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  git(repoDir, ['checkout', 'dev']);
  git(repoDir, ['merge', '--ff-only', 'main']);

  fs.appendFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), '\nexport const hookDeploy = true;\n', 'utf8');
  git(repoDir, ['add', 'src/apps/fixture/index.js']);
  git(repoDir, ['commit', '-m', 'hook deploy change']);
  git(repoDir, ['switch', 'main']);

  const devBefore = git(repoDir, ['rev-parse', 'dev']);
  const output = runNode(CLI_BIN, [
    'deploy',
    '--root',
    repoDir,
  ]);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

  assert.equal(git(repoDir, ['rev-parse', 'main']), devBefore);
  assert.equal(marker.main, devBefore);
  assert.equal(marker.dev, devBefore);
  assert.equal(marker.sha, devBefore);
  assert.equal(marker.source, 'dev');
  assert.equal(marker.target, 'main');
  assert.equal(marker.branch, 'main');
  assert.match(output, /Ran deploy command:/);
  assert.match(output, /custom deploy hook ran/);
  assert.equal(git(repoDir, ['status', '--short']), '');
});
