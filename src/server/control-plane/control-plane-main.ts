#!/usr/bin/env node

import { execFile } from 'child_process';
import http from 'http';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import type { ControlPlaneState } from '../../types.js';
import { loadAutonomyEnv } from '../../env/env-main.js';
import { resolveRootDir } from '../orchestrator/paths.js';
import { buildControlPlaneHtml, buildControlPlaneMissingEntranceHtml } from './control-plane-browser.js';
import { buildStateApiResponse } from './control-plane-state-response.js';
import { handleAgentToolRequest } from './control-plane-agent-tools.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import { recordControlPlaneServiceLifecycle } from './control-plane-lifecycle.js';
import { readManagedProcessOutput } from './control-plane-process-output.js';
import {
  claimJob,
  claimNextJob,
  completeJob,
  createControlPlaneCustomAgentToggleJob,
  createControlPlaneDeployJob,
  ensureRepoControlAccess,
  createControlPlanePackageUpdateJob,
  createControlPlaneHealthScoreJob,
  createControlPlanePrdPriorityJob,
  createControlPlanePrdResetJob,
  createControlPlaneRestartJob,
  createControlPlaneJob,
  ensureControlPlaneDataDir,
  enqueueJob,
  getRepoStatuses,
  listConversations,
  listDiscoveredRepos,
  listJobs,
  loadControlPlaneState,
  queueAgentChatMessage,
  setRepoStatus,
  touchHeartbeat,
  touchRepoBridgeHeartbeat,
} from './control-plane-store.js';
import { runControlPlaneBridgeLoop } from './control-plane-bridge.js';
import {
  validateAgentChatSubmission,
  validateDeploySubmission,
  validatePackageUpdateSubmission,
  validatePrdAddSubmission,
  validatePrdPrioritySubmission,
  validatePrdResetSubmission,
  validateRestartSubmission,
} from './control-plane-validation.js';

const controlPlaneAssetDir = fileURLToPath(new URL('.', import.meta.url));
const controlPlaneAssetCache = new Map<string, string>();
const controlPlaneDevToken = new Date().toISOString();
const execFileAsync = promisify(execFile);

