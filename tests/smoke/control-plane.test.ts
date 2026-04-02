import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { spawn } from 'child_process';
import net from 'net';
import path from 'path';

import {
  CONTROL_BIN,
  createFixtureRepo,
  initAutonomyRepo,
  git,
} from './package-smoke.helpers.js';

test('manager server queues site creation and the bridge bootstraps the repo-only site', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-manager-');
  initAutonomyRepo(repoDir);

  const port = await getFreePort();
  const sitesRoot = path.join(repoDir, 'auto');
  const server = startControlPlaneServer(repoDir, port, {
    AUTONOMY_MANAGER_SITES_ROOT: sitesRoot,
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
        publishToHeroku: false,
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.bootstrapMode, 'queued');
    assert.equal(created.site.id, 'acme-storefront');

    const siteRoot = created.site.siteDir;
    assert.equal(siteRoot, path.join(sitesRoot, 'acme-storefront'));
    assert.equal(fs.existsSync(siteRoot), false);

    assert.equal(created.site.repoRoot, created.site.siteDir);
    assert.equal(created.site.branch, 'main');
    assert.equal(created.site.installStatus, 'pending');
    assert.equal(created.site.initStatus, 'pending');
    assert.ok(created.site.localUrl == null);
    assert.equal(created.site.status, 'stopped');

    const stateAfterCreate = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/manager-state`);
    assert.equal(stateAfterCreate.dashboard.siteCount, 1);
    assert.equal(stateAfterCreate.dashboard.runningSiteCount, 0);
    assert.equal(stateAfterCreate.dashboard.deployedSiteCount, 0);
    assert.equal(stateAfterCreate.sites[0].installStatus, 'pending');
    assert.equal(stateAfterCreate.sites[0].initStatus, 'pending');
    assert.equal(stateAfterCreate.sites[0].status, 'stopped');
    assert.equal(stateAfterCreate.sites[0].deployment.status, 'idle');
    assert.ok(stateAfterCreate.sites[0].localUrl == null);
    assert.equal(stateAfterCreate.sites[0].repoRoot, siteRoot);

    const bridgeRun = await runBridgeOnce(repoDir, `http://127.0.0.1:${port}`, {
      AUTONOMY_MANAGER_SITES_ROOT: sitesRoot,
    });
    assert.match(bridgeRun.output, /bootstrapping site acme-storefront/);
    assert.match(bridgeRun.output, /bootstrap complete for acme-storefront/);
    assert.match(bridgeRun.output, /completed job .* for site acme-storefront/);

    assert.equal(git(siteRoot, ['rev-parse', '--is-inside-work-tree']), 'true');
    assert.equal(git(siteRoot, ['branch', '--show-current']), 'main');
    assert.match(git(siteRoot, ['log', '--oneline', '-1']), /Initial site bootstrap/);

    assert.ok(fs.existsSync(path.join(siteRoot, 'package.json')));
    assert.ok(fs.existsSync(path.join(siteRoot, 'package-lock.json')));
    assert.ok(fs.existsSync(path.join(siteRoot, '.gitignore')));
    assert.ok(fs.existsSync(path.join(siteRoot, '.env.autonomy')));
    assert.ok(fs.existsSync(path.join(siteRoot, '.autonomy', 'runtime', 'state', 'runtime.json')));
    assert.ok(fs.existsSync(path.join(siteRoot, 'prompts', 'autonomous', 'v2', 'config', 'agents.json')));
    assert.ok(fs.existsSync(path.join(siteRoot, 'prompts', 'autonomous', 'v2', 'config', 'sprint.json')));
    assert.equal(fs.existsSync(path.join(siteRoot, 'server.js')), false);
    assert.equal(fs.existsSync(path.join(siteRoot, 'site-page.tsx')), false);
    assert.equal(fs.existsSync(path.join(siteRoot, 'site-page.js')), false);
    assert.equal(fs.existsSync(path.join(siteRoot, 'content.json')), false);

    const stateAfterBridge = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/manager-state`);
    assert.equal(stateAfterBridge.sites[0].installStatus, 'installed');
    assert.equal(stateAfterBridge.sites[0].initStatus, 'initialized');
    assert.equal(stateAfterBridge.sites[0].status, 'stopped');
    assert.equal(stateAfterBridge.sites[0].deployment.status, 'idle');

    const logs = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/sites/acme-storefront/logs`);
    assert.ok(Array.isArray(logs.lines));
    assert.match(String(logs.text || ''), /creating repo at/);
    assert.match(String(logs.text || ''), /installing autonomy-v2/);
    assert.match(String(logs.text || ''), /running autonomy-v2 init/);
    assert.match(String(logs.text || ''), /committing bootstrap/);
    assert.match(String(logs.text || ''), /bootstrap complete/);
  } finally {
    await stopServer();
  }
});

