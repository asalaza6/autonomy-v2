import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import {
  addPrdWithTasks,
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
    const versionViewAsset = await fetch(`http://127.0.0.1:${port}/control-plane-version-view.js`);
    assert.equal(versionViewAsset.status, 200);
    assert.match(await versionViewAsset.text(), /VersionStatus/);
    const clientAsset = await fetch(`http://127.0.0.1:${port}/control-plane-client.js`);
    assert.equal(clientAsset.status, 200);
    const clientSource = await clientAsset.text();
    assert.match(clientSource, /Deploying\.\.\./);
    assert.match(clientSource, /deploy-spinner/);
    assert.match(clientSource, /select-prd-history/);
    assert.match(clientSource, /conversations/);
    assert.match(clientSource, /control-plane-prd-proposal/);
    assert.doesNotMatch(clientSource, /autonomy-v2\/control-plane\/status-view\.js/);
    const prdProposalAsset = await fetch(`http://127.0.0.1:${port}/control-plane-prd-proposal.js`);
    assert.equal(prdProposalAsset.status, 200);
    assert.match(await prdProposalAsset.text(), /normalizePrdProposal/);

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
    assert.match(projectHtml, />Main</);
    assert.match(projectHtml, /Repo Chat/);
    assert.match(projectHtml, /History/);
    assert.match(projectHtml, /Advanced/);
    assert.match(projectHtml, /Make a change to default/);
    assert.match(projectHtml, /main-progress-fill/);
    assert.match(projectHtml, /main-progress-steps/);
    assert.match(projectHtml, /PRD History/);
    assert.match(projectHtml, /Status dashboard/);
    assert.match(projectHtml, /New PRD/);
    assert.doesNotMatch(projectHtml, /data-tab="dashboard"/);
    assert.doesNotMatch(projectHtml, /data-tab="submit"/);
    assert.match(projectHtml, /data-tab="main"/);
    assert.match(projectHtml, /data-tab="chat"/);
    assert.match(projectHtml, /data-tab="history"/);
    assert.match(projectHtml, /data-tab="advanced"/);
    assert.match(projectHtml, /Show raw debug payloads/);
    assert.doesNotMatch(projectHtml, /id="raw-state"/);
    assert.doesNotMatch(projectHtml, /id="raw-dashboard"/);
    assert.doesNotMatch(projectHtml, /id="raw-jobs"/);
    assert.doesNotMatch(projectHtml, /id="raw-repos"/);
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

test('control plane preserves repo assistant conversations across server restart', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-chat-restart-');
  initAutonomyRepo(repoDir);

  const port = await getFreePort();
  const startServer = () => spawn(process.execPath, [
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
      AUTONOMY_CONTROL_PLANE_PERSIST: '1',
      PATH: process.env.PATH || '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let server = startServer();
  const stopServer = async () => {
    if (server.exitCode !== null || server.signalCode !== null) {
      return;
    }
    server.kill('SIGTERM');
    await onceExit(server);
  };

  try {
    await waitForHttp(`http://127.0.0.1:${port}/api/repos`);

    runNode(CONTROL_BIN, [
      'bridge',
      '--root',
      repoDir,
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--repo-map',
      repoDir,
      '--once',
    ], {
      env: {
        AUTONOMY_CONTROL_PLANE_CHAT_STUB: '1',
      },
    });

    const createResponse = await fetch(`http://127.0.0.1:${port}/api/repos/default/conversations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'default',
        prompt: 'What is the current repo status?',
      }),
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json() as any;
    const conversationId = created.conversation.id;

    runNode(CONTROL_BIN, [
      'bridge',
      '--root',
      repoDir,
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--repo-map',
      repoDir,
      '--once',
    ], {
      env: {
        AUTONOMY_CONTROL_PLANE_CHAT_STUB: '1',
      },
    });

    const beforeRestart = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/repos/default/conversations`);
    assert.equal(beforeRestart.conversations.length, 1);
    assert.equal(beforeRestart.conversations[0].id, conversationId);
    assert.equal(beforeRestart.conversations[0].messages.length, 2);
    assert.equal(beforeRestart.conversations[0].messages[1].status, 'complete');

    await stopServer();
    server = startServer();
    await waitForHttp(`http://127.0.0.1:${port}/api/repos`);

    const afterRestart = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/repos/default/conversations`);
    assert.equal(afterRestart.conversations.length, 1);
    assert.equal(afterRestart.conversations[0].id, conversationId);
    assert.equal(afterRestart.conversations[0].messages.length, 2);

    const continueResponse = await fetch(`http://127.0.0.1:${port}/api/repos/default/conversations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'default',
        conversationId,
        prompt: 'What should I do next?',
      }),
    });
    assert.equal(continueResponse.status, 201);
    const continued = await continueResponse.json() as any;
    assert.equal(continued.conversation.id, conversationId);

    runNode(CONTROL_BIN, [
      'bridge',
      '--root',
      repoDir,
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--repo-map',
      repoDir,
      '--once',
    ], {
      env: {
        AUTONOMY_CONTROL_PLANE_CHAT_STUB: '1',
      },
    });

    const finalState = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/repos/default/conversations`);
    assert.equal(finalState.conversations.length, 1);
    assert.equal(finalState.conversations[0].id, conversationId);
    assert.equal(finalState.conversations[0].messages.length, 4);
    assert.equal(finalState.conversations[0].messages[0].content, 'What is the current repo status?');
    assert.equal(finalState.conversations[0].messages[2].content, 'What should I do next?');
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

test('control plane reset endpoint validates confirmation and clears active PRD state after bridge execution', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-reset-');
  initAutonomyRepo(repoDir);
  addPrdWithTasks(repoDir, 'prd-reset-api-001', 'Reset API PRD', [{
    id: 'prd-reset-api-001-architecture-agent-1',
    title: 'Implement reset endpoint',
    agentId: 'architecture-agent',
    acceptance: ['Reset endpoint is complete.'],
  }]);

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

    const invalidResponse = await fetch(`http://127.0.0.1:${port}/api/repos/default/reset-prds`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'default',
      }),
    });
    assert.equal(invalidResponse.status, 400);
    assert.match(await invalidResponse.text(), /confirmPrdId/);

    const resetResponse = await fetch(`http://127.0.0.1:${port}/api/repos/default/reset-prds`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        repoId: 'default',
        confirmPrdId: 'prd-reset-api-001',
        reason: 'Reset from control plane test.',
      }),
    });
    assert.equal(resetResponse.status, 201);

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

    const state = await fetchJsonWithRetry(`http://127.0.0.1:${port}/api/state`);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].type, 'prd:reset');
    assert.equal(state.jobs[0].status, 'completed');
    assert.equal(state.repoStatuses.default.snapshot.prds.prds.length, 0);
    assert.equal(state.repoStatuses.default.snapshot.prdHistory.prds[0].id, 'prd-reset-api-001');
    assert.equal(state.repoStatuses.default.snapshot.prdHistory.prds[0].status, 'reset');
    assert.equal(state.repoStatuses.default.snapshot.prdHistory.prds[0].archive.kind, 'reset');
    assert.equal(state.dashboard.repos[0].activePrd, null);

    const archivedPrd = git(repoDir, ['show', 'dev:prompts/autonomous/v2/specs/prds/archived/prd-reset-api-001.json']);
    assert.match(archivedPrd, /"kind": "reset"/);
  } finally {
    await stopServer();
  }
});