async function main(argv: string[] = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  const rootDir = resolveRootDir(String(options.root || ''));
  loadAutonomyEnv(rootDir);

  if (options.help === true || command === 'help' || command === '-h' || command === '--help') {
    printHelp();
    return;
  }

  if (command === 'bridge') {
    const serverUrl = String(options['server-url'] || process.env.AUTONOMY_CONTROL_PLANE_SERVER_URL || 'http://127.0.0.1:3333');
    const pollMs = Number(options['poll-ms'] || '2000');
    const repoRoots = parseRepoRoots(
      String(options['repo-map'] || process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP || ''),
      rootDir
    );
    const once = options.once === true;
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
      throw new Error('--poll-ms must be a positive number.');
    }
    await runControlPlaneBridgeLoop(rootDir, {
      serverUrl,
      repoRoots,
      pollMs,
      once,
    });
    return;
  }

  if (command !== 'serve') {
    throw new Error(`Unknown command "${command}". Use "serve" or "bridge".`);
  }

  const devMode = options.dev === true || process.env.AUTONOMY_CONTROL_PLANE_DEV === '1';
  const apiBaseUrl = String(options['api-base-url'] || process.env.AUTONOMY_CONTROL_PLANE_API_BASE_URL || '').trim() || undefined;
  const proxyUrl = String(options['proxy-url'] || process.env.AUTONOMY_CONTROL_PLANE_PROXY_URL || '').trim() || undefined;
  const port = Number(options.port || process.env.PORT || process.env.AUTONOMY_CONTROL_PLANE_PORT || '3333');
  const host = String(
    options.host ||
    process.env.HOST ||
    process.env.AUTONOMY_CONTROL_PLANE_HOST ||
    (process.env.DYNO ? '0.0.0.0' : '127.0.0.1')
  );
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('--port must be a positive number.');
  }
  ensureControlPlaneDataDir(rootDir);

  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(rootDir, req, res, {
        devMode,
        apiBaseUrl,
        proxyUrl,
      });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve) => {
    server.listen(port, host, () => resolve(undefined));
  });
  recordControlPlaneServerLifecycle(rootDir);
  console.log(`Control plane listening on http://${host}:${port}`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleRequest(
  rootDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { devMode?: boolean; apiBaseUrl?: string; proxyUrl?: string } = {}
) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const entrance = resolveControlPlaneEntrance(url.pathname);
  applyCors(res, req.method || 'GET');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url.pathname === '/api/dev-meta' && req.method === 'GET') {
    sendJson(res, 200, {
      devMode: options.devMode === true,
      devToken: controlPlaneDevToken,
    });
    return;
  }

  if (options.proxyUrl && url.pathname.startsWith('/api/')) {
    await proxyControlPlaneApiRequest(req, res, url, options.proxyUrl);
    return;
  }

  if (url.pathname.startsWith('/api/agent-tools')) {
    try {
      const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req);
      const result = handleAgentToolRequest(rootDir, {
        method: req.method || 'GET',
        pathname: url.pathname,
        searchParams: url.searchParams,
        headers: req.headers,
        body,
      });
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === '/control-plane-client.js' && req.method === 'GET') {
    await sendControlPlaneAsset(res, 'control-plane-client.js', 'application/javascript; charset=utf-8');
    return;
  }

  if (url.pathname === '/control-plane-prd-proposal.js' && req.method === 'GET') {
    await sendControlPlaneAsset(res, 'control-plane-prd-proposal.js', 'application/javascript; charset=utf-8');
    return;
  }

  if (url.pathname === '/control-plane-version-view.js' && req.method === 'GET') {
    await sendControlPlaneAsset(res, 'control-plane-version-view.js', 'application/javascript; charset=utf-8');
    return;
  }

  if (url.pathname === '/control-plane-jsx-runtime/jsx-runtime.js' && req.method === 'GET') {
    await sendControlPlaneAsset(res, 'control-plane-jsx-runtime/jsx-runtime.js', 'application/javascript; charset=utf-8');
    return;
  }

  if (entrance.kind === 'missing' && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildControlPlaneMissingEntranceHtml());
    return;
  }

  if (entrance.kind === 'project' && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const projectExists = await hasKnownControlPlaneRepo(rootDir, entrance.repoId, options);
    if (!projectExists) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buildControlPlaneMissingEntranceHtml());
      return;
    }
  }

  if ((entrance.kind === 'manager' || entrance.kind === 'project') && req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildControlPlaneHtml(entrance.kind === 'project'
      ? {
        entrance: 'project',
        repoId: entrance.repoId,
        devMode: options.devMode === true,
        devToken: controlPlaneDevToken,
        apiBaseUrl: options.apiBaseUrl,
      }
      : {
        entrance: 'manager',
        devMode: options.devMode === true,
        devToken: controlPlaneDevToken,
        apiBaseUrl: options.apiBaseUrl,
      }));
    return;
  }

  if (url.pathname === '/api/repos' && req.method === 'GET') {
    const requestedRepoId = String(url.searchParams.get('repoId') || '').trim();
    const repos = listDiscoveredRepos(rootDir).filter((repo) => !requestedRepoId || repo.repoId === requestedRepoId);
    sendJson(res, 200, { repos });
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const repoId = String(url.searchParams.get('repoId') || '').trim();
    const state = filterControlPlaneState(loadControlPlaneState(rootDir), repoId);
    const controlSession = readControlSession(req);
    sendJson(res, 200, buildStateApiResponse(rootDir, state, controlSession, url.searchParams));
    return;
  }

  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    const repoId = url.searchParams.get('repoId') || '';
    const repoIds = parseRepoIds(url.searchParams.get('repoIds') || '');
    const status = url.searchParams.get('status') || '';
    const type = url.searchParams.get('type') || '';
    const filter: Record<string, string | undefined> = {};
    if (repoId) {
      filter.repoId = repoId;
    }
    if (status) {
      filter.status = status;
    }
    if (type) {
      filter.type = type;
    }
    const jobs = listJobs(rootDir, filter as any).filter((job) => repoIds.length === 0 || repoIds.includes(String(job.repoId || '')));
    sendJson(res, 200, { jobs });
    return;
  }

  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { payload } = validatePrdAddSubmission(listDiscoveredRepos(rootDir), body);
      const job = enqueueJob(rootDir, createControlPlaneJob(payload));
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
      });
      sendJson(res, 201, job);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === '/api/jobs/claim-next' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const job = claimNextJob(rootDir, {
      repoIds: parseBodyRepoIds(body),
    });
    if (job) {
      logControlPlaneEvent('control-plane:job:claimed', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
      });
    }
    sendJson(res, 200, { job });
    return;
  }

  if (url.pathname === '/api/heartbeats/bridge' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const repoIds = parseBodyRepoIds(body);
      const heartbeat = touchHeartbeat(rootDir, 'bridge', {
        note: String(body && body.note || 'bridge poll complete').trim() || 'bridge poll complete',
        repoIds,
      });
      repoIds.forEach((repoId) => {
        touchRepoBridgeHeartbeat(rootDir, repoId, {
          note: heartbeat.note,
          repoIds,
        });
      });
      sendJson(res, 200, { heartbeat });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname === '/api/heartbeats/server' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const heartbeat = touchHeartbeat(rootDir, 'server', {
        note: String(body && body.note || 'scheduler heartbeat').trim() || 'scheduler heartbeat',
      });
      sendJson(res, 200, { heartbeat });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/deploy') && req.method === 'POST') {
    const repoId = url.pathname.split('/')[3];
    try {
      const body = await readJsonBody(req);
      const { repo, payload } = validateDeploySubmission(listDiscoveredRepos(rootDir), {
        repoId: String(body && body.repoId || repoId || '').trim(),
      });
      const controlAccess = ensureRepoControlAccess(rootDir, repo, readControlSession(req));
      if (!controlAccess.canManage) {
        sendJson(res, 409, {
          error: 'This control-panel session is read-only for lifecycle actions on this repo.',
          controlAccess,
        });
        return;
      }
      const job = enqueueJob(rootDir, createControlPlaneDeployJob(payload));
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
      });
      sendJson(res, 201, job);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/reset-prds') && req.method === 'POST') {
    const repoId = url.pathname.split('/')[3];
    try {
      const body = await readJsonBody(req);
      const { repo, payload } = validatePrdResetSubmission(listDiscoveredRepos(rootDir), {
        ...body,
        repoId: String(body && body.repoId || repoId || '').trim(),
      });
      const controlAccess = ensureRepoControlAccess(rootDir, repo, readControlSession(req));
      if (!controlAccess.canManage) {
        sendJson(res, 409, {
          error: 'This control-panel session is read-only for lifecycle actions on this repo.',
          controlAccess,
        });
        return;
      }
      const job = enqueueJob(rootDir, createControlPlanePrdResetJob(payload));
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
      });
      sendJson(res, 201, job);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const prdPriorityMatch = url.pathname.match(/^\/api\/repos\/([^/]+)\/prds\/([^/]+)\/priority$/);
  if (prdPriorityMatch && req.method === 'POST') {
    const repoId = decodeURIComponent(prdPriorityMatch[1] || '');
    const prdId = decodeURIComponent(prdPriorityMatch[2] || '');
    try {
      const body = await readJsonBody(req);
      const { repo, payload } = validatePrdPrioritySubmission(listDiscoveredRepos(rootDir), {
        ...body,
        repoId: String(body && body.repoId || repoId || '').trim(),
        prdId: String(body && (body.prdId || body.id) || prdId || '').trim(),
      });
      const controlAccess = ensureRepoControlAccess(rootDir, repo, readControlSession(req));
      if (!controlAccess.canManage) {
        sendJson(res, 409, {
          error: 'This control-panel session is read-only for lifecycle actions on this repo.',
          controlAccess,
        });
        return;
      }
      const job = enqueueJob(rootDir, createControlPlanePrdPriorityJob(payload));
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
      });
      sendJson(res, 201, job);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/package-update') && req.method === 'POST') {
    const repoId = url.pathname.split('/')[3];
    try {
      const body = await readJsonBody(req);
      const { repo, payload } = validatePackageUpdateSubmission(listDiscoveredRepos(rootDir), {
        repoId: String(body && body.repoId || repoId || '').trim(),
      });
      const controlAccess = ensureRepoControlAccess(rootDir, repo, readControlSession(req));
      if (!controlAccess.canManage) {
        sendJson(res, 409, {
          error: 'This control-panel session is read-only for lifecycle actions on this repo.',
          controlAccess,
        });
        return;
      }
      const job = enqueueJob(rootDir, createControlPlanePackageUpdateJob(payload));
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
      });
      sendJson(res, 201, job);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/restart') && req.method === 'POST') {
    const repoId = url.pathname.split('/')[3];
    try {
      const body = await readJsonBody(req);
      const controlSession = readControlSession(req, body);
      const { repo, payload } = validateRestartSubmission(listDiscoveredRepos(rootDir), {
        repoId: String(body && body.repoId || repoId || '').trim(),
        controlSessionId: controlSession.sessionId,
        controlSessionLabel: controlSession.sessionLabel,
        takeoverControl: body && body.takeoverControl === true,
      });
      const controlAccess = ensureRepoControlAccess(rootDir, repo, {
        ...controlSession,
        takeover: body && body.takeoverControl === true,
      });
      if (!controlAccess.canManage) {
        sendJson(res, 409, {
          error: 'This control-panel session is read-only for lifecycle actions on this repo.',
          controlAccess,
        });
        return;
      }
      const job = enqueueJob(rootDir, createControlPlaneRestartJob(payload));
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
      });
      sendJson(res, 201, job);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/custom-agents/toggle') && req.method === 'POST') {
    const repoId = decodeURIComponent(url.pathname.split('/')[3] || '');
    try {
      const body = await readJsonBody(req);
      const repo = listDiscoveredRepos(rootDir).find((candidate) => String(candidate.repoId || '') === String(body && body.repoId || repoId || '').trim());
      if (!repo) {
        throw new Error(`Unknown repo "${String(body && body.repoId || repoId || '').trim()}".`);
      }
      const controlAccess = ensureRepoControlAccess(rootDir, repo, readControlSession(req, body));
      if (!controlAccess.canManage) {
        sendJson(res, 409, {
          error: 'This control-panel session is read-only for lifecycle actions on this repo.',
          controlAccess,
        });
        return;
      }
      const runtimeKey = String(body && body.runtimeKey || '').trim();
      if (!runtimeKey) {
        throw new Error('Missing custom agent runtimeKey.');
      }
      const job = enqueueJob(rootDir, createControlPlaneCustomAgentToggleJob({
        repoId: repo.repoId,
        runtimeKey,
        enabled: body && body.enabled === true,
      }));
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
        runtimeKey,
        enabled: body && body.enabled === true ? 'true' : 'false',
      });
      sendJson(res, 201, job);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/conversations') && req.method === 'GET') {
    const repoId = decodeURIComponent(url.pathname.split('/')[3] || '');
    try {
      validateAgentChatSubmission(listDiscoveredRepos(rootDir), {
        repoId,
        prompt: 'status',
      });
      sendJson(res, 200, {
        conversations: listConversations(rootDir, repoId),
      });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/conversations') && req.method === 'POST') {
    const repoId = decodeURIComponent(url.pathname.split('/')[3] || '');
    try {
      const body = await readJsonBody(req);
      const { payload } = validateAgentChatSubmission(listDiscoveredRepos(rootDir), {
        ...body,
        repoId: String(body && body.repoId || repoId || '').trim(),
      });
      const queued = queueAgentChatMessage(rootDir, {
        repoId: payload.repoId,
        conversationId: payload.conversationId,
        prompt: payload.prompt,
      });
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: queued.job.id,
        repoId: queued.job.repoId,
        type: queued.job.type,
        conversationId: queued.conversation.id,
      });
      sendJson(res, 201, queued);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/health-score') && req.method === 'POST') {
    const repoId = decodeURIComponent(url.pathname.split('/')[3] || '');
    try {
      const body = await readJsonBody(req);
      const requestedRepoId = String(body && body.repoId || repoId || '').trim();
      const repo = listDiscoveredRepos(rootDir).find((entry) => String(entry.repoId || '').trim() === requestedRepoId);
      const localRepoId = String(loadControlPlaneConfig(rootDir).repoId || '').trim();
      if (!repo && requestedRepoId !== localRepoId) {
        sendJson(res, 404, { error: 'Unknown repo.' });
        return;
      }
      const job = createControlPlaneHealthScoreJob({
        repoId: requestedRepoId,
        maxLines: Number(body && body.maxLines),
        threshold: Number(body && body.threshold),
        top: Number(body && body.top),
      });
      enqueueJob(rootDir, job);
      logControlPlaneEvent('control-plane:job:queued', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type,
      });
      sendJson(res, 202, { job });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/claim') && req.method === 'POST') {
    const jobId = url.pathname.split('/')[3];
    const body = await readJsonBody(req);
    const job = claimJob(rootDir, jobId, {
      repoIds: parseBodyRepoIds(body),
    });
    if (!job) {
      sendJson(res, 409, { error: 'Job is not available for claiming.' });
      return;
    }
    logControlPlaneEvent('control-plane:job:claimed', {
      jobId: job.id,
      repoId: job.repoId,
      type: job.type,
    });
    sendJson(res, 200, job);
    return;
  }

  if (url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/complete') && req.method === 'POST') {
    const jobId = url.pathname.split('/')[3];
    const body = await readJsonBody(req);
    const job = completeJob(rootDir, jobId, body);
    if (!job) {
      sendJson(res, 404, { error: 'Unknown job.' });
      return;
    }
    logControlPlaneEvent('control-plane:job:completed', {
      jobId: job.id,
      repoId: job.repoId,
      type: job.type,
      status: job.status,
      commitSha: job.result && job.result.commitSha || '',
      deployCommand: job.result && job.result.deployCommand
        ? job.result.deployCommand.command || 'yes'
        : '',
      restart: job.result && job.result.restartStatus && job.result.restartStatus.status || '',
      restartServer: job.result && job.result.restartStatus && job.result.restartStatus.server && job.result.restartStatus.server.status || '',
      restartBridge: job.result && job.result.restartStatus && job.result.restartStatus.controlBridge && job.result.restartStatus.controlBridge.status || '',
    });
    sendJson(res, 200, job);
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/status') && req.method === 'POST') {
    const repoId = url.pathname.split('/')[3];
    try {
      const body = await readJsonBody(req);
      const record = setRepoStatus(
        rootDir,
        repoId,
        (body && body.snapshot) || body,
        body && body.repo ? body.repo : {}
      );
      sendJson(res, 200, record);
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/status') && req.method === 'GET') {
    const repoId = url.pathname.split('/')[3];
    const statuses = getRepoStatuses(rootDir);
    sendJson(res, 200, statuses[repoId] || null);
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.includes('/processes/') && url.pathname.endsWith('/output') && req.method === 'GET') {
    const segments = url.pathname.split('/');
    const repoId = decodeURIComponent(segments[3] || '');
    const target = String(segments[5] || '').trim();
    if (target !== 'server' && target !== 'controlBridge') {
      sendJson(res, 404, { error: 'Unknown managed process target.' });
      return;
    }
    const maxBytes = Number(url.searchParams.get('maxBytes'));
    const state = loadControlPlaneState(rootDir);
    const processRecord = state.managedProcesses?.[repoId]?.[target] || null;
    const output = readManagedProcessOutput(rootDir, repoId, target, Number.isFinite(maxBytes) ? maxBytes : undefined);
    sendJson(res, 200, {
      repoId,
      target,
      outputSessionId: String(processRecord && processRecord.outputSessionId || '').trim() || null,
      pid: Number(processRecord && processRecord.pid) || null,
      running: processRecord ? processRecord.running !== false : false,
      ...output,
    });
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/control/takeover') && req.method === 'POST') {
    const repoId = decodeURIComponent(url.pathname.split('/')[3] || '');
    try {
      const body = await readJsonBody(req);
      const repo = listDiscoveredRepos(rootDir).find((entry) => String(entry.repoId || '').trim() === String(repoId || '').trim());
      if (!repo) {
        sendJson(res, 404, { error: 'Unknown repo.' });
        return;
      }
      const controlSession = readControlSession(req, body);
      const controlAccess = ensureRepoControlAccess(rootDir, repo, {
        ...controlSession,
        takeover: true,
      });
      if (!controlAccess.canManage) {
        sendJson(res, 409, {
          error: 'This control-panel session could not take over lifecycle controls for this repo.',
          controlAccess,
        });
        return;
      }
      sendJson(res, 200, { controlAccess });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
}

function resolveControlPlaneEntrance(pathname: string) {
  const normalized = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (normalized === '/manager') {
    return { kind: 'manager' as const };
  }
  if (normalized.startsWith('/project/')) {
    const repoId = decodeURIComponent(normalized.slice('/project/'.length)).trim();
    if (repoId) {
      return {
        kind: 'project' as const,
        repoId,
      };
    }
  }
  return { kind: 'missing' as const };
}

function parseRepoIds(value: string) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBodyRepoIds(body: any) {
  if (Array.isArray(body && body.repoIds)) {
    return body.repoIds.map((entry: unknown) => String(entry || '').trim()).filter(Boolean);
  }
  return [];
}

function filterControlPlaneState(state: ControlPlaneState, repoId: string) {
  const normalizedRepoId = String(repoId || '').trim();
  if (!normalizedRepoId) {
    return state;
  }
  return {
    ...state,
    jobs: (state.jobs || []).filter((job) => String(job.repoId || '') === normalizedRepoId),
    repoStatuses: normalizedRepoId && state.repoStatuses[normalizedRepoId]
      ? { [normalizedRepoId]: state.repoStatuses[normalizedRepoId] }
      : {},
    conversations: normalizedRepoId && state.conversations && state.conversations[normalizedRepoId]
      ? { [normalizedRepoId]: state.conversations[normalizedRepoId] }
      : {},
    managedProcesses: normalizedRepoId && state.managedProcesses && state.managedProcesses[normalizedRepoId]
      ? { [normalizedRepoId]: state.managedProcesses[normalizedRepoId] }
      : {},
    controlOwnership: normalizedRepoId && state.controlOwnership && state.controlOwnership[normalizedRepoId]
      ? { [normalizedRepoId]: state.controlOwnership[normalizedRepoId] }
      : {},
  };
}

function readControlSession(req: http.IncomingMessage, body: Record<string, unknown> | null = null) {
  const sessionId = String(
    req.headers['x-autonomy-control-session-id']
    || req.headers['x-control-session-id']
    || body?.controlSessionId
    || ''
  ).trim();
  const sessionLabel = String(
    req.headers['x-autonomy-control-session-label']
    || req.headers['x-control-session-label']
    || body?.controlSessionLabel
    || ''
  ).trim();
  return {
    sessionId: sessionId || undefined,
    sessionLabel: sessionLabel || undefined,
  };
}

function parseCli(argv: string[]) {
  const options: Record<string, string | boolean | Array<string | boolean>> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (typeof next === 'undefined' || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return {
    command: positionals[0] || 'serve',
    options,
  };
}

function printHelp() {
  console.log(`
Autonomy v2 Control Plane

Usage:
  autonomy-v2-control <command> [options]

Commands:
  serve              Start the browser/API control plane
  bridge             Poll the hosted queue and execute jobs on local repos

Options:
  --help, -h         Show this help
  --root <dir>       Control plane workspace root (default: cwd)
  --port <port>      Server port for serve (default: PORT or 3333)
  --host <host>      Server host for serve (default: HOST, 0.0.0.0 on Heroku, otherwise 127.0.0.1)
  --dev              Enable local UI dev mode with browser auto-reload after watch rebuilds
  --api-base-url <url> Browser-facing API base URL for direct remote control-plane calls
  --proxy-url <url>  Forward /api/* to a hosted control plane while serving local UI/assets
  --server-url <url> Bridge API base URL (default: AUTONOMY_CONTROL_PLANE_SERVER_URL or http://127.0.0.1:3333)
  --repo-map <map>   Optional repo roots in the form /local/path,... or repoId=/local/path,...
  --poll-ms <ms>     Bridge poll interval in milliseconds (default: 2000)
  --once             Run one bridge cycle and exit
`);
}

function parseRepoRoots(value: string, fallbackRepoRoot = '') {
  const repoRoots: Record<string, string> = {};
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) {
        repoRoots[`__path_${index}`] = entry;
        return;
      }
      const repoId = entry.slice(0, separatorIndex).trim();
      const rootDir = entry.slice(separatorIndex + 1).trim();
      if (repoId && rootDir) {
        repoRoots[repoId] = rootDir;
      }
  });
  if (Object.keys(repoRoots).length === 0 && fallbackRepoRoot) {
    repoRoots.__path_0 = fallbackRepoRoot;
  }
  return repoRoots;
}

