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

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /Dashboard/);
    assert.match(html, /Submit PRD/);
    assert.match(html, /Advanced/);
    assert.match(html, /Status dashboard/);
    assert.match(html, /Active PRD/);
    assert.match(html, /Queued PRDs/);

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

    const stateAfterQueue = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/state`);
    assert.equal(stateAfterQueue.jobs.length, 1);
    assert.equal(stateAfterQueue.jobs[0].status, 'queued');
    assert.equal(stateAfterQueue.dashboard.repoCount, 1);
    assert.equal(Array.isArray(stateAfterQueue.dashboard.repos), true);

    runNode(CONTROL_BIN, [
      'bridge',
      '--root',
      repoDir,
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--repo-map',
      `default=${repoDir}`,
      '--once',
    ]);

    const stateAfterBridge = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/state`);
    assert.equal(stateAfterBridge.jobs[0].status, 'completed');
    assert.equal(stateAfterBridge.repoStatuses.default.repoId, 'default');
    assert.equal(stateAfterBridge.repoStatuses.default.snapshot.integrationBranch, 'dev');
    assert.match(stateAfterBridge.dashboard.repos[0].overview, /PRD/);
    assert.equal(stateAfterBridge.dashboard.jobs[0].statusLabel, 'Completed and committed');

    const committedPrdSpec = git(repoDir, [
      'show',
      'dev:prompts/autonomous/v2/specs/prds/prd-control-001.json',
    ]);
    assert.match(committedPrdSpec, /"id": "prd-control-001"/);
  } finally {
    await stopServer();
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
