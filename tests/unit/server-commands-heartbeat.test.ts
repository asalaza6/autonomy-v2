import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

import { main as serverMain } from '../../src/server/commands/server-commands-main.js';
import {
  buildCompanionControlBridgeLaunch,
  shouldStartCompanionControlBridge,
} from '../../src/server/commands/server-commands-main.js';
import { createFixtureRepo, initAutonomyRepo } from '../smoke/package-smoke.helpers.js';

test('autonomy-v2-server reports a scheduler heartbeat to the control plane', async (t) => {
  const repoDir = createFixtureRepo('autonomy-v2-server-heartbeat-');
  initAutonomyRepo(repoDir);

  let heartbeatCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/heartbeats/server' && req.method === 'POST') {
      heartbeatCount += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        heartbeat: {
          kind: 'server',
          updatedAt: new Date().toISOString(),
        },
      }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  const serverUrl = await listen(server);
  t.after(async () => {
    await closeServer(server);
  });

  await serverMain([
    'tick',
    '--root',
    repoDir,
    '--control-plane-url',
    serverUrl,
    '--json',
  ]);

  assert.equal(heartbeatCount, 1);
});

test('autonomy-v2-server serve enables a companion control bridge by default', () => {
  const launch = buildCompanionControlBridgeLaunch('/tmp/example-repo', {});

  assert.equal(launch.enabled, true);
  assert.equal(launch.serverUrl, 'http://127.0.0.1:3333');
  assert.equal(launch.pollMs, 2000);
  assert.deepEqual(launch.args.slice(1), [
    'bridge',
    '--root',
    '/tmp/example-repo',
    '--server-url',
    'http://127.0.0.1:3333',
    '--poll-ms',
    '2000',
  ]);
});

test('autonomy-v2-server companion control bridge can be disabled', () => {
  assert.equal(shouldStartCompanionControlBridge({ 'no-control-bridge': true }, {} as NodeJS.ProcessEnv), false);
  assert.equal(shouldStartCompanionControlBridge({}, {
    AUTONOMY_SERVER_CONTROL_BRIDGE: '0',
  } as NodeJS.ProcessEnv), false);
});

test('autonomy-v2-server companion control bridge accepts configured server url, repo map, and poll interval', () => {
  const launch = buildCompanionControlBridgeLaunch('/tmp/example-repo', {
    'control-bridge-repo-map': 'example=/tmp/example-repo',
    'control-bridge-poll-ms': '4444',
  }, 'https://control.example.test');

  assert.equal(launch.enabled, true);
  assert.equal(launch.serverUrl, 'https://control.example.test');
  assert.equal(launch.pollMs, 4444);
  assert.equal(launch.repoMap, 'example=/tmp/example-repo');
  assert.deepEqual(launch.args.slice(1), [
    'bridge',
    '--root',
    '/tmp/example-repo',
    '--server-url',
    'https://control.example.test',
    '--poll-ms',
    '4444',
    '--repo-map',
    'example=/tmp/example-repo',
  ]);
});

test('autonomy-v2-server companion control bridge accepts configured env defaults', () => {
  const previousServerUrl = process.env.AUTONOMY_CONTROL_PLANE_SERVER_URL;
  const previousPollMs = process.env.AUTONOMY_CONTROL_PLANE_BRIDGE_POLL_MS;
  const previousRepoMap = process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;
  process.env.AUTONOMY_CONTROL_PLANE_SERVER_URL = 'https://env-control.example.test';
  process.env.AUTONOMY_CONTROL_PLANE_BRIDGE_POLL_MS = '5555';
  process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP = 'env=/tmp/example-repo';

  try {
    const launch = buildCompanionControlBridgeLaunch('/tmp/example-repo', {});

    assert.equal(launch.serverUrl, 'https://env-control.example.test');
    assert.equal(launch.pollMs, 5555);
    assert.equal(launch.repoMap, 'env=/tmp/example-repo');
  } finally {
    restoreEnv('AUTONOMY_CONTROL_PLANE_SERVER_URL', previousServerUrl);
    restoreEnv('AUTONOMY_CONTROL_PLANE_BRIDGE_POLL_MS', previousPollMs);
    restoreEnv('AUTONOMY_CONTROL_PLANE_REPO_MAP', previousRepoMap);
  }
});

test('autonomy-v2-server companion control bridge rejects invalid poll interval', () => {
  assert.throws(() => buildCompanionControlBridgeLaunch('/tmp/example-repo', {
    'control-bridge-poll-ms': '0',
  }), /--control-bridge-poll-ms/);
});

test('autonomy-v2-server companion control bridge uses local control-plane url fallback', () => {
  const previousServerUrl = process.env.AUTONOMY_CONTROL_PLANE_SERVER_URL;
  const previousPollMs = process.env.AUTONOMY_CONTROL_PLANE_BRIDGE_POLL_MS;
  const previousRepoMap = process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;
  delete process.env.AUTONOMY_CONTROL_PLANE_SERVER_URL;
  delete process.env.AUTONOMY_CONTROL_PLANE_BRIDGE_POLL_MS;
  delete process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;

  try {
    const launch = buildCompanionControlBridgeLaunch('/tmp/example-repo', {});

    assert.equal(launch.serverUrl, 'http://127.0.0.1:3333');
    assert.equal(launch.pollMs, 2000);
    assert.equal(launch.repoMap, '');
  } finally {
    restoreEnv('AUTONOMY_CONTROL_PLANE_SERVER_URL', previousServerUrl);
    restoreEnv('AUTONOMY_CONTROL_PLANE_BRIDGE_POLL_MS', previousPollMs);
    restoreEnv('AUTONOMY_CONTROL_PLANE_REPO_MAP', previousRepoMap);
  }
});

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

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === 'string') {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}
