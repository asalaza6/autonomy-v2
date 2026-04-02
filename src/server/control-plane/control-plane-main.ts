#!/usr/bin/env node

import http from 'http';
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadAutonomyEnv } from '../../env/env-main.js';
import { resolveRootDir } from '../orchestrator/paths.js';
import { buildControlPlaneDashboard } from './control-plane-dashboard.js';
import { buildControlPlaneHtml } from './control-plane-browser.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import {
  claimJob,
  completeJob,
  createControlPlaneJob,
  ensureControlPlaneDataDir,
  enqueueJob,
  getRepoStatuses,
  listJobs,
  loadControlPlaneState,
  setRepoStatus,
} from './control-plane-store.js';
import { runControlPlaneBridgeLoop } from './control-plane-bridge.js';
import { validatePrdAddSubmission } from './control-plane-validation.js';

const controlPlaneAssetDir = fileURLToPath(new URL('.', import.meta.url));
const controlPlaneAssetCache = new Map<string, string>();

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
      await handleRequest(rootDir, req, res);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });

  await new Promise((resolve) => {
    server.listen(port, host, () => resolve(undefined));
  });
  console.log(`Control plane listening on http://${host}:${port}`);

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleRequest(rootDir: string, req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  applyCors(res, req.method || 'GET');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildControlPlaneHtml());
    return;
  }

  if (url.pathname === '/control-plane-client.js' && req.method === 'GET') {
    await sendControlPlaneAsset(res, 'control-plane-client.js', 'application/javascript; charset=utf-8');
    return;
  }

  if (url.pathname === '/control-plane-jsx-runtime/jsx-runtime.js' && req.method === 'GET') {
    await sendControlPlaneAsset(res, 'control-plane-jsx-runtime/jsx-runtime.js', 'application/javascript; charset=utf-8');
    return;
  }

  if (url.pathname === '/api/repos' && req.method === 'GET') {
    const config = loadControlPlaneConfig(rootDir);
    sendJson(res, 200, { repos: config.repos });
    return;
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    const state = loadControlPlaneState(rootDir);
    sendJson(res, 200, {
      ...state,
      dashboard: buildControlPlaneDashboard(rootDir, state),
    });
    return;
  }

  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    const repoId = url.searchParams.get('repoId') || '';
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
    const jobs = listJobs(rootDir, filter as any);
    sendJson(res, 200, { jobs });
    return;
  }

  if (url.pathname === '/api/jobs' && req.method === 'POST') {
    const config = loadControlPlaneConfig(rootDir);
    try {
      const body = await readJsonBody(req);
      const { payload } = validatePrdAddSubmission(config, body);
      const job = enqueueJob(rootDir, createControlPlaneJob(payload));
      sendJson(res, 201, job);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/jobs/') && url.pathname.endsWith('/claim') && req.method === 'POST') {
    const jobId = url.pathname.split('/')[3];
    const job = claimJob(rootDir, jobId);
    if (!job) {
      sendJson(res, 409, { error: 'Job is not available for claiming.' });
      return;
    }
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
    sendJson(res, 200, job);
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/status') && req.method === 'POST') {
    const repoId = url.pathname.split('/')[3];
    try {
      const body = await readJsonBody(req);
      const record = setRepoStatus(rootDir, repoId, (body && body.snapshot) || body);
      sendJson(res, 200, record);
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (url.pathname.startsWith('/api/repos/') && url.pathname.endsWith('/status') && req.method === 'GET') {
    const repoId = url.pathname.split('/')[3];
    const statuses = getRepoStatuses(rootDir);
    sendJson(res, 200, statuses[repoId] || null);
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
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
  --server-url <url> Bridge API base URL (default: AUTONOMY_CONTROL_PLANE_SERVER_URL or http://127.0.0.1:3333)
  --repo-map <map>   Optional repo allowlist map in the form repoId=/local/path,...
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
    .forEach((entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) {
        return;
      }
      const repoId = entry.slice(0, separatorIndex).trim();
      const rootDir = entry.slice(separatorIndex + 1).trim();
      if (repoId && rootDir) {
        repoRoots[repoId] = rootDir;
      }
    });
  if (Object.keys(repoRoots).length === 0 && fallbackRepoRoot) {
    repoRoots.default = fallbackRepoRoot;
  }
  return repoRoots;
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
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function applyCors(res: http.ServerResponse, method: string) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (method === 'OPTIONS') {
    res.setHeader('access-control-max-age', '86400');
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

export {
  main,
  parseRepoRoots,
};
