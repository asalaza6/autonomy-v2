import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  CLI_BIN,
  createFixtureRepo,
  initAutonomyRepo,
  git,
  runNode,
} from './package-smoke.helpers.js';

function runDeploy(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI_BIN, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return {
      ok: true,
      stdout,
      stderr: '',
    };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: String(execError.stdout || '').trim(),
      stderr: String(execError.stderr || '').trim(),
    };
  }
}

function readControlPlaneConfig(repoDir) {
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  return {
    controlPlaneConfigPath,
    controlPlaneConfig: JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8')),
  };
}

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

test('deploy command still rejects dirty working trees when auto-stash is unset', () => {
  const repoDir = createFixtureRepo('autonomy-v2-deploy-dirty-default-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  git(repoDir, ['checkout', 'dev']);
  git(repoDir, ['merge', '--ff-only', 'main']);
  fs.appendFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), '\nexport const dirtyDefault = true;\n', 'utf8');
  git(repoDir, ['add', 'src/apps/fixture/index.js']);
  git(repoDir, ['commit', '-m', 'dev deploy change']);
  git(repoDir, ['switch', 'main']);

  const mainBefore = git(repoDir, ['rev-parse', 'main']);
  fs.appendFileSync(path.join(repoDir, 'README.md'), 'dirty working tree\n', 'utf8');

  const result = runDeploy(['deploy', '--root', repoDir]);

  assert.equal(result.ok, false);
  assert.match(result.stdout, /Starting deploy dev -> main/);
  assert.match(result.stdout, /Deploy failed: Working tree must be clean before deploy\./);
  assert.match(result.stderr, /ERROR: Working tree must be clean before deploy\./);
  assert.equal(git(repoDir, ['rev-parse', 'main']), mainBefore);
  assert.match(git(repoDir, ['status', '--short']), /README\.md/);
});

test('deploy command runs configured deploy hook after main is updated', () => {
  const repoDir = createFixtureRepo('autonomy-v2-deploy-command-');
  initAutonomyRepo(repoDir);

  const markerPath = path.join(os.tmpdir(), `autonomy-v2-deploy-command-${Date.now()}.json`);
  const { controlPlaneConfigPath, controlPlaneConfig } = readControlPlaneConfig(repoDir);
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

test('deploy command reads deploy hook from source branch when current main lacks it', () => {
  const repoDir = createFixtureRepo('autonomy-v2-deploy-command-source-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy without deploy hook']);
  git(repoDir, ['checkout', 'dev']);
  git(repoDir, ['merge', '--ff-only', 'main']);

  const markerPath = path.join(os.tmpdir(), `autonomy-v2-deploy-command-source-${Date.now()}.json`);
  const { controlPlaneConfigPath, controlPlaneConfig } = readControlPlaneConfig(repoDir);
  controlPlaneConfig.deployCommand = {
    command: process.execPath,
    args: [
      '-e',
      [
        "const fs = require('fs');",
        'const markerPath = process.argv[1];',
        'fs.writeFileSync(markerPath, JSON.stringify({',
        '  source: process.env.AUTONOMY_DEPLOY_SOURCE_BRANCH,',
        '  target: process.env.AUTONOMY_DEPLOY_TARGET_BRANCH,',
        '  sha: process.env.AUTONOMY_DEPLOY_SHA,',
        "}) + '\\n', 'utf8');",
        "console.log('source branch deploy hook ran');",
      ].join('\n'),
      markerPath,
    ],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  fs.appendFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), '\nexport const sourceHookDeploy = true;\n', 'utf8');
  git(repoDir, ['add', 'prompts/autonomous/v2/config/control-plane.json']);
  git(repoDir, ['add', 'src/apps/fixture/index.js']);
  git(repoDir, ['commit', '-m', 'add deploy hook on dev']);
  git(repoDir, ['switch', 'main']);

  const mainControlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(mainControlPlaneConfig, 'deployCommand'), false);
  const devBefore = git(repoDir, ['rev-parse', 'dev']);
  const output = runNode(CLI_BIN, [
    'deploy',
    '--root',
    repoDir,
  ]);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));

  assert.equal(git(repoDir, ['rev-parse', 'main']), devBefore);
  assert.equal(marker.sha, devBefore);
  assert.equal(marker.source, 'dev');
  assert.equal(marker.target, 'main');
  assert.match(output, /Ran deploy command:/);
  assert.match(output, /source branch deploy hook ran/);
  assert.equal(git(repoDir, ['status', '--short']), '');
});