test('control plane restart status exposes managed process state and exclusive owner metadata', async () => {
  const repoDir = createFixtureRepo('autonomy-v2-control-plane-restart-owned-');
  initAutonomyRepo(repoDir);

  const serverPidPath = path.join(repoDir, 'managed-server.pid');
  const bridgePidPath = path.join(repoDir, 'managed-bridge.pid');
  const controlPlaneConfigPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlaneConfigPath, 'utf8'));
  controlPlaneConfig.exclusiveControl = true;
  controlPlaneConfig.controlTakeover = 'takeover';
  controlPlaneConfig.serverRestartCommand = {
    command: process.execPath,
    args: ['-e', [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(serverPidPath)}, String(process.pid), "utf8");`,
      'setInterval(() => {}, 1000);',
    ].join('\n')],
  };
  controlPlaneConfig.controlBridgeRestartCommand = {
    command: process.execPath,
    args: ['-e', [
      'const fs = require("fs");',
      `fs.writeFileSync(${JSON.stringify(bridgePidPath)}, String(process.pid), "utf8");`,
      'setInterval(() => {}, 1000);',
    ].join('\n')],
  };
  fs.writeFileSync(controlPlaneConfigPath, `${JSON.stringify(controlPlaneConfig, null, 2)}\n`, 'utf8');

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

    const ownerHeaders = {
      'content-type': 'application/json',
      'x-autonomy-control-session-id': 'owner-session',
      'x-autonomy-control-session-label': 'Owner Session',
    };
    const viewerHeaders = {
      'content-type': 'application/json',
      'x-autonomy-control-session-id': 'viewer-session',
      'x-autonomy-control-session-label': 'Viewer Session',
    };

    const ownerRestartResponse = await fetch(`http://127.0.0.1:${port}/api/repos/default/restart`, {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        repoId: 'default',
      }),
    });
    assert.equal(ownerRestartResponse.status, 201);

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

    const firstServerPid = Number(fs.readFileSync(serverPidPath, 'utf8').trim());
    const firstBridgePid = Number(fs.readFileSync(bridgePidPath, 'utf8').trim());
    const ownerState = await fetchJsonUntil(
      `http://127.0.0.1:${port}/api/state?repoId=default`,
      10000,
      ownerHeaders,
      (state) => (
        state?.dashboard?.repos?.[0]?.managedProcesses?.server?.pid === firstServerPid
        && state?.dashboard?.repos?.[0]?.managedProcesses?.controlBridge?.pid === firstBridgePid
      )
    );
    assert.equal(ownerState.dashboard.repos[0].managedProcesses.server.pid, firstServerPid);
    assert.equal(ownerState.dashboard.repos[0].managedProcesses.server.running, true);
    assert.equal(ownerState.dashboard.repos[0].managedProcesses.server.singletonOutcome, 'replaced');
    assert.equal(ownerState.dashboard.repos[0].managedProcesses.controlBridge.pid, firstBridgePid);
    assert.equal(ownerState.dashboard.repos[0].controlAccess.canManage, true);
    assert.equal(ownerState.dashboard.repos[0].controlAccess.isOwner, true);
    assert.equal(ownerState.dashboard.repos[0].controlAccess.owner.sessionId, 'owner-session');

    const viewerState = await fetchJson(
      `http://127.0.0.1:${port}/api/state?repoId=default`,
      viewerHeaders
    );
    assert.equal(viewerState.dashboard.repos[0].controlAccess.readOnly, true);
    assert.equal(viewerState.dashboard.repos[0].controlAccess.owner.sessionId, 'owner-session');

    const viewerRestartResponse = await fetch(`http://127.0.0.1:${port}/api/repos/default/restart`, {
      method: 'POST',
      headers: viewerHeaders,
      body: JSON.stringify({
        repoId: 'default',
      }),
    });
    assert.equal(viewerRestartResponse.status, 409);

    const takeoverResponse = await fetch(`http://127.0.0.1:${port}/api/repos/default/restart`, {
      method: 'POST',
      headers: viewerHeaders,
      body: JSON.stringify({
        repoId: 'default',
        takeoverControl: true,
      }),
    });
    assert.equal(takeoverResponse.status, 201);

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

    const secondServerPid = Number(fs.readFileSync(serverPidPath, 'utf8').trim());
    const takeoverState = await fetchJsonUntil(
      `http://127.0.0.1:${port}/api/state?repoId=default`,
      10000,
      viewerHeaders,
      (state) => state?.dashboard?.repos?.[0]?.managedProcesses?.server?.pid === secondServerPid
    );
    assert.notEqual(secondServerPid, firstServerPid);
    assert.equal(takeoverState.dashboard.repos[0].managedProcesses.server.pid, secondServerPid);
    assert.equal(takeoverState.dashboard.repos[0].managedProcesses.server.preRestartPid, firstServerPid);
    assert.equal(takeoverState.dashboard.repos[0].managedProcesses.server.singletonOutcome, 'replaced');
    assert.equal(takeoverState.dashboard.repos[0].controlAccess.canManage, true);
    assert.equal(takeoverState.dashboard.repos[0].controlAccess.isOwner, true);
    assert.equal(takeoverState.dashboard.repos[0].controlAccess.owner.sessionId, 'viewer-session');
    assert.equal(takeoverState.dashboard.repos[0].controlAccess.owner.takeoverCount, 1);
  } finally {
    await stopPidFromFile(serverPidPath);
    await stopPidFromFile(bridgePidPath);
    await stopServer();
  }
});

async function fetchJson(url: string, headers?: Record<string, string>): Promise<any> {
  const response = await fetch(url, {
    headers,
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

async function fetchJsonWithRetry(url: string, timeoutMs = 10000, headers?: Record<string, string>): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(url, headers);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Timed out fetching ${url}`);
}

async function fetchJsonUntil(
  url: string,
  timeoutMs = 10000,
  headers?: Record<string, string>,
  predicate?: (value: any) => boolean,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: any = null;
  while (Date.now() < deadline) {
    lastValue = await fetchJson(url, headers);
    if (!predicate || predicate(lastValue)) {
      return lastValue;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for matching JSON at ${url}: ${JSON.stringify(lastValue)}`);
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

async function stopPidFromFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const pid = Number(fs.readFileSync(filePath, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await delay(50);
    } catch {
      return;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already exited.
  }
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