test('manager server queues deploy and the bridge publishes from the local repo', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-manager-queued-');
  initAutonomyRepo(repoDir);

  const sitesRoot = path.join(repoDir, 'auto');
  const port = await getFreePort();
  const server = startControlPlaneServer(repoDir, port, {
    AUTONOMY_MANAGER_SITES_ROOT: sitesRoot,
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

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/sites`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Queued Site',
        slug: 'queued-site',
        autoStart: true,
        publishToHeroku: false,
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.bootstrapMode, 'queued');
    assert.equal(created.job.type, 'site:create');
    assert.equal(created.site.id, 'queued-site');
    assert.equal(created.site.installStatus, 'pending');
    assert.equal(created.site.initStatus, 'pending');
    assert.equal(created.site.siteDir, path.join(sitesRoot, 'queued-site'));
    assert.ok(created.site.localUrl == null);

    await runBridgeOnce(repoDir, `http://127.0.0.1:${port}`, {
      AUTONOMY_MANAGER_SITES_ROOT: sitesRoot,
    });

    const deployResponse = await fetch(`http://127.0.0.1:${port}/api/sites/queued-site/deploy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        appName: 'queued-site',
      }),
    });
    assert.equal(deployResponse.status, 202);
    const deployed = await deployResponse.json();
    assert.equal(deployed.deployMode, 'queued');
    assert.equal(deployed.job.type, 'site:deploy');
    assert.equal(deployed.site.deployment.status, 'pending');

    const herokuCli = createHerokuCliStub(repoDir);
    const deployBridge = await runBridgeOnce(repoDir, `http://127.0.0.1:${port}`, {
      AUTONOMY_MANAGER_SITES_ROOT: sitesRoot,
      AUTONOMY_MANAGER_HEROKU_CLI: herokuCli.command,
      AUTONOMY_MANAGER_GIT_CLI: herokuCli.gitCommand,
      HEROKU_STUB_STATE: herokuCli.stateDir,
    });
    assert.match(deployBridge.output, /deploying site queued-site/);
    assert.match(deployBridge.output, /deploy complete for queued-site/);
    assert.match(deployBridge.output, /completed deploy job .* for site queued-site/);

    const state = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/manager-state`);
    assert.equal(state.sites.length, 1);
    assert.equal(state.sites[0].status, 'stopped');
    assert.equal(state.sites[0].installStatus, 'installed');
    assert.equal(state.sites[0].initStatus, 'initialized');
    assert.equal(state.sites[0].deployment.status, 'deployed');
    assert.equal(state.sites[0].publicUrl, 'https://queued-site.herokuapp.com');

    const logs = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/sites/queued-site/logs`);
    assert.match(String(logs.text || ''), /deploy queued for bridge/);
    assert.match(String(logs.text || ''), /deploy complete for queued-site/);
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
  return new Promise<number>((resolve, reject) => {
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

function startControlPlaneServer(repoDir: string, port: number, extraEnv: Record<string, string> = {}) {
  return spawn(process.execPath, [
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
      ...extraEnv,
      PATH: process.env.PATH || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function createHerokuCliStub(repoDir: string) {
  const stubDir = path.join(repoDir, '.test-stubs');
  const stateDir = path.join(stubDir, 'heroku-state');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const herokuScript = path.join(stubDir, 'heroku');
  const gitScript = path.join(stubDir, 'git');
  fs.writeFileSync(herokuScript, `#!/bin/sh
set -eu
state_dir="\${HEROKU_STUB_STATE:?}"
case "\${1:-}" in
  apps:info)
    if [ -f "$state_dir/app-created" ]; then
      cat <<'JSON'
{"app":{"id":"app-123","name":"queued-site","web_url":"https://queued-site.herokuapp.com"}}
JSON
      exit 0
    fi
    exit 1
    ;;
  create|apps:create)
    mkdir -p "$state_dir"
    touch "$state_dir/app-created"
    echo "Creating app... done, queued-site"
    echo "https://queued-site.herokuapp.com/ | https://git.heroku.com/queued-site.git"
    exit 0
    ;;
  git:remote)
    mkdir -p "$state_dir"
    touch "$state_dir/remote-set"
    echo "set git remote heroku to https://git.heroku.com/queued-site.git"
    exit 0
    ;;
  *)
    echo "stub heroku: $*" >&2
    exit 0
    ;;
esac
`, 'utf8');
  fs.writeFileSync(gitScript, `#!/bin/sh
set -eu
case "\${1:-}" in
  push)
    echo "pushing to heroku"
    exit 0
    ;;
  *)
    echo "stub git: $*" >&2
    exit 0
    ;;
esac
`, 'utf8');
  fs.chmodSync(herokuScript, 0o755);
  fs.chmodSync(gitScript, 0o755);
  return {
    command: herokuScript,
    stateDir,
    gitCommand: gitScript,
  };
}

async function runBridgeOnce(repoDir: string, serverUrl: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [
    CONTROL_BIN,
    'bridge',
    '--root',
    repoDir,
    '--server-url',
    serverUrl,
    '--once',
  ], {
    cwd: repoDir,
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  if (exitCode !== 0) {
    throw new Error(`Bridge exited with code ${String(exitCode)}.\n${output}`);
  }

  return { output, exitCode };
}
