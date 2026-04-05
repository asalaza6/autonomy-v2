import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import http from 'http';

import {
  CONTROL_BIN,
  createFixtureRepo,
  initAutonomyRepo,
} from './package-smoke.helpers.js';

test('manager server creates, routes, stops, and deploys local sites', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-manager-');
  initAutonomyRepo(repoDir);

  const herokuServer = await startFakeHerokuServer();
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
      AUTONOMY_MANAGER_HEROKU_API_BASE_URL: herokuServer.url,
      HEROKU_API_KEY: 'fake-heroku-token',
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
    await waitForHttp(`http://127.0.0.1:${port}/api/manager-state`);

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /Manager/);
    assert.match(html, /Create site/);
    assert.match(html, /Local sites/);

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/sites`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Acme Storefront',
        slug: 'acme-storefront',
        description: 'Managed site smoke test',
        autoStart: true,
        publishToHeroku: true,
        herokuAppName: 'acme-storefront-smoke',
        content: {
          headline: 'Acme Storefront',
          body: 'Created by the manager smoke test.',
          footer: 'Smoke test footer',
        },
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.site.id, 'acme-storefront');

    const stateAfterCreate = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/manager-state`);
    assert.equal(stateAfterCreate.dashboard.siteCount, 1);
    assert.equal(stateAfterCreate.dashboard.runningSiteCount, 1);
    assert.equal(stateAfterCreate.dashboard.deployedSiteCount, 1);
    assert.equal(stateAfterCreate.sites[0].deployment.status, 'pending');
    assert.match(String(stateAfterCreate.sites[0].publicUrl || ''), /acme-storefront-smoke/);
    assert.equal(stateAfterCreate.controlPlane.server.status, 'online');
    assert.equal(stateAfterCreate.controlPlane.bridge.status, 'offline');

    const siteHtml = await (await fetch(`http://127.0.0.1:${port}/sites/acme-storefront`)).text();
    assert.match(siteHtml, /Acme Storefront/);
    assert.match(siteHtml, /Created by the manager smoke test\./);

    const logs = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/sites/acme-storefront/logs`);
    assert.ok(Array.isArray(logs.lines));
    assert.match(String(logs.text || ''), /started site acme-storefront/i);

    await fetch(`http://127.0.0.1:${port}/api/sites/acme-storefront/stop`, {
      method: 'POST',
    });
    await waitForStateValue(port, (state) => state.sites[0]?.status === 'stopped');

    const stoppedResponse = await fetch(`http://127.0.0.1:${port}/sites/acme-storefront`);
    assert.equal(stoppedResponse.status, 503);

    await fetch(`http://127.0.0.1:${port}/api/sites/acme-storefront/start`, {
      method: 'POST',
    });
    await waitForStateValue(port, (state) => state.sites[0]?.status === 'running');

    const restartedSiteHtml = await (await fetch(`http://127.0.0.1:${port}/sites/acme-storefront`)).text();
    assert.match(restartedSiteHtml, /Managed site/);
  } finally {
    await stopServer();
    await closeServer(herokuServer.server);
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

async function waitForStateValue(port: number, predicate: (state: any) => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastState: any = null;
  while (Date.now() < deadline) {
    lastState = await fetchJson(`http://127.0.0.1:${port}/api/manager-state`);
    if (predicate(lastState)) {
      return lastState;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for manager state. Last state: ${JSON.stringify(lastState, null, 2)}`);
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
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, () => {
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

async function startFakeHerokuServer() {
  const uploads = new Map<string, Buffer>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const body = await readRequestBody(req);

    if (req.method === 'POST' && url.pathname === '/apps') {
      const payload = body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
      const appName = String(payload.name || `app-${Date.now()}`);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        name: appName,
        web_url: `https://${appName}.herokuapp.test`,
      }));
      return;
    }

    if (req.method === 'POST' && /\/apps\/[^/]+\/sources$/.test(url.pathname)) {
      const appName = decodeURIComponent(url.pathname.split('/')[2]);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        source_blob: {
          put_url: `${herokuServerBaseUrl(server)}/upload/${encodeURIComponent(appName)}`,
          get_url: `${herokuServerBaseUrl(server)}/download/${encodeURIComponent(appName)}`,
        },
      }));
      return;
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const appName = decodeURIComponent(url.pathname.split('/')[2] || '');
      uploads.set(appName, body);
      res.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && /\/apps\/[^/]+\/builds$/.test(url.pathname)) {
      const appName = decodeURIComponent(url.pathname.split('/')[2]);
      const payload = body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
      const build = {
        id: `build-${appName}`,
        status: 'pending',
        source_blob: payload.source_blob || {},
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(build));
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
      const appName = decodeURIComponent(url.pathname.split('/')[2] || '');
      const upload = uploads.get(appName);
      res.writeHead(200, { 'content-type': 'application/gzip' });
      res.end(upload || Buffer.from(''));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await listen(server);
  return {
    server,
    url: herokuServerBaseUrl(server),
  };
}

function readRequestBody(req: http.IncomingMessage) {
  return new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

function listen(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function herokuServerBaseUrl(server: http.Server) {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to read fake Heroku server address.');
  }
  return `http://127.0.0.1:${address.port}`;
}
