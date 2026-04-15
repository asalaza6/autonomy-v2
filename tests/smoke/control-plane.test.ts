import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import {
  CONTROL_BIN,
  createFixtureRepo,
  git,
  initAutonomyRepo,
  SERVER_BIN,
  runNode,
} from './package-smoke.helpers.js';

test('control plane queues a browser PRD and the bridge executes it on the local repo', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-');
  initAutonomyRepo(repoDir);

  const port = await getFreePort();
  const server = spawn(process.execPath, [
    CONTROL_BIN,
    'serve',
    '--root',
    repoDir,
    '--port',
    String(port),
  ], {
    cwd: path.join(repoDir, '.'),
    env: {
      ...process.env,
      AUTONOMY_CONTROL_PLANE_PERSIST: '0',
      PATH: process.env.PATH || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stopServer = async () => {
    if (server.exitCode !== null || server.signalCode !== null) {
      return;
    }
    server.kill('SIGTERM');
    await onceExit(server);
  };

  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/repos`);

  const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(rootResponse.status, 404);
  const rootHtml = await rootResponse.text();
  assert.match(rootHtml, /Page not found\./);

    const html = await (await fetch(`http://127.0.0.1:${port}/manager`)).text();
    assert.match(html, /Status dashboard/);
    assert.match(html, /control-plane-heartbeats/);
    assert.match(html, /control-plane-client\.js/);
    assert.doesNotMatch(html, /Submit PRD/);
    assert.doesNotMatch(html, /Advanced/);
    assert.doesNotMatch(html, /Bridge queue/);

    runNode(CONTROL_BIN, [
      'bridge',
      '--root',
      repoDir,
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--repo-map',
      repoDir,
      '--once',
    ]);

    const reposAfterRegistration = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/repos`);
    assert.equal(reposAfterRegistration.repos.length, 1);
    assert.equal(reposAfterRegistration.repos[0].repoId, 'default');

    const response = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'default',
        id: 'prd-control-001',
        title: 'Control plane PRD',
        specification: 'Queue this PRD from the browser control plane.',
      }),
    });
    assert.equal(response.status, 201);

    runNode(SERVER_BIN, [
      'tick',
      '--root',
      repoDir,
      '--control-plane-url',
      `http://127.0.0.1:${port}`,
      '--json',
    ]);

    const stateAfterQueue = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/state`);
    assert.equal(stateAfterQueue.jobs.length, 1);
    assert.equal(stateAfterQueue.jobs[0].status, 'queued');
    assert.equal(stateAfterQueue.dashboard.repoCount, 1);
    assert.equal(stateAfterQueue.dashboard.serverHeartbeat.status, 'online');
    assert.notEqual(stateAfterQueue.dashboard.bridgeHeartbeat.status, 'offline');

    const projectHtml = await (await fetch(`http://127.0.0.1:${port}/project/default`)).text();
    assert.match(projectHtml, /Repository-scoped control plane/);
    assert.match(projectHtml, /Submit PRD/);
    assert.match(projectHtml, /Advanced/);
    assert.doesNotMatch(projectHtml, /<select id="repo-id"/);

    const unknownProjectResponse = await fetch(`http://127.0.0.1:${port}/project/testadfasdf`);
    assert.equal(unknownProjectResponse.status, 404);
    assert.match(await unknownProjectResponse.text(), /Page not found\./);

    runNode(CONTROL_BIN, [
      'bridge',
      '--root',
      repoDir,
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--repo-map',
      repoDir,
      '--once',
    ]);

    const stateAfterBridge = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/state`);
    assert.equal(stateAfterBridge.jobs[0].status, 'completed');
    assert.equal(stateAfterBridge.repoStatuses.default.repoId, 'default');
    assert.equal(stateAfterBridge.repoStatuses.default.snapshot.integrationBranch, 'dev');
    assert.match(stateAfterBridge.dashboard.repos[0].overview, /PRD/);
    assert.equal(stateAfterBridge.dashboard.jobs[0].statusLabel, 'Completed and committed');
    assert.equal(stateAfterBridge.dashboard.bridgeHeartbeat.status, 'online');

    const committedPrdSpec = git(repoDir, [
      'show',
      'dev:prompts/autonomous/v2/specs/prds/prd-control-001.json',
    ]);
    assert.match(committedPrdSpec, /"id": "prd-control-001"/);
  } finally {
    await stopServer();
  }
});

test('local control plane can serve local UI while proxying API traffic to a hosted manager', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-proxy-');
  initAutonomyRepo(repoDir);

  const remotePort = await getFreePort();
  let postedJobBody = '';
  const remoteServer = await startJsonServer(remotePort, async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${remotePort}`);
    if (requestUrl.pathname === '/api/repos' && req.method === 'GET') {
      sendJson(res, 200, {
        repos: [
          {
            repoId: 'alpha',
            label: 'Alpha',
            description: 'Remote repo',
          },
        ],
      });
      return;
    }
    if (requestUrl.pathname === '/api/state' && req.method === 'GET') {
      sendJson(res, 200, {
        jobs: [],
        dashboard: {
          repoCount: 1,
          repos: [
            {
              repoId: 'alpha',
              label: 'Alpha',
              description: 'Remote repo',
              overview: 'Remote state',
            },
          ],
          jobs: [],
        },
      });
      return;
    }
    if (requestUrl.pathname === '/api/jobs' && req.method === 'POST') {
      postedJobBody = await readRequestText(req);
      sendJson(res, 201, {
        id: 'job-remote-1',
        status: 'queued',
      });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });

  const localPort = await getFreePort();
  const localServer = spawn(process.execPath, [
    CONTROL_BIN,
    'serve',
    '--root',
    repoDir,
    '--port',
    String(localPort),
    '--dev',
    '--proxy-url',
    `http://127.0.0.1:${remotePort}`,
  ], {
    cwd: path.join(repoDir, '.'),
    env: {
      ...process.env,
      AUTONOMY_CONTROL_PLANE_PERSIST: '0',
      PATH: process.env.PATH || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stopLocalServer = async () => {
    if (localServer.exitCode !== null || localServer.signalCode !== null) {
      return;
    }
    localServer.kill('SIGTERM');
    await onceExit(localServer);
  };

  try {
    await waitForHttp(`http://127.0.0.1:${localPort}/api/repos`);

    const html = await (await fetch(`http://127.0.0.1:${localPort}/manager`)).text();
    assert.match(html, /Status dashboard/);

    const repos = await fetchJson(`http://127.0.0.1:${localPort}/api/repos`);
    assert.equal(repos.repos.length, 1);
    assert.equal(repos.repos[0].repoId, 'alpha');

    const unknownProjectResponse = await fetch(`http://127.0.0.1:${localPort}/project/testadfasdf`);
    assert.equal(unknownProjectResponse.status, 404);
    assert.match(await unknownProjectResponse.text(), /Page not found\./);

    const state = await fetchJson(`http://127.0.0.1:${localPort}/api/state`);
    assert.equal(state.dashboard.repoCount, 1);
    assert.equal(state.dashboard.repos[0].repoId, 'alpha');

    const devMeta = await fetchJson(`http://127.0.0.1:${localPort}/api/dev-meta`);
    assert.equal(devMeta.devMode, true);

    const queueResponse = await fetch(`http://127.0.0.1:${localPort}/api/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'alpha',
        id: 'prd-remote-001',
        title: 'Proxy queue test',
        specification: 'Queue through local proxy.',
      }),
    });
    assert.equal(queueResponse.status, 201);
    assert.match(postedJobBody, /"repoId":"alpha"/);
    assert.match(postedJobBody, /"id":"prd-remote-001"/);
  } finally {
    await stopLocalServer();
    await closeServer(remoteServer);
  }
});

test('local control plane can bootstrap a direct remote API base URL for browser requests', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-api-base-');
  initAutonomyRepo(repoDir);

  const localPort = await getFreePort();
  const localServer = spawn(process.execPath, [
    CONTROL_BIN,
    'serve',
    '--root',
    repoDir,
    '--port',
    String(localPort),
    '--dev',
    '--api-base-url',
    'https://autonomy-v2-mgr-703614-45205c824326.herokuapp.com',
  ], {
    cwd: path.join(repoDir, '.'),
    env: {
      ...process.env,
      AUTONOMY_CONTROL_PLANE_PERSIST: '0',
      PATH: process.env.PATH || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stopLocalServer = async () => {
    if (localServer.exitCode !== null || localServer.signalCode !== null) {
      return;
    }
    localServer.kill('SIGTERM');
    await onceExit(localServer);
  };

  try {
    await waitForHttp(`http://127.0.0.1:${localPort}/api/dev-meta`);

    const html = await (await fetch(`http://127.0.0.1:${localPort}/manager`)).text();
    assert.match(
      html,
      /__AUTONOMY_CONTROL_PLANE_API_BASE_URL__="https:\/\/autonomy-v2-mgr-703614-45205c824326\.herokuapp\.com"/
    );

    const devMeta = await fetchJson(`http://127.0.0.1:${localPort}/api/dev-meta`);
    assert.equal(devMeta.devMode, true);
  } finally {
    await stopLocalServer();
  }
});

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function fetchJsonWithRetry(url: string, timeoutMs = 10000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out fetching ${url}`);
}

async function waitForHttp(url: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch (_) {
      // Retry until the server is ready.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    child.once('exit', resolve);
  });
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload)}\n`);
}

async function readRequestText(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function startJsonServer(port, handler) {
  const server = await import('http').then(({ createServer }) => createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  }));
  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(undefined));
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve(undefined));
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to find a free port.'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
