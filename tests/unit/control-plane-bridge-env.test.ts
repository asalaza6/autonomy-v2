import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { runControlPlaneBridgeOnce } from '../../src/server/control-plane/control-plane-bridge.js';
import {
  createFixtureRepo,
  git,
  initAutonomyRepo,
} from '../smoke/package-smoke.helpers.js';

test('bridge loads repo env during its startup cycle', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-env-'));
  fs.writeFileSync(path.join(rootDir, '.env.autonomy'), 'GITHUB_TOKEN=bridge-test-token\n', 'utf8');
  let heartbeatCount = 0;

  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;

  const server = http.createServer((req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job: null }));
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
    restoreEnv('GITHUB_TOKEN', originalGithubToken);
    restoreEnv('GH_TOKEN', originalGhToken);
  });

  await runControlPlaneBridgeOnce(rootDir, {
    serverUrl,
    repoRoots: {},
  });

  assert.equal(process.env.GITHUB_TOKEN, 'bridge-test-token');
  assert.equal(heartbeatCount, 1);
});

test('bridge heartbeat identifies the repo ids served by the bridge', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-bridge-heartbeat-');
  initAutonomyRepo(repoDir);
  let heartbeatBody: any = null;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs/claim-next' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ job: null }));
      return;
    }
    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/api/heartbeats/bridge' && req.method === 'POST') {
      heartbeatBody = JSON.parse(await readRequestText(req));
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

  assert.deepEqual(heartbeatBody.repoIds, ['default']);
});

test('bridge executes deploy jobs for mapped repos', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-deploy-bridge-');
  initAutonomyRepo(repoDir);
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.deployCommand = {
    command: process.execPath,
    args: ['-e', "console.log('bridge custom deploy hook')"],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ version: '1.0.0' }, null, 2) + '\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);
  git(repoDir, ['branch', '-f', 'dev', 'main']);
  git(repoDir, ['switch', 'dev']);
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ version: '1.1.0' }, null, 2) + '\n', 'utf8');
  fs.appendFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), '\nexport const bridgeDeploy = true;\n', 'utf8');
  git(repoDir, ['add', 'src/apps/fixture/index.js']);
  git(repoDir, ['add', 'package.json']);
  git(repoDir, ['commit', '-m', 'bridge deploy change']);
  git(repoDir, ['switch', 'main']);

  const mainBefore = git(repoDir, ['rev-parse', 'main']);
  let heartbeatCount = 0;
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
          id: 'job-deploy-1',
          type: 'deploy',
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

    if (req.url === '/api/jobs/job-deploy-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-deploy-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
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
  assert.equal(Boolean(completedJob), true);
  assert.match(completedJob.result.version.currentVersion, /^1\.1\.0\+build\.\d+\.[a-f0-9]+$/);
  assert.match(completedJob.result.version.previousVersion, /^1\.0\.0\+build\.\d+\.[a-f0-9]+$/);
  assert.equal(completedJob.result.version.packageVersion, '1.1.0');
  assert.equal(completedJob.result.version.previousPackageVersion, '1.0.0');
  assert.equal(completedJob.result.version.isNewVersion, true);
  assert.equal(completedJob.result.deployCommand.output, 'bridge custom deploy hook');
  assert.match(logs.join('\n'), /bridge:deploy:start/);
  assert.match(logs.join('\n'), /bridge:deploy:done/);
  assert.match(logs.join('\n'), /deployCommand=.*bridge custom deploy hook/);
  assert.notEqual(git(repoDir, ['rev-parse', 'main']), mainBefore);
  assert.equal(git(repoDir, ['rev-parse', 'main']), git(repoDir, ['rev-parse', 'dev']));
});

test('bridge executes agent chat jobs for mapped repos', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-chat-bridge-');
  initAutonomyRepo(repoDir);
  let heartbeatCount = 0;
  let completedJob: any = null;
  let jobClaimed = false;

  const originalChatStub = process.env.AUTONOMY_CONTROL_PLANE_CHAT_STUB;
  process.env.AUTONOMY_CONTROL_PLANE_CHAT_STUB = '1';

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
          id: 'job-chat-1',
          type: 'agent:chat',
          repoId: 'default',
          payload: {
            repoId: 'default',
            conversationId: 'chat-1',
            messageId: 'msg-manager-1',
            responseMessageId: 'msg-agent-1',
            prompt: 'Summarize the repo.',
            history: [],
          },
          status: 'claimed',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    if (req.url === '/api/jobs/job-chat-1/complete' && req.method === 'POST') {
      completedJob = JSON.parse(await readRequestText(req));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-chat-1', status: 'completed' }));
      return;
    }

    if (req.url === '/api/repos/default/status' && req.method === 'POST') {
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
    restoreEnv('AUTONOMY_CONTROL_PLANE_CHAT_STUB', originalChatStub);
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
  assert.match(completedJob.result.answer, /Repo default/);
  assert.match(completedJob.result.answer, /Summarize the repo/);
  assert.match(logs.join('\n'), /bridge:agent:chat:start/);
  assert.match(logs.join('\n'), /bridge:agent:chat:done/);
});

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
