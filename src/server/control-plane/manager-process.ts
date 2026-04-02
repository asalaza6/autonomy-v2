import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import type { ManagedSiteContent, ManagedSiteRecord, ManagerSiteCreateRequest } from '../../types.js';
import {
  ensureManagerDataDir,
  getManagedSite,
  getManagedSiteLogPath,
  getManagedSiteRoot,
  incrementManagedSiteIndex,
  listManagedSites,
  normalizeManagedSiteRecord,
  updateManagedSite,
  upsertManagedSite,
} from './manager-store.js';
import { scaffoldManagedSite, buildDefaultSiteContent } from './manager-site-template.js';

const MANAGED_SITE_PROCESSES = new Map<string, ReturnType<typeof spawn>>();
const MANAGED_SITE_STOP_REQUESTS = new Set<string>();
const MANAGED_SITE_RESTART_TIMERS = new Map<string, NodeJS.Timeout>();

async function createManagedSite(rootDir: string, request: ManagerSiteCreateRequest) {
  ensureManagerDataDir(rootDir);
  const stateSites = listManagedSites(rootDir);
  const baseSlug = buildManagedSiteSlug(request.slug || request.name, stateSites.map((site) => site.slug));
  const siteId = baseSlug;
  const now = new Date().toISOString();
  const siteDir = path.join('sites', siteId);
  const port = await allocateFreePort();
  const site: ManagedSiteRecord = normalizeManagedSiteRecord({
    id: siteId,
    slug: siteId,
    name: String(request.name || siteId).trim() || siteId,
    description: String(request.description || '').trim() || undefined,
    siteDir,
    port,
    routePath: `/sites/${siteId}`,
    status: 'stopped',
    desiredState: request.autoStart === false ? 'stopped' : 'running',
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    stoppedAt: now,
    pid: null,
    healthStatus: 'unknown',
    healthMessage: '',
    healthCheckedAt: null,
    logPath: path.join('.autonomy', 'manager', 'logs', `${siteId}.log`),
    publicUrl: null,
    deployment: {
      status: request.publishToHeroku ? 'pending' : 'idle',
    },
    content: {
      ...buildDefaultSiteContent({
        id: siteId,
        slug: siteId,
        name: String(request.name || siteId).trim() || siteId,
        description: String(request.description || '').trim() || undefined,
        siteDir,
        port,
        routePath: `/sites/${siteId}`,
        status: 'stopped',
        desiredState: 'stopped',
        createdAt: now,
        updatedAt: now,
      }),
      ...(request.content || {}),
    } as ManagedSiteContent,
  }) as ManagedSiteRecord;

  await scaffoldManagedSite(rootDir, site);
  upsertManagedSite(rootDir, site);
  incrementManagedSiteIndex(rootDir);
  if (request.autoStart !== false) {
    return startManagedSite(rootDir, site.id);
  }
  return site;
}

