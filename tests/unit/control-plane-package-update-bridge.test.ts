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

test('bridge executes package update jobs and reports skipped restarts when commands are missing', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-update-');
  initAutonomyRepo(repoDir);
  writePackageUpdateManifest(repoDir, '1.0.0');
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
  assert.equal(completedJob.result.restartStatus.status, 'skipped');
  assert.equal(completedJob.result.restartStatus.controlBridge.status, 'skipped');
  assert.equal(completedJob.result.restartStatus.server.status, 'skipped');
  assert.deepEqual(completedJob.result.errors, []);
  assert.equal(statusSnapshots.some((snapshot) => snapshot.autonomyPackage.installedVersion === '9.9.9-test'), true);
  assert.match(logs.join('\n'), /bridge:package:update:start/);
  assert.match(logs.join('\n'), /bridge:package:update:done/);
});

test('bridge defers control bridge package update restart until after completion', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-restart-');
  initAutonomyRepo(repoDir);
  writePackageUpdateManifest(repoDir, '1.0.0');
  const bridgeMarkerPath = path.join(os.tmpdir(), `autonomy-v2-bridge-restart-${Date.now()}.txt`);
  const serverMarkerPath = path.join(os.tmpdir(), `autonomy-v2-server-restart-${Date.now()}.txt`);
  const statusMarkerPath = path.join(os.tmpdir(), `autonomy-v2-status-posted-${Date.now()}.txt`);
  const completeMarkerPath = path.join(os.tmpdir(), `autonomy-v2-complete-posted-${Date.now()}.txt`);
  const earlySignalPath = path.join(os.tmpdir(), `autonomy-v2-early-restart-${Date.now()}.txt`);
  [bridgeMarkerPath, serverMarkerPath, statusMarkerPath, completeMarkerPath, earlySignalPath].forEach((filePath) => {
    fs.rmSync(filePath, { force: true });
  });
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.controlBridgeRestartCommand = {
    command: process.execPath,
    args: ['-e', buildSelfRestartProbeScript()],
    env: {
      AUTONOMY_TEST_STATUS_MARKER: statusMarkerPath,
      AUTONOMY_TEST_COMPLETE_MARKER: completeMarkerPath,
      AUTONOMY_TEST_BRIDGE_MARKER: bridgeMarkerPath,
      AUTONOMY_TEST_EARLY_SIGNAL_MARKER: earlySignalPath,
      AUTONOMY_TEST_TARGET_PID: String(process.pid),
    },
  };
  controlPlaneConfig.serverRestartCommand = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(serverMarkerPath)}, 'server restarted\\n', 'utf8')`],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  const fakeBinDir = createFakePackageUpdateBin('9.9.10-test');
  let completedJob: any = null;
  let markerExistedAtComplete = false;
  let markerExistedAtHeartbeat = false;
  let earlyTerminateSignal = false;
  const requestEvents: string[] = [];

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;
  const onSigterm = () => {
    earlyTerminateSignal = true;
  };
  process.on('SIGTERM', onSigterm);

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs?status=queued&repoIds=default') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [
          {
            id: 'job-package-update-restart-1',
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

    if (req.url === '/api/jobs/job-package-update-restart-1/claim' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-restart-1', status: 'claimed' }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-restart-1/complete' && req.method === 'POST') {
      requestEvents.push('complete');
      markerExistedAtComplete = restartMarkerExists(bridgeMarkerPath, serverMarkerPath, earlySignalPath);
      completedJob = JSON.parse(await readRequestText(req));
      fs.writeFileSync(completeMarkerPath, 'complete posted\n', 'utf8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-restart-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      const body = JSON.parse(await readRequestText(req));
      const installedVersion = body.snapshot
        && body.snapshot.autonomyPackage
        && body.snapshot.autonomyPackage.installedVersion;
      if (installedVersion === '9.9.10-test') {
        requestEvents.push('status:updated');
        fs.writeFileSync(statusMarkerPath, 'status posted\n', 'utf8');
      } else {
        requestEvents.push('status');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      requestEvents.push('heartbeat');
      markerExistedAtHeartbeat = restartMarkerExists(bridgeMarkerPath, serverMarkerPath, earlySignalPath);
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
    process.off('SIGTERM', onSigterm);
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
  assert.equal(earlyTerminateSignal, false);
  assert.equal(fs.existsSync(earlySignalPath), false);
  assert.ok(requestEvents.indexOf('status:updated') >= 0);
  assert.ok(requestEvents.indexOf('status:updated') < requestEvents.indexOf('complete'));
  assert.ok(requestEvents.indexOf('complete') < requestEvents.indexOf('heartbeat'));
  assert.equal(await waitForFileText(serverMarkerPath), 'server restarted\n');
  assert.equal(await waitForFileText(bridgeMarkerPath), 'bridge restarted\n');
  assert.equal(completedJob.status, 'completed');
  assert.equal(completedJob.result.installedVersion, '9.9.10-test');
  assert.equal(completedJob.result.restartStatus.status, 'deferred');
  assert.equal(completedJob.result.restartStatus.controlBridge.status, 'deferred');
  assert.equal(completedJob.result.restartStatus.controlBridge.reason, 'after-job-completion');
  assert.equal(completedJob.result.restartStatus.server.status, 'deferred');
  assert.equal(completedJob.result.restartStatus.server.reason, 'after-job-completion');
  assert.deepEqual(completedJob.result.errors, []);
  assert.match(logs.join('\n'), /bridge:package:update:deferred-restart/);
});

test('bridge skips deferred package update restart when completion is not acknowledged', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-package-restart-failed-complete-');
  initAutonomyRepo(repoDir);
  writePackageUpdateManifest(repoDir, '1.0.0');
  const bridgeMarkerPath = path.join(os.tmpdir(), `autonomy-v2-bridge-restart-failed-complete-${Date.now()}.txt`);
  fs.rmSync(bridgeMarkerPath, { force: true });
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.controlBridgeRestartCommand = {
    command: process.execPath,
    args: ['-e', `require('fs').writeFileSync(${JSON.stringify(bridgeMarkerPath)}, 'bridge restarted\\n', 'utf8')`],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  const fakeBinDir = createFakePackageUpdateBin('9.9.11-test');
  let completeAttemptCount = 0;

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${process.env.PATH || ''}`;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs?status=queued&repoIds=default') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [
          {
            id: 'job-package-update-restart-2',
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

    if (req.url === '/api/jobs/job-package-update-restart-2/claim' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-package-update-restart-2', status: 'claimed' }));
      return;
    }

    if (req.url === '/api/jobs/job-package-update-restart-2/complete' && req.method === 'POST') {
      completeAttemptCount += 1;
      await readRequestText(req);
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'completion unavailable' }));
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

  const logs = await captureConsoleLogs(async () => {
    await runControlPlaneBridgeOnce(repoDir, {
      serverUrl,
      repoRoots: {
        default: repoDir,
      },
    });
  });

  await assertFileMissingAfter(bridgeMarkerPath);
  assert.equal(completeAttemptCount, 1);
  assert.match(logs.join('\n'), /bridge:package:update:deferred-restart-skipped/);
  assert.doesNotMatch(logs.join('\n'), /bridge:package:update:deferred-restart \|/);
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
