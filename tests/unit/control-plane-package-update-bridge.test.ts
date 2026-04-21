import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { runControlPlaneBridgeOnce } from '../../src/server/control-plane/control-plane-bridge.js';
import {
  createFixtureRepo,
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

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs?status=queued&repoIds=default') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [
          {
            id: 'job-package-update-1',
            type: 'package:update',
            repoId: 'default',
            payload: {
              repoId: 'default',
            },
            status: 'queued',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-1/claim' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-1', status: 'claimed' }));
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

  const logs = await captureConsoleLogs(async () => {
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

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs?status=queued&repoIds=default') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [
          {
            id: 'job-package-update-custom-1',
            type: 'package:update',
            repoId: 'default',
            payload: {
              repoId: 'default',
            },
            status: 'queued',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-custom-1/claim' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-custom-1', status: 'claimed' }));
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

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs?status=queued&repoIds=default') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [
          {
            id: 'job-package-update-release-1',
            type: 'package:update',
            repoId: 'default',
            payload: {
              repoId: 'default',
            },
            status: 'queued',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-release-1/claim' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-release-1', status: 'claimed' }));
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

test('bridge executes restart jobs independently after completion', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-restart-');
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
  let completedJob: any = null;
  let markerExistedAtComplete = false;
  let markerExistedAtHeartbeat = false;
  const requestEvents: string[] = [];

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs?status=queued&repoIds=default') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [
          {
            id: 'job-restart-1',
            type: 'restart',
            repoId: 'default',
            payload: {
              repoId: 'default',
            },
            status: 'queued',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }));
      return;
    }

    if (req.url === '/api/jobs/job-restart-1/claim' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-restart-1', status: 'claimed' }));
      return;
    }

    if (req.url === '/api/jobs/job-restart-1/complete' && req.method === 'POST') {
      requestEvents.push('complete');
      markerExistedAtComplete = restartMarkerExists(bridgeMarkerPath, serverMarkerPath);
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-restart-1', status: 'completed' }));
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

  assert.equal(markerExistedAtComplete, false);
  assert.equal(markerExistedAtHeartbeat, false);
  assert.ok(requestEvents.indexOf('status') >= 0);
  assert.ok(requestEvents.indexOf('status') < requestEvents.indexOf('complete'));
  assert.ok(requestEvents.indexOf('complete') < requestEvents.indexOf('heartbeat'));
  assert.equal(await waitForFileText(serverMarkerPath), 'server restarted\n');
  assert.equal(await waitForFileText(bridgeMarkerPath), 'bridge restarted\n');
  assert.equal(await waitForFileText(sequencePath), 'server\nbridge\n');
  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.result.restartStatus.status, 'deferred');
  assert.equal(completedJob.result.restartStatus.controlBridge.status, 'deferred');
  assert.equal(completedJob.result.restartStatus.controlBridge.reason, 'after-job-completion');
  assert.equal(completedJob.result.restartStatus.server.status, 'deferred');
  assert.equal(completedJob.result.restartStatus.server.reason, 'after-job-completion');
  assert.deepEqual(completedJob.result.errors, []);
  assert.match(logs.join('\n'), /bridge:restart:start/);
  assert.match(logs.join('\n'), /bridge:restart:deferred-launch/);
});

test('bridge reports skipped restart when restart commands are missing', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-restart-missing-');
  initAutonomyRepo(repoDir);
  let completedJob: any = null;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs?status=queued&repoIds=default') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [
          {
            id: 'job-restart-missing-1',
            type: 'restart',
            repoId: 'default',
            payload: {
              repoId: 'default',
            },
            status: 'queued',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }));
      return;
    }

    if (req.url === '/api/jobs/job-restart-missing-1/claim' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-restart-missing-1', status: 'claimed' }));
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
  assert.equal(completedJob.result.restartStatus.server.status, 'skipped');
  assert.deepEqual(completedJob.result.errors, []);
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

function buildSelfRestartProbeScript() {
  return [
    "const fs = require('fs');",
    'const statusMarker = process.env.AUTONOMY_TEST_STATUS_MARKER;',
    'const completeMarker = process.env.AUTONOMY_TEST_COMPLETE_MARKER;',
    'const bridgeMarker = process.env.AUTONOMY_TEST_BRIDGE_MARKER;',
    'const earlySignalMarker = process.env.AUTONOMY_TEST_EARLY_SIGNAL_MARKER;',
    'const targetPid = Number(process.env.AUTONOMY_TEST_TARGET_PID);',
    'if (!fs.existsSync(statusMarker) || !fs.existsSync(completeMarker)) {',
    "  fs.writeFileSync(earlySignalMarker, 'early restart\\n', 'utf8');",
    "  process.kill(targetPid, 'SIGTERM');",
    '  process.exit(1);',
    '}',
    "fs.writeFileSync(bridgeMarker, 'bridge restarted\\n', 'utf8');",
  ].join('\n');
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

async function waitForFileText(filePath: string, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function assertFileMissingAfter(filePath: string, timeoutMs = 200) {
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  assert.equal(fs.existsSync(filePath), false);
}