function recordControlPlaneServerLifecycle(rootDir: string) {
  let serverRestartCommand;
  try {
    serverRestartCommand = loadControlPlaneConfig(rootDir).serverRestartCommand;
  } catch (_) {
    serverRestartCommand = undefined;
  }
  recordControlPlaneServiceLifecycle(rootDir, 'server', {
    restartCommand: serverRestartCommand,
  });
}

async function sendControlPlaneAsset(
  res: http.ServerResponse,
  relativePath: string,
  contentType: string
) {
  const cached = controlPlaneAssetCache.get(relativePath);
  if (cached) {
    res.writeHead(200, {
      'cache-control': 'no-cache',
      'content-type': contentType,
    });
    res.end(cached);
    return;
  }

  const assetPath = resolve(controlPlaneAssetDir, relativePath);
  const contents = await readFile(assetPath, 'utf8');
  controlPlaneAssetCache.set(relativePath, contents);
  res.writeHead(200, {
    'cache-control': 'no-cache',
    'content-type': contentType,
  });
  res.end(contents);
}

async function readJsonBody(req: http.IncomingMessage) {
  const raw = await readRequestBody(req);
  return raw ? JSON.parse(raw) : {};
}

async function readRequestBody(req: http.IncomingMessage) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function applyCors(res: http.ServerResponse, method: string) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-autonomy-agent-key,x-autonomy-control-session-id,x-autonomy-control-session-label,x-control-session-id,x-control-session-label');
  if (method === 'OPTIONS') {
    res.setHeader('access-control-max-age', '86400');
  }
}

function logControlPlaneEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(formatControlPlaneEventLine(event, fields));
}

function formatControlPlaneEventLine(event: string, fields: Record<string, unknown> = {}, timestamp = new Date().toISOString()) {
  const parts = [`[${timestamp}]`, event];
  Object.entries(fields).forEach(([key, value]) => {
    if (value === '' || value == null) {
      return;
    }
    parts.push(`${key}=${value}`);
  });
  return parts.join(' | ');
}

async function proxyControlPlaneApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestUrl: URL,
  proxyUrl: string
) {
  const targetUrl = buildProxyTargetUrl(proxyUrl, requestUrl);
  const method = String(req.method || 'GET').toUpperCase();
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : await readRequestBody(req);
  const response = await fetch(targetUrl, {
    method,
    headers: {
      'content-type': String(req.headers['content-type'] || 'application/json'),
      accept: String(req.headers.accept || 'application/json'),
    },
    body,
  });

  res.statusCode = response.status;
  copyProxyResponseHeaders(res, response);
  const responseBody = Buffer.from(await response.arrayBuffer());
  res.end(responseBody);
}

function buildProxyTargetUrl(proxyUrl: string, requestUrl: URL) {
  const proxyBase = new URL(proxyUrl);
  const basePath = proxyBase.pathname.replace(/\/$/, '');
  return new URL(
    `${basePath}${requestUrl.pathname}${requestUrl.search}`,
    `${proxyBase.protocol}//${proxyBase.host}`
  ).toString();
}

