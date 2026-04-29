import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';

import { runControlPlaneBridgeOnce } from '../../src/server/control-plane/control-plane-bridge.js';
import {
  completeJob,
  createControlPlaneRestartJob,
  enqueueJob,
  getControlPlanePaths,
  loadControlPlaneState,
} from '../../src/server/control-plane/control-plane-store.js';
import {
  buildControlPlaneServiceLifecycleMetadata,
  writeControlPlaneServiceLifecycle,
} from '../../src/server/control-plane/control-plane-lifecycle.js';
import {
  createFixtureRepo,
  git,
  initAutonomyRepo,
} from '../smoke/package-smoke.helpers.js';

test('bridge executes default package update jobs without restarting services', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-update-');
  initAutonomyRepo(repoDir);
  writePackageUpdateManifest(repoDir, '1.0.0');
  const bridgeMarkerPath = path.join(os.tmpdir(), `autonomy-v2-bridge-update-no-restart-${Date.now()}.txt`);
  const serverMarkerPath = path.join(os.tmpdir(), `autonomy-v2-server-update-no-restart-${Date.now()}.txt`);
  fs.rmSync(bridgeMarkerPath, { force: true });
  fs.rmSync(serverMarkerPath, { force: true });
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.controlBridgeRestartCommand = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(bridgeMarkerPath)}, 'bridge restarted\\n', 'utf8')`],
  };
  controlPlaneConfig.serverRestartCommand = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(serverMarkerPath)}, 'server restarted\\n', 'utf8')`],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  const fakeBinDir = createFakePackageUpdateBin('9.9.9-test');
  let heartbeatCount = 0;
  let completedJob: any = null;
  const statusSnapshots: any[] = [];
  let jobClaimed = false;

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({
        job: {
          id: 'job-package-update-1',
          type: 'package:update',
          repoId: 'default',
          payload: {
            repoId: 'default',
          },
          status: 'claimed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      statusSnapshots.push(JSON.parse(await readRequestText(req)).snapshot);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      heartbeatCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
    restoreEnv('PATH', originalPath);
  });

  const logs = await captureProcessOutput(async () => {
    await runControlPlaneBridgeOnce(repoDir, {
      serverUrl,
      repoRoots: {
        default: repoDir,
      },
    });
  });

  assert.equal(heartbeatCount, 1);
  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.result.previousDeclaredVersion, '1.0.0');
  assert.equal(completedJob.result.newDeclaredVersion, '^9.9.9-test');
  assert.equal(completedJob.result.installedVersion, '9.9.9-test');
  assert.equal(completedJob.result.packageManager, 'npm');
  assert.equal(completedJob.result.refreshStatus, 'applied');
  assert.equal(completedJob.result.restartStatus, undefined);
  assert.equal(completedJob.result.updateCommand.status, 'defaulted');
  assert.equal(completedJob.result.updateCommand.mode, 'default-package-install');
  assert.equal(completedJob.result.updateCommand.packageSpec, '@asalaza6/autonomy-v2@latest');
  assert.deepEqual(completedJob.result.errors, []);
  assert.equal(statusSnapshots.some((snapshot) => snapshot.autonomyPackage.installedVersion === '9.9.9-test'), true);
  await assertFileMissingAfter(bridgeMarkerPath);
  await assertFileMissingAfter(serverMarkerPath);
  assert.match(logs.join('\n'), /bridge:package:update:start/);
  assert.match(logs.join('\n'), /bridge:package:update:done/);
  assert.doesNotMatch(logs.join('\n'), /bridge:job:claim-skipped/);
  assert.doesNotMatch(logs.join('\n'), /bridge:restart:deferred-launch/);
});

