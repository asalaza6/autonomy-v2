import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';

import { main as serverMain } from '../../src/server/commands/server-commands-main.js';
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