async function startManagedSite(rootDir: string, siteId: string) {
  const site = getManagedSite(rootDir, siteId);
  if (!site) {
    throw new Error(`Unknown site "${siteId}".`);
  }
  const existing = MANAGED_SITE_PROCESSES.get(siteId);
  if (existing && existing.exitCode === null && existing.signalCode === null) {
    return site;
  }
  clearManagedSiteRestartTimer(siteId);
  MANAGED_SITE_STOP_REQUESTS.delete(siteId);
  const siteRoot = getManagedSiteRoot(rootDir, site);
  const logPath = getManagedSiteLogPath(rootDir, site);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.mkdirSync(siteRoot, { recursive: true });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: siteRoot,
    env: {
      ...process.env,
      PORT: String(site.port),
      HOST: '0.0.0.0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  MANAGED_SITE_PROCESSES.set(siteId, child);
  appendSiteLog(logPath, `[manager] started site ${siteId} on port ${site.port}\n`);
  updateManagedSite(rootDir, siteId, {
    status: 'starting',
    desiredState: 'running',
    pid: child.pid || null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    healthStatus: 'unknown',
    healthMessage: 'starting',
    healthCheckedAt: new Date().toISOString(),
  });

  attachManagedSiteStreams(rootDir, siteId, child, logPath);
  const health = await waitForManagedSiteHealth(site.port);
  const now = new Date().toISOString();
  const updated = updateManagedSite(rootDir, siteId, {
    status: 'running',
    desiredState: 'running',
    pid: child.pid || null,
    updatedAt: now,
    healthStatus: health.ok ? 'healthy' : 'unhealthy',
    healthMessage: health.message,
    healthCheckedAt: now,
    stoppedAt: null,
    lastExitCode: null,
    lastSignal: null,
  });
  if (!updated) {
    throw new Error(`Unable to update site "${siteId}".`);
  }
  return updated;
}

async function stopManagedSite(rootDir: string, siteId: string) {
  const site = getManagedSite(rootDir, siteId);
  if (!site) {
    throw new Error(`Unknown site "${siteId}".`);
  }
  const child = MANAGED_SITE_PROCESSES.get(siteId);
  if (!child) {
    return updateManagedSite(rootDir, siteId, {
      status: 'stopped',
      desiredState: 'stopped',
      pid: null,
      stoppedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      healthStatus: 'unknown',
      healthMessage: 'stopped',
      healthCheckedAt: new Date().toISOString(),
    }) || site;
  }

  MANAGED_SITE_STOP_REQUESTS.add(siteId);
  updateManagedSite(rootDir, siteId, {
    status: 'stopping',
    desiredState: 'stopped',
    updatedAt: new Date().toISOString(),
  });
  child.kill('SIGTERM');
  await waitForProcessExit(child, 2500);
  MANAGED_SITE_PROCESSES.delete(siteId);
  MANAGED_SITE_STOP_REQUESTS.delete(siteId);
  return updateManagedSite(rootDir, siteId, {
    status: 'stopped',
    desiredState: 'stopped',
    pid: null,
    stoppedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    healthStatus: 'unknown',
    healthMessage: 'stopped',
    healthCheckedAt: new Date().toISOString(),
  }) || site;
}

async function restartManagedSite(rootDir: string, siteId: string) {
  await stopManagedSite(rootDir, siteId);
  return startManagedSite(rootDir, siteId);
}

async function reconcileManagedSites(rootDir: string) {
  ensureManagerDataDir(rootDir);
  const sites = listManagedSites(rootDir);
  const results = [];
  for (const site of sites) {
    const child = MANAGED_SITE_PROCESSES.get(site.id);
    const isAlive = Boolean(child && child.exitCode === null && child.signalCode === null);
    if (site.desiredState === 'running' && !isAlive) {
      results.push(await startManagedSite(rootDir, site.id));
      continue;
    }
    if (site.desiredState === 'stopped' && isAlive) {
      results.push(await stopManagedSite(rootDir, site.id));
      continue;
    }
    results.push(site);
  }
  return results;
}

function attachManagedSiteStreams(rootDir: string, siteId: string, child: ReturnType<typeof spawn>, logPath: string) {
  const logStream = (chunk: Buffer | string, source: 'stdout' | 'stderr') => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    appendSiteLog(logPath, `[${source}] ${text}`);
  };

  child.stdout?.on('data', (chunk) => logStream(chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => logStream(chunk, 'stderr'));
  child.on('exit', (code, signal) => {
    MANAGED_SITE_PROCESSES.delete(siteId);
    const requestedStop = MANAGED_SITE_STOP_REQUESTS.has(siteId);
    MANAGED_SITE_STOP_REQUESTS.delete(siteId);
    const now = new Date().toISOString();
    updateManagedSite(rootDir, siteId, {
      status: requestedStop ? 'stopped' : 'error',
      desiredState: requestedStop ? 'stopped' : 'running',
      pid: null,
      lastExitCode: typeof code === 'number' ? code : null,
      lastSignal: signal || null,
      stoppedAt: now,
      updatedAt: now,
      healthStatus: requestedStop ? 'unknown' : 'unhealthy',
      healthMessage: requestedStop ? 'stopped' : `process exited (${signal || code || 'unknown'})`,
      healthCheckedAt: now,
    });
    appendSiteLog(logPath, `[manager] site ${siteId} exited code=${String(code)} signal=${String(signal)}\n`);
    if (!requestedStop && signal !== 'SIGKILL') {
      scheduleManagedSiteRestart(rootDir, siteId);
    }
  });
}

function scheduleManagedSiteRestart(rootDir: string, siteId: string, delayMs = 1500) {
  clearManagedSiteRestartTimer(siteId);
  const timer = setTimeout(() => {
    void startManagedSite(rootDir, siteId).catch((error) => {
      appendSiteLog(path.join(rootDir, '.autonomy', 'manager', 'logs', `${siteId}.log`), `[manager] restart failed for ${siteId}: ${formatErrorMessage(error)}\n`);
    });
  }, delayMs);
  MANAGED_SITE_RESTART_TIMERS.set(siteId, timer);
}

function clearManagedSiteRestartTimer(siteId: string) {
  const timer = MANAGED_SITE_RESTART_TIMERS.get(siteId);
  if (timer) {
    clearTimeout(timer);
    MANAGED_SITE_RESTART_TIMERS.delete(siteId);
  }
}

function appendSiteLog(logPath: string, line: string) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, line, 'utf8');
}

async function waitForManagedSiteHealth(port: number, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        return {
          ok: true,
          message: String(payload && payload.name ? `healthy: ${payload.name}` : 'healthy'),
        };
      }
      lastError = new Error(`Health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  return {
    ok: false,
    message: `unhealthy: ${formatErrorMessage(lastError)}`,
  };
}

async function waitForProcessExit(child: ReturnType<typeof spawn>, timeoutMs = 2000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(timeoutMs),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

async function allocateFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to allocate a free port.')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function buildManagedSiteSlug(value: string, existingSlugs: string[]) {
  const base = slugify(String(value || '').trim()) || 'site';
  const taken = new Set(existingSlugs);
  if (!taken.has(base)) {
    return base;
  }
  let index = 2;
  for (;;) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export {
  allocateFreePort,
  buildManagedSiteSlug,
  createManagedSite,
  reconcileManagedSites,
  restartManagedSite,
  startManagedSite,
  stopManagedSite,
};
