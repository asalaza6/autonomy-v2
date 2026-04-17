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
    if (req.url === '/api/jobs?status=queued') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jobs: [] }));
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

test('bridge executes deploy jobs for mapped repos', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-deploy-bridge-');
  initAutonomyRepo(repoDir);
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

  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/jobs?status=queued&repoIds=default') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jobs: [
          {
            id: 'job-deploy-1',
            type: 'deploy',
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

    if (req.url === '/api/jobs/job-deploy-1/claim' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'job-deploy-1', status: 'claimed' }));
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

  await runControlPlaneBridgeOnce(repoDir, {
    serverUrl,
    repoRoots: {
      default: repoDir,
    },
  });

  assert.equal(heartbeatCount, 1);
  assert.equal(Boolean(completedJob), true);
  assert.equal(completedJob.result.version.currentVersion, '1.1.0');
  assert.equal(completedJob.result.version.previousVersion, '1.0.0');
  assert.equal(completedJob.result.version.isNewVersion, true);
  assert.notEqual(git(repoDir, ['rev-parse', 'main']), mainBefore);
  assert.equal(git(repoDir, ['rev-parse', 'main']), git(repoDir, ['rev-parse', 'dev']));
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