test('deploy command auto-stashes tracked and untracked changes and restores them after deploy', () => {
  const repoDir = createFixtureRepo('autonomy-v2-deploy-auto-stash-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  fs.writeFileSync(path.join(repoDir, 'tracked-local.txt'), 'baseline\n', 'utf8');
  git(repoDir, ['add', 'tracked-local.txt']);
  git(repoDir, ['commit', '-m', 'add tracked local file']);
  git(repoDir, ['checkout', 'dev']);
  git(repoDir, ['merge', '--ff-only', 'main']);
  fs.appendFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), '\nexport const autoStashDeploy = true;\n', 'utf8');
  git(repoDir, ['add', 'src/apps/fixture/index.js']);
  git(repoDir, ['commit', '-m', 'deployable change']);
  const devBefore = git(repoDir, ['rev-parse', 'dev']);
  git(repoDir, ['switch', 'main']);

  const trackedPath = path.join(repoDir, 'tracked-local.txt');
  const trackedContentBefore = fs.readFileSync(trackedPath, 'utf8');
  const trackedChange = `${trackedContentBefore}local dirty change\n`;
  fs.writeFileSync(trackedPath, trackedChange, 'utf8');
  const untrackedPath = path.join(repoDir, 'tmp-untracked.txt');
  fs.writeFileSync(untrackedPath, 'preserve me\n', 'utf8');

  const output = runNode(CLI_BIN, [
    'deploy',
    '--root',
    repoDir,
    '--auto-stash',
  ]);

  assert.equal(git(repoDir, ['rev-parse', 'main']), devBefore);
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), trackedChange);
  assert.equal(fs.readFileSync(untrackedPath, 'utf8'), 'preserve me\n');
  assert.equal(git(repoDir, ['stash', 'list']), '');
  assert.match(output, /Starting deploy dev -> main/);
  assert.match(output, /Created auto-stash before deploy: stash@\{/);
  assert.match(output, /Deployed dev to main/);
  assert.match(output, /Restored auto-stash: stash@\{/);
});

test('deploy command restores auto-stashed changes after a deploy hook failure', () => {
  const repoDir = createFixtureRepo('autonomy-v2-deploy-auto-stash-fail-');
  initAutonomyRepo(repoDir);
  const { controlPlaneConfigPath, controlPlaneConfig } = readControlPlaneConfig(repoDir);
  controlPlaneConfig.deployCommand = {
    command: process.execPath,
    args: ['-e', "console.error('deploy hook failed'); process.exit(2);"],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  fs.writeFileSync(path.join(repoDir, 'tracked-local.txt'), 'baseline\n', 'utf8');
  git(repoDir, ['add', 'tracked-local.txt']);
  git(repoDir, ['commit', '-m', 'add tracked local file']);
  git(repoDir, ['checkout', 'dev']);
  git(repoDir, ['merge', '--ff-only', 'main']);
  fs.appendFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), '\nexport const autoStashFailure = true;\n', 'utf8');
  git(repoDir, ['add', 'src/apps/fixture/index.js']);
  git(repoDir, ['commit', '-m', 'deployable change']);
  const devBefore = git(repoDir, ['rev-parse', 'dev']);
  git(repoDir, ['switch', 'main']);

  const trackedPath = path.join(repoDir, 'tracked-local.txt');
  const trackedContentBefore = fs.readFileSync(trackedPath, 'utf8');
  const trackedChange = `${trackedContentBefore}recover after failure\n`;
  fs.writeFileSync(trackedPath, trackedChange, 'utf8');
  const untrackedPath = path.join(repoDir, 'recover-after-failure.txt');
  fs.writeFileSync(untrackedPath, 'still here\n', 'utf8');

  const result = runDeploy([
    'deploy',
    '--root',
    repoDir,
    '--auto-stash',
  ]);

  assert.equal(result.ok, false);
  assert.equal(git(repoDir, ['rev-parse', 'main']), devBefore);
  assert.equal(fs.readFileSync(trackedPath, 'utf8'), trackedChange);
  assert.equal(fs.readFileSync(untrackedPath, 'utf8'), 'still here\n');
  assert.equal(git(repoDir, ['stash', 'list']), '');
  assert.match(result.stdout, /Created auto-stash before deploy: stash@\{/);
  assert.match(result.stdout, /Deploy failed: Deploy command .* failed with exit code 2/);
  assert.match(result.stdout, /deploy hook failed/);
  assert.match(result.stdout, /Restored auto-stash: stash@\{/);
});

test('deploy command reports auto-stash restore conflicts with recovery instructions', () => {
  const repoDir = createFixtureRepo('autonomy-v2-deploy-auto-stash-conflict-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  git(repoDir, ['checkout', 'dev']);
  git(repoDir, ['merge', '--ff-only', 'main']);

  const trackedPath = path.join(repoDir, 'src', 'apps', 'fixture', 'index.js');
  fs.writeFileSync(trackedPath, 'export const value = 2;\n', 'utf8');
  git(repoDir, ['add', 'src/apps/fixture/index.js']);
  git(repoDir, ['commit', '-m', 'dev changes tracked file']);
  git(repoDir, ['switch', 'main']);
  fs.writeFileSync(trackedPath, 'export const value = 99;\n', 'utf8');

  const result = runDeploy([
    'deploy',
    '--root',
    repoDir,
    '--auto-stash',
  ]);

  assert.equal(result.ok, false);
  assert.match(result.stdout, /Created auto-stash before deploy: stash@\{/);
  assert.match(result.stdout, /Deploy completed, but auto-stash restore did not finish cleanly:/);
  assert.match(result.stdout, /WARNING: Auto-stash restore conflicted:/);
  assert.match(result.stdout, /Inspect the current conflicts with "git status"\./);
  assert.match(result.stderr, /ERROR: Deploy reached main, but auto-stash restore conflicted\./);
  assert.match(git(repoDir, ['stash', 'list']), /autonomy-v2 deploy auto-stash/);
});
