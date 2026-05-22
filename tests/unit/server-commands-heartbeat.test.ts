import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

import { main as serverMain } from '../../src/server/commands/server-commands-main.js';
import {
  buildCompanionControlPlaneLaunch,
  shouldStartCompanionControlPlane,
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

test('autonomy-v2-server serve enables a companion control plane by default', () => {
  const launch = buildCompanionControlPlaneLaunch('/tmp/example-repo', {});

  assert.equal(launch.enabled, true);
  assert.equal(launch.url, 'http://127.0.0.1:3333');
  assert.deepEqual(launch.args.slice(1), [
    'serve',
    '--root',
    '/tmp/example-repo',
    '--host',
    '127.0.0.1',
    '--port',
    '3333',
  ]);
});

test('autonomy-v2-server companion control plane can be disabled', () => {
  assert.equal(shouldStartCompanionControlPlane({ 'no-control-plane': true }, {} as NodeJS.ProcessEnv), false);
  assert.equal(shouldStartCompanionControlPlane({}, {
    AUTONOMY_SERVER_CONTROL_PLANE: '0',
  } as NodeJS.ProcessEnv), false);
});

test('autonomy-v2-server companion control plane accepts configured host and port', () => {
  const launch = buildCompanionControlPlaneLaunch('/tmp/example-repo', {
    'control-plane-host': '0.0.0.0',
    'control-plane-port': '4444',
  });

  assert.equal(launch.enabled, true);
  assert.equal(launch.host, '0.0.0.0');
  assert.equal(launch.port, 4444);
  assert.equal(launch.url, 'http://127.0.0.1:4444');
});

test('autonomy-v2-server companion control plane can use dyno host and port env', () => {
  const previousDyno = process.env.DYNO;
  const previousHost = process.env.HOST;
  const previousPort = process.env.PORT;
  delete process.env.HOST;
  process.env.DYNO = 'web.1';
  process.env.PORT = '5555';

  try {
    const launch = buildCompanionControlPlaneLaunch('/tmp/example-repo', {});

    assert.equal(launch.host, '0.0.0.0');
    assert.equal(launch.port, 5555);
    assert.equal(launch.url, 'http://127.0.0.1:5555');
  } finally {
    restoreEnv('DYNO', previousDyno);
    restoreEnv('HOST', previousHost);
    restoreEnv('PORT', previousPort);
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