function copyProxyResponseHeaders(res: http.ServerResponse, response: Response) {
  response.headers.forEach((value, key) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey === 'connection'
      || normalizedKey === 'content-length'
      || normalizedKey === 'transfer-encoding'
    ) {
      return;
    }
    res.setHeader(key, value);
  });
}

async function hasKnownControlPlaneRepo(
  rootDir: string,
  repoId: string,
  options: { apiBaseUrl?: string; proxyUrl?: string }
) {
  const normalizedRepoId = String(repoId || '').trim();
  if (!normalizedRepoId) {
    return false;
  }

  const localRepo = listDiscoveredRepos(rootDir).some((repo) => String(repo.repoId || '').trim() === normalizedRepoId);
  if (localRepo) {
    return true;
  }

  try {
    if (String(loadControlPlaneConfig(rootDir).repoId || '').trim() === normalizedRepoId) {
      return true;
    }
  } catch {
    // Keep checking remote registry if local config is unavailable.
  }

  const remoteBaseUrl = String(options.proxyUrl || options.apiBaseUrl || '').trim();
  if (!remoteBaseUrl) {
    return false;
  }

  try {
    const remoteReposUrl = buildRemoteControlPlaneApiUrl(
      remoteBaseUrl,
      '/api/repos',
      `?repoId=${encodeURIComponent(normalizedRepoId)}`
    );
    const payload = await requestRemoteRepoRegistry(remoteReposUrl);
    const repos = Array.isArray(payload.repos) ? payload.repos : [];
    return repos.some((repo) => String(repo && repo.repoId || '').trim() === normalizedRepoId);
  } catch (_) {
    return false;
  }
}

function buildRemoteControlPlaneApiUrl(baseUrl: string, pathname: string, search = '') {
  const base = new URL(baseUrl);
  const normalizedBasePath = base.pathname.replace(/\/+$/, '');
  return new URL(
    `${normalizedBasePath}${pathname}${search}`,
    `${base.protocol}//${base.host}`
  ).toString();
}

async function requestRemoteRepoRegistry(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json() as { repos?: Array<{ repoId?: string }> };
  } catch (_) {
    const { stdout } = await execFileAsync('curl', [
      '--fail',
      '--silent',
      '--show-error',
      '--header',
      'accept: application/json',
      url,
    ]);
    return JSON.parse(stdout) as { repos?: Array<{ repoId?: string }> };
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

export {
  formatControlPlaneEventLine,
  main,
  parseRepoRoots,
};