test('bridge executes custom package update command instead of default install', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-custom-update-');
  initAutonomyRepo(repoDir);
  writePackageUpdateManifest(repoDir, '1.0.0');
  const markerPath = path.join(os.tmpdir(), `autonomy-v2-custom-update-${Date.now()}.json`);
  fs.rmSync(markerPath, { force: true });
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.packageUpdateCommand = {
    command: process.execPath,
    args: ['-e', [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ cwd: process.cwd(), root: process.env.AUTONOMY_PACKAGE_UPDATE_ROOT }) + "\\n", "utf8");`,
      'console.log("custom update complete");',
    ].join('\n')],
    env: {
      AUTONOMY_CUSTOM_UPDATE: '1',
    },
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  const fakeBinDir = createFailingNpmBin();
  let completedJob: any = null;
  let jobClaimed = false;

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({
        job: {
          id: 'job-package-update-custom-1',
          type: 'package:update',
          repoId: 'default',
          payload: {
            repoId: 'default',
          },
          status: 'claimed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-custom-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-custom-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      await readRequestText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
    restoreEnv('PATH', originalPath);
  });

  await runControlPlaneBridgeOnce(repoDir, {
    serverUrl,
    repoRoots: {
      default: repoDir,
    },
  });

  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.cwd, fs.realpathSync(repoDir));
  assert.equal(marker.root, repoDir);
  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.result.updateCommand.status, 'completed');
  assert.equal(completedJob.result.updateCommand.mode, 'custom');
  assert.equal(completedJob.result.updateCommand.cwd, '.');
  assert.match(completedJob.result.updateCommand.output, /custom update complete/);
  assert.equal(completedJob.result.previousDeclaredVersion, '1.0.0');
  assert.equal(completedJob.result.newDeclaredVersion, '1.0.0');
  assert.equal(completedJob.result.restartStatus, undefined);
});

test('bridge runs autonomy-v2 package update config as npm run release:patch', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-release-update-');
  initAutonomyRepo(repoDir);
  writePackageUpdateManifest(repoDir, '1.0.0');
  const npmRecordPath = path.join(os.tmpdir(), `autonomy-v2-release-update-${Date.now()}.json`);
  fs.rmSync(npmRecordPath, { force: true });
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.packageUpdateCommand = 'npm run release:patch';
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  const fakeBinDir = createFakeNpmRunBin(npmRecordPath);
  let completedJob: any = null;
  let jobClaimed = false;

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({
        job: {
          id: 'job-package-update-release-1',
          type: 'package:update',
          repoId: 'default',
          payload: {
            repoId: 'default',
          },
          status: 'claimed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-release-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-release-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      await readRequestText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
    restoreEnv('PATH', originalPath);
  });

  await runControlPlaneBridgeOnce(repoDir, {
    serverUrl,
    repoRoots: {
      default: repoDir,
    },
  });

  const npmRecord = JSON.parse(fs.readFileSync(npmRecordPath, 'utf8'));
  assert.equal(npmRecord.cwd, fs.realpathSync(repoDir));
  assert.deepEqual(npmRecord.args, ['run', 'release:patch']);
  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.result.updateCommand.status, 'completed');
  assert.equal(completedJob.result.updateCommand.mode, 'custom');
  assert.equal(completedJob.result.updateCommand.command, 'npm run release:patch');
  assert.match(completedJob.result.updateCommand.output, /release patch published/);
});

test('bridge streams custom package update child logs when DEBUG=true', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-debug-update-');
  initAutonomyRepo(repoDir);
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.packageUpdateCommand = {
    command: process.execPath,
    args: ['-e', [
      'console.log("debug child stdout");',
      'console.error("debug child stderr");',
    ].join('\n')],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  let jobClaimed = false;
  let completedJob: any = null;

  const originalDebug = process.env.DEBUG;
  process.env.DEBUG = 'true';

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({
        job: {
          id: 'job-package-update-debug-1',
          type: 'package:update',
          repoId: 'default',
          payload: {
            repoId: 'default',
          },
          status: 'claimed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-debug-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-debug-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      await readRequestText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
    restoreEnv('DEBUG', originalDebug);
  });

  await runControlPlaneBridgeOnce(repoDir, {
    serverUrl,
    repoRoots: {
      default: repoDir,
    },
  });
  assert.match(completedJob.result.updateCommand.output, /debug child stdout/);
  assert.match(completedJob.result.updateCommand.output, /debug child stderr/);
});

test('bridge commits and pushes package update changes to the integration branch when repo is clean', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-commit-update-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({
    name: 'package-update-commit-fixture',
    private: true,
    version: '1.0.0',
  }, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'package.json']);
  git(repoDir, ['commit', '-m', 'add package manifest']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-package-remote-'));
  git(remoteDir, ['init', '--bare']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);
  git(repoDir, ['push', '-u', 'origin', 'main']);
  git(repoDir, ['push', '-u', 'origin', 'dev']);
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.packageUpdateCommand = {
    command: process.execPath,
    args: ['-e', [
      'const fs = require("fs");',
      'const path = require("path");',
      'const manifestPath = path.join(process.cwd(), "package.json");',
      'const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));',
      'manifest.version = "2.0.0";',
      'fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n", "utf8");',
      'console.log("package update committed");',
    ].join('\n')],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', path.relative(repoDir, controlPlaneConfigPath)]);
  git(repoDir, ['commit', '-m', 'configure custom package update']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);
  git(repoDir, ['push', '--force', 'origin', 'dev']);
  let completedJob: any = null;
  let jobClaimed = false;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({
        job: {
          id: 'job-package-update-commit-1',
          type: 'package:update',
          repoId: 'default',
          payload: {
            repoId: 'default',
          },
          status: 'claimed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-commit-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-commit-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      await readRequestText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
  });

  await runControlPlaneBridgeOnce(repoDir, {
    serverUrl,
    repoRoots: {
      default: repoDir,
    },
  });

  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.result.commit.committed, true);
  assert.equal(completedJob.result.commit.pushed, true);
  assert.match(completedJob.result.pushMessage, /pushed to origin\/dev/);
  assert.ok(completedJob.result.commitSha);
  const remoteManifest = JSON.parse(git(repoDir, ['--git-dir', remoteDir, 'show', 'refs/heads/dev:package.json']));
  assert.equal(remoteManifest.version, '2.0.0');
});

test('bridge commits package update changes even when unrelated files were already dirty', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-dirty-update-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({
    name: 'package-update-dirty-fixture',
    private: true,
    version: '1.0.0',
    optionalDependencies: {
      '@asalaza6/autonomy-v2': '^1.4.48',
    },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'package-lock.json'), `${JSON.stringify({
    name: 'package-update-dirty-fixture',
    lockfileVersion: 3,
    packages: {
      '': {
        optionalDependencies: {
          '@asalaza6/autonomy-v2': '^1.4.48',
        },
      },
    },
  }, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', 'package.json', 'package-lock.json']);
  git(repoDir, ['commit', '-m', 'add package files']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);
  const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-package-dirty-remote-'));
  git(remoteDir, ['init', '--bare']);
  git(repoDir, ['remote', 'add', 'origin', remoteDir]);
  git(repoDir, ['push', '-u', 'origin', 'main']);
  git(repoDir, ['push', '-u', 'origin', 'dev']);
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.packageUpdateCommand = {
    command: process.execPath,
    args: ['-e', [
      'const fs = require("fs");',
      'const path = require("path");',
      'const pkgPath = path.join(process.cwd(), "package.json");',
      'const lockPath = path.join(process.cwd(), "package-lock.json");',
      'const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));',
      'pkg.optionalDependencies["@asalaza6/autonomy-v2"] = "^1.4.49";',
      'fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\\n", "utf8");',
      'const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));',
      'lock.packages[""].optionalDependencies["@asalaza6/autonomy-v2"] = "^1.4.49";',
      'fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\\n", "utf8");',
      'console.log("package update committed with unrelated dirt");',
    ].join('\n')],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  git(repoDir, ['add', path.relative(repoDir, controlPlaneConfigPath)]);
  git(repoDir, ['commit', '-m', 'configure custom package update']);
  git(repoDir, ['branch', '-f', 'dev', 'HEAD']);
  git(repoDir, ['push', '--force', 'origin', 'dev']);
  fs.writeFileSync(path.join(repoDir, 'notes.txt'), 'keep local draft\n', 'utf8');
  let completedJob: any = null;
  let jobClaimed = false;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({
        job: {
          id: 'job-package-update-dirty-1',
          type: 'package:update',
          repoId: 'default',
          payload: {
            repoId: 'default',
          },
          status: 'claimed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-dirty-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-dirty-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      await readRequestText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
  });

  await runControlPlaneBridgeOnce(repoDir, {
    serverUrl,
    repoRoots: {
      default: repoDir,
    },
  });

  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.result.commit.committed, true);
  assert.equal(completedJob.result.commit.pushed, true);
  assert.match(completedJob.result.pushMessage, /pushed to origin\/dev/);
  const remoteManifest = JSON.parse(git(repoDir, ['--git-dir', remoteDir, 'show', 'refs/heads/dev:package.json']));
  assert.equal(remoteManifest.optionalDependencies['@asalaza6/autonomy-v2'], '^1.4.49');
  assert.equal(fs.readFileSync(path.join(repoDir, 'notes.txt'), 'utf8'), 'keep local draft\n');
});

test('bridge executes restart jobs independently after completion', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-restart-');
  const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-manager-state-'));
  const job = enqueueJob(managerRoot, createControlPlaneRestartJob({ repoId: 'default' }));
  initAutonomyRepo(repoDir);
  const bridgeMarkerPath = path.join(os.tmpdir(), `autonomy-v2-bridge-restart-${Date.now()}.txt`);
  const serverMarkerPath = path.join(os.tmpdir(), `autonomy-v2-server-restart-${Date.now()}.txt`);
  const sequencePath = path.join(os.tmpdir(), `autonomy-v2-restart-sequence-${Date.now()}.txt`);
  [bridgeMarkerPath, serverMarkerPath, sequencePath].forEach((filePath) => {
    fs.rmSync(filePath, { force: true });
  });
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.serverRestartCommand = {
    command: process.execPath,
    args: ['-e', [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(serverMarkerPath)}, "server restarted\\n", "utf8");`,
      `fs.appendFileSync(${JSON.stringify(sequencePath)}, "server\\n", "utf8");`,
    ].join('\n')],
  };
  controlPlaneConfig.controlBridgeRestartCommand = {
    command: process.execPath,
    args: ['-e', [
      'const fs = require("fs");',
      `const serverMarker = ${JSON.stringify(serverMarkerPath)};`,
      'const start = Date.now();',
      'while (!fs.existsSync(serverMarker) && Date.now() - start < 1000) {}',
      `fs.writeFileSync(${JSON.stringify(bridgeMarkerPath)}, "bridge restarted\\n", "utf8");`,
      `fs.appendFileSync(${JSON.stringify(sequencePath)}, "bridge\\n", "utf8");`,
    ].join('\n')],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  const completedJobs: any[] = [];
  const markerStatesAtComplete: boolean[] = [];
  let markerExistedAtHeartbeat = false;
  const requestEvents: string[] = [];
  let jobClaimed = false;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({ job }));
      return;
    }

    if (req.url === `/api/jobs/${job.id}/complete` && req.method === 'POST') {
      requestEvents.push('complete');
      markerStatesAtComplete.push(restartMarkerExists(bridgeMarkerPath, serverMarkerPath));
      const body = JSON.parse(await readRequestText(req));
      completedJobs.push(body);
      completeJob(managerRoot, job.id, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: job.id, status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      await readRequestText(req);
      requestEvents.push('status');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      requestEvents.push('heartbeat');
      markerExistedAtHeartbeat = restartMarkerExists(bridgeMarkerPath, serverMarkerPath);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
  });

  const logs = await captureConsoleLogs(async () => {
    await runControlPlaneBridgeOnce(repoDir, {
      serverUrl,
      repoRoots: {
        default: repoDir,
      },
    });
  });

  assert.equal(markerStatesAtComplete[0], false);
  assert.equal(markerExistedAtHeartbeat, false);
  assert.equal(completedJobs.length, 2);
  assert.ok(requestEvents.indexOf('status') >= 0);
  assert.ok(requestEvents.indexOf('status') < requestEvents.indexOf('complete'));
  assert.ok(requestEvents.indexOf('complete') < requestEvents.indexOf('heartbeat'));
  assert.equal(await waitForFileText(serverMarkerPath), 'server restarted\n');
  assert.equal(await waitForFileText(bridgeMarkerPath), 'bridge restarted\n');
  assert.equal(await waitForFileText(sequencePath), 'server\nbridge\n');
  assert.equal(completedJobs[0].status, 'completed');
  assert.equal(completedJobs[0].result.restartStatus.status, 'deferred');
  assert.equal(completedJobs[0].result.restartStatus.controlBridge.status, 'deferred');
  assert.equal(completedJobs[0].result.restartStatus.controlBridge.reason, 'after-job-completion');
  assert.equal(completedJobs[0].result.restartStatus.server.status, 'deferred');
  assert.equal(completedJobs[0].result.restartStatus.server.reason, 'after-job-completion');
  assert.equal(completedJobs[1].status, 'completed');
  assert.equal(completedJobs[1].result.restartStatus.status, 'restarted');
  assert.equal(completedJobs[1].result.restartStatus.controlBridge.status, 'restarted');
  assert.equal(completedJobs[1].result.restartStatus.controlBridge.reason, undefined);
  assert.equal(typeof completedJobs[1].result.restartStatus.controlBridge.completedAt, 'string');
  assert.equal(typeof completedJobs[1].result.restartStatus.controlBridge.postRestartPid, 'number');
  assert.equal(completedJobs[1].result.restartStatus.server.status, 'restarted');
  assert.equal(completedJobs[1].result.restartStatus.server.reason, undefined);
  assert.equal(typeof completedJobs[1].result.restartStatus.server.completedAt, 'string');
  assert.equal(typeof completedJobs[1].result.restartStatus.server.postRestartPid, 'number');
  assert.equal(typeof completedJobs[1].result.restartStatus.completedAt, 'string');
  assert.deepEqual(completedJobs[1].result.errors, []);
  const storedJob = loadControlPlaneState(managerRoot).jobs.find((entry) => entry.id === job.id);
  assert.equal(storedJob?.status, 'completed');
  assert.equal(storedJob?.result?.restartStatus?.status, 'restarted');
  assert.equal(storedJob?.result?.restartStatus?.controlBridge?.status, 'restarted');
  assert.equal(typeof storedJob?.result?.restartStatus?.controlBridge?.completedAt, 'string');
  assert.equal(typeof storedJob?.result?.restartStatus?.controlBridge?.postRestartPid, 'number');
  assert.equal(storedJob?.result?.restartStatus?.server?.status, 'restarted');
  assert.equal(typeof storedJob?.result?.restartStatus?.server?.completedAt, 'string');
  assert.equal(typeof storedJob?.result?.restartStatus?.server?.postRestartPid, 'number');
  assert.deepEqual(storedJob?.result?.errors, []);
  assert.match(logs.join('\n'), /bridge:restart:start/);
  assert.match(logs.join('\n'), /bridge:restart:deferred-launch/);
  assert.match(logs.join('\n'), /bridge:restart:deferred-complete/);
});

test('bridge persists default restart helper evidence back into the hosted restart job', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-restart-default-');
  const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-manager-default-state-'));
  const job = enqueueJob(managerRoot, createControlPlaneRestartJob({ repoId: 'default' }));
  initAutonomyRepo(repoDir);
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.restartLaunchMode = 'detached';
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');

  const probeScriptPath = writeRestartProbeScript(repoDir);
  const eventsPath = path.join(repoDir, 'restart-events.log');
  const serverPidPath = path.join(repoDir, 'server.pid');
  const bridgePidPath = path.join(repoDir, 'bridge.pid');
  [eventsPath, serverPidPath, bridgePidPath].forEach((filePath) => fs.rmSync(filePath, { force: true }));

  const serverProcess = startRestartProbe(repoDir, probeScriptPath, 'server', serverPidPath, eventsPath);
  const bridgeProcess = startRestartProbe(repoDir, probeScriptPath, 'controlBridge', bridgePidPath, eventsPath);
  t.after(async () => {
    await stopChild(serverProcess);
    await stopChild(bridgeProcess);
  });

  const originalServerPid = await waitForPidFile(serverPidPath);
  const originalBridgePid = await waitForPidFile(bridgePidPath);
  writeControlPlaneServiceLifecycle(repoDir, buildProbeLifecycle(
    'server',
    repoDir,
    probeScriptPath,
    serverPidPath,
    eventsPath,
    originalServerPid
  ));
  writeControlPlaneServiceLifecycle(repoDir, buildProbeLifecycle(
    'controlBridge',
    repoDir,
    probeScriptPath,
    bridgePidPath,
    eventsPath,
    originalBridgePid
  ));

  const completedJobs: any[] = [];
  let jobClaimed = false;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({ job }));
      return;
    }

    if (req.url === `/api/jobs/${job.id}/complete` && req.method === 'POST') {
      const body = JSON.parse(await readRequestText(req));
      completedJobs.push(body);
      completeJob(managerRoot, job.id, body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: job.id, status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      await readRequestText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
  });

  await runControlPlaneBridgeOnce(repoDir, {
    serverUrl,
    repoRoots: {
      default: repoDir,
    },
  });

  const relaunchedServerPid = await waitForChangedPid(serverPidPath, originalServerPid);
  const relaunchedBridgePid = await waitForChangedPid(bridgePidPath, originalBridgePid);
  await waitForFileText(eventsPath, 5000, /controlBridge:started:/);

  assert.equal(completedJobs.length, 2);
  assert.equal(completedJobs[0].result.restartStatus.status, 'deferred');
  assert.equal(completedJobs[1].result.restartStatus.status, 'restarted');
  assert.equal(completedJobs[1].result.restartStatus.helperStatus, 'restarted');
  assert.equal(completedJobs[1].result.restartStatus.server.status, 'restarted');
  assert.equal(completedJobs[1].result.restartStatus.server.restartLaunchMode, 'detached');
  assert.equal(completedJobs[1].result.restartStatus.server.requestedLaunchMode, 'detached');
  assert.equal(completedJobs[1].result.restartStatus.server.preRestartPid, originalServerPid);
  assert.equal(completedJobs[1].result.restartStatus.server.postRestartPid, relaunchedServerPid);
  assert.equal(typeof completedJobs[1].result.restartStatus.server.completedAt, 'string');
  assert.equal(completedJobs[1].result.restartStatus.controlBridge.status, 'restarted');
  assert.equal(completedJobs[1].result.restartStatus.controlBridge.restartLaunchMode, 'detached');
  assert.equal(completedJobs[1].result.restartStatus.controlBridge.preRestartPid, originalBridgePid);
  assert.equal(completedJobs[1].result.restartStatus.controlBridge.postRestartPid, relaunchedBridgePid);
  assert.equal(typeof completedJobs[1].result.restartStatus.controlBridge.completedAt, 'string');
  assert.equal(completedJobs[1].result.restartStatus.helperResults.length, 2);
  assert.deepEqual(completedJobs[1].result.errors, []);

  const storedManagerJob = loadControlPlaneState(managerRoot).jobs.find((entry) => entry.id === job.id);
  assert.equal(storedManagerJob?.result?.restartStatus?.status, 'restarted');
  assert.equal(storedManagerJob?.result?.restartStatus?.helperStatus, 'restarted');
  assert.equal(storedManagerJob?.result?.restartStatus?.server?.postRestartPid, relaunchedServerPid);
  assert.equal(storedManagerJob?.result?.restartStatus?.controlBridge?.postRestartPid, relaunchedBridgePid);

  const persistedRepoState = JSON.parse(fs.readFileSync(getControlPlanePaths(repoDir).statePath, 'utf8'));
  const storedRepoJob = persistedRepoState.jobs.find((entry: any) => entry.id === job.id);
  assert.equal(storedRepoJob?.result?.restartStatus?.status, 'restarted');
  assert.equal(storedRepoJob?.result?.restartStatus?.helperStatus, 'restarted');
});

test('bridge reports skipped restart when restart commands and lifecycle metadata are missing', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-restart-missing-');
  initAutonomyRepo(repoDir);
  let completedJob: any = null;
  let jobClaimed = false;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (jobClaimed) {
        res.end(JSON.stringify({ job: null }));
        return;
      }
      jobClaimed = true;
      res.end(JSON.stringify({
        job: {
          id: 'job-restart-missing-1',
          type: 'restart',
          repoId: 'default',
          payload: {
            repoId: 'default',
          },
          status: 'claimed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    if (req.url === '/api/jobs/job-restart-missing-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-restart-missing-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      await readRequestText(req);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ heartbeat: { kind: 'bridge', updatedAt: new Date().toISOString() } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
  });

  const logs = await captureConsoleLogs(async () => {
    await runControlPlaneBridgeOnce(repoDir, {
      serverUrl,
      repoRoots: {
        default: repoDir,
      },
    });
  });

  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.result.restartStatus.status, 'skipped');
  assert.equal(completedJob.result.restartStatus.controlBridge.status, 'skipped');
  assert.equal(completedJob.result.restartStatus.controlBridge.reason, 'missing-metadata');
  assert.equal(completedJob.result.restartStatus.server.status, 'skipped');
  assert.equal(completedJob.result.restartStatus.server.reason, 'missing-metadata');
  assert.deepEqual(completedJob.result.errors, []);
  assert.match(logs.join('\n'), /bridge:restart:done.*restart=skipped.*server=skipped.*bridge=skipped/);
  assert.doesNotMatch(logs.join('\n'), /bridge:restart:deferred-launch/);
});

function writePackageUpdateManifest(repoDir: string, previousVersion: string) {
  fs.writeFileSync(path.join(repoDir, 'package.json'), `${JSON.stringify({
    name: 'autonomy-control-plane-package-update-fixture',
    private: true,
    optionalDependencies: {
      '@asalaza6/autonomy-v2': previousVersion,
    },
  }, null, 2)}\n`, 'utf8');
}

function createFakePackageUpdateBin(installVersion: string) {
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-fake-update-bin-'));
  const fakeNpmPath = path.join(fakeBinDir, 'npm');
  fs.writeFileSync(fakeNpmPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const packageName = '@asalaza6/autonomy-v2';
const installVersion = ${JSON.stringify(installVersion)};
const cwd = process.cwd();
const args = process.argv.slice(2);
if (args[0] !== 'install') {
  throw new Error('fake npm only supports install');
}

const manifestPath = path.join(cwd, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.optionalDependencies = manifest.optionalDependencies || {};
manifest.optionalDependencies[packageName] = '^' + installVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n', 'utf8');

const targetRoot = path.join(cwd, 'node_modules', '@asalaza6', 'autonomy-v2');
fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(targetRoot, 'dist', 'bin'), { recursive: true });
fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify({
  name: packageName,
  version: installVersion,
}, null, 2) + '\\n', 'utf8');
fs.writeFileSync(path.join(targetRoot, 'dist', 'bin', 'autonomy-v2.js'), [
  "const payload = { rootDir: process.cwd(), created: [], skipped: [], removed: [], updated: ['config/control-plane.json'] };",
  "console.log(JSON.stringify(payload));",
  ''
].join('\\n'), 'utf8');
`, 'utf8');
  fs.chmodSync(fakeNpmPath, 0o755);
  return fakeBinDir;
}

function createFailingNpmBin() {
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-failing-npm-bin-'));
  const fakeNpmPath = path.join(fakeBinDir, 'npm');
  fs.writeFileSync(fakeNpmPath, `#!/usr/bin/env node
console.error('default npm install should not run for custom package update');
process.exit(42);
`, 'utf8');
  fs.chmodSync(fakeNpmPath, 0o755);
  return fakeBinDir;
}

function createFakeNpmRunBin(recordPath: string) {
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-fake-npm-run-bin-'));
  const fakeNpmPath = path.join(fakeBinDir, 'npm');
  fs.writeFileSync(fakeNpmPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  cwd: process.cwd(),
  args,
}) + '\\n', 'utf8');
if (args[0] !== 'run' || args[1] !== 'release:patch') {
  console.error('fake npm only supports run release:patch');
  process.exit(43);
}
console.log('release patch published');
`, 'utf8');
  fs.chmodSync(fakeNpmPath, 0o755);
  return fakeBinDir;
}

function restartMarkerExists(...filePaths: string[]) {
  return filePaths.some((filePath) => fs.existsSync(filePath));
}

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === 'undefined') {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to start test server.'));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function readRequestText(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function captureConsoleLogs(callback: () => Promise<void>) {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
    originalLog(...args);
  };
  try {
    await callback();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

async function captureProcessOutput(callback: () => Promise<void>) {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    lines.push(String(chunk || ''));
    return originalStdoutWrite(chunk, ...args);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any, ...args: any[]) => {
    lines.push(String(chunk || ''));
    return originalStderrWrite(chunk, ...args);
  }) as typeof process.stderr.write;
  try {
    await callback();
  } finally {
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
  }
  return lines;
}

async function waitForFileText(filePath: string, timeoutMs = 2000, pattern?: RegExp) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      const text = fs.readFileSync(filePath, 'utf8');
      if (!pattern || pattern.test(text)) {
        return text;
      }
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function assertFileMissingAfter(filePath: string, timeoutMs = 200) {
  await delay(timeoutMs);
  assert.equal(fs.existsSync(filePath), false);
}

function buildProbeLifecycle(
  kind: 'server' | 'controlBridge',
  rootDir: string,
  probeScriptPath: string,
  pidPath: string,
  eventsPath: string,
  pid: number
) {
  return buildControlPlaneServiceLifecycleMetadata(kind, {
    pid,
    cwd: rootDir,
    launch: {
      command: process.execPath,
      args: [probeScriptPath, kind, pidPath, eventsPath],
      cwd: rootDir,
      env: {},
    },
    matchTokens: [path.basename(probeScriptPath), kind],
  });
}

function writeRestartProbeScript(rootDir: string) {
  const scriptPath = path.join(rootDir, 'restart-probe.cjs');
  fs.writeFileSync(scriptPath, [
    "const fs = require('fs');",
    'const role = process.argv[2];',
    'const pidPath = process.argv[3];',
    'const eventsPath = process.argv[4];',
    "fs.writeFileSync(pidPath, `${process.pid}\\n`, 'utf8');",
    "fs.appendFileSync(eventsPath, `${role}:started:${process.pid}\\n`, 'utf8');",
    'const exitCode = Number(process.env.AUTONOMY_RESTART_PROBE_EXIT_CODE || 0);',
    'if (exitCode) {',
    "  fs.appendFileSync(eventsPath, `${role}:exiting:${process.pid}:${exitCode}\\n`, 'utf8');",
    '  process.exit(exitCode);',
    '}',
    'function shutdown() {',
    "  fs.appendFileSync(eventsPath, `${role}:stopped:${process.pid}\\n`, 'utf8');",
    '  process.exit(0);',
    '}',
    "process.on('SIGTERM', shutdown);",
    "process.on('SIGINT', shutdown);",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'), 'utf8');
  return scriptPath;
}

function startRestartProbe(
  rootDir: string,
  probeScriptPath: string,
  kind: 'server' | 'controlBridge',
  pidPath: string,
  eventsPath: string
) {
  return spawn(process.execPath, [probeScriptPath, kind, pidPath, eventsPath], {
    cwd: rootDir,
    stdio: 'ignore',
  });
}

async function waitForPidFile(filePath: string, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = readPidFile(filePath);
    if (pid && isProcessAlive(pid)) {
      return pid;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for PID file ${filePath}.`);
}

async function waitForChangedPid(filePath: string, previousPid: number, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pid = readPidFile(filePath);
    if (pid && pid !== previousPid && isProcessAlive(pid)) {
      return pid;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${filePath} to change from PID ${previousPid}.`);
}

function readPidFile(filePath: string) {
  try {
    const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch (_) {
    return 0;
  }
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (child.pid) {
    await stopPid(child.pid);
  }
}

async function stopPid(pid: number) {
  if (!pid || pid === process.pid || !isProcessAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    if (!isProcessAlive(pid)) {
      return;
    }
    await delay(20);
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (_) {
    // The process may have exited between the final poll and forced stop.
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
