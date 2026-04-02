import fs from 'fs';
import path from 'path';
import net from 'net';
import { execFileSync, spawn } from 'child_process';
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
import {
  buildDefaultSiteContent,
  commitManagedSiteRepository,
  installManagedSiteDependencies,
  readManagedSiteRepositoryBranch,
  runManagedSiteAutonomyInit,
  scaffoldManagedSite,
} from './manager-site-template.js';

const MANAGED_SITE_PROCESSES = new Map<string, ReturnType<typeof spawn>>();
const MANAGED_SITE_STOP_REQUESTS = new Set<string>();
const MANAGED_SITE_RESTART_TIMERS = new Map<string, NodeJS.Timeout>();

function canBootstrapManagedSiteLocally() {
  if (process.env.DYNO) {
    return false;
  }
  return ['git', 'npm', 'npx'].every((command) => {
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
}

function resolveManagedSitesRootDir() {
  const configuredRoot = String(process.env.AUTONOMY_MANAGER_SITES_ROOT || '').trim();
  return path.resolve(configuredRoot || '/Users/bytedance/Documents/GitHub/auto');
}

function reserveManagedSiteDraft(rootDir: string, request: ManagerSiteCreateRequest) {
  ensureManagerDataDir(rootDir);
  const stateSites = listManagedSites(rootDir);
  const baseSlug = buildManagedSiteSlug(request.slug || request.name, stateSites.map((site) => site.slug));
  const siteId = baseSlug;
  const now = new Date().toISOString();
  const siteDir = path.join(resolveManagedSitesRootDir(), siteId);
  incrementManagedSiteIndex(rootDir);
  return normalizeManagedSiteRecord({
    id: siteId,
    slug: siteId,
    name: String(request.name || siteId).trim() || siteId,
    description: String(request.description || '').trim() || undefined,
    repoRoot: siteDir,
    branch: 'main',
    siteDir,
    port: 0,
    localUrl: null,
    routePath: `/sites/${siteId}`,
    status: 'stopped',
    desiredState: 'stopped',
    createdAt: now,
    updatedAt: now,
    installStatus: 'pending',
    initStatus: 'pending',
    bootstrapError: null,
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
        port: 0,
        routePath: `/sites/${siteId}`,
        status: 'stopped',
        desiredState: 'stopped',
        createdAt: now,
        updatedAt: now,
      }),
      ...(request.content || {}),
    } as ManagedSiteContent,
  }) as ManagedSiteRecord;
}

async function createManagedSite(rootDir: string, request: ManagerSiteCreateRequest) {
  const draft = reserveManagedSiteDraft(rootDir, request);
  return bootstrapManagedSite(rootDir, draft);
}

async function bootstrapManagedSite(rootDir: string, draftSite: ManagedSiteRecord) {
  ensureManagerDataDir(rootDir);
  const site = normalizeManagedSiteRecord(draftSite);
  if (!site) {
    throw new Error('Invalid managed site record.');
  }
  const siteRoot = path.resolve(rootDir, site.siteDir);
  fs.mkdirSync(siteRoot, { recursive: true });
  const preparedSite = normalizeManagedSiteRecord({
    ...site,
    port: 0,
    localUrl: null,
    desiredState: 'stopped',
    status: 'stopped',
    installStatus: 'pending',
    initStatus: 'pending',
    bootstrapError: null,
  });
  if (!preparedSite) {
    throw new Error(`Unable to prepare site "${site.id}".`);
  }
  upsertManagedSite(rootDir, preparedSite);
  try {
    const siteLogPath = getManagedSiteLogPath(rootDir, preparedSite);
    appendSiteLog(siteLogPath, `[manager] creating repo at ${siteRoot}\n`);
    await scaffoldManagedSite(rootDir, preparedSite);
    const scaffoldedBranch = readManagedSiteRepositoryBranch(siteRoot);
    updateManagedSite(rootDir, site.id, {
      repoRoot: preparedSite.repoRoot || preparedSite.siteDir,
      branch: scaffoldedBranch,
      installStatus: 'installing',
      initStatus: 'pending',
      bootstrapError: null,
      updatedAt: new Date().toISOString(),
    });
    appendSiteLog(siteLogPath, `[manager] installing autonomy-v2 for ${preparedSite.id}\n`);
    installManagedSiteDependencies(siteRoot);
    updateManagedSite(rootDir, site.id, {
      installStatus: 'installed',
      updatedAt: new Date().toISOString(),
    });
    appendSiteLog(siteLogPath, `[manager] running autonomy-v2 init for ${preparedSite.id}\n`);
    updateManagedSite(rootDir, site.id, {
      initStatus: 'initializing',
      updatedAt: new Date().toISOString(),
    });
    runManagedSiteAutonomyInit(siteRoot);
    appendSiteLog(siteLogPath, `[manager] committing bootstrap for ${preparedSite.id}\n`);
    const finalBranch = commitManagedSiteRepository(siteRoot);
    const finished = updateManagedSite(rootDir, site.id, {
      repoRoot: preparedSite.repoRoot || preparedSite.siteDir,
      branch: finalBranch,
      installStatus: 'installed',
      initStatus: 'initialized',
      status: 'stopped',
      desiredState: 'stopped',
      port: 0,
      localUrl: null,
      bootstrapError: null,
      updatedAt: new Date().toISOString(),
    });
    if (!finished) {
      throw new Error(`Unable to update site "${site.id}" after bootstrap.`);
    }
    appendSiteLog(siteLogPath, `[manager] bootstrap complete for ${preparedSite.id}\n`);
  } catch (error) {
    const message = formatErrorMessage(error);
    updateManagedSite(rootDir, preparedSite.id, {
      status: 'error',
      desiredState: 'stopped',
      installStatus: 'failed',
      initStatus: 'failed',
      port: 0,
      localUrl: null,
      bootstrapError: message,
      updatedAt: new Date().toISOString(),
    });
    appendSiteLog(getManagedSiteLogPath(rootDir, preparedSite), `[manager] bootstrap failed for ${preparedSite.id}: ${message}\n`);
    throw error;
  }

  return getManagedSite(rootDir, preparedSite.id) || preparedSite;
}

async function startManagedSite(rootDir: string, siteId: string) {
  throw new Error('Managed sites are bootstrap-only. No site runtime is created by the manager.');
}

async function stopManagedSite(rootDir: string, siteId: string) {
  throw new Error('Managed sites are bootstrap-only. No site runtime is created by the manager.');
}

async function restartManagedSite(rootDir: string, siteId: string) {
  throw new Error('Managed sites are bootstrap-only. No site runtime is created by the manager.');
}

async function reconcileManagedSites(rootDir: string) {
  ensureManagerDataDir(rootDir);
  const sites = listManagedSites(rootDir);
  return sites.map((site) => {
    if (site.status === 'running' || site.status === 'starting' || site.status === 'stopping') {
      return updateManagedSite(rootDir, site.id, {
        status: 'stopped',
        desiredState: 'stopped',
        pid: null,
        localUrl: null,
        port: 0,
        healthStatus: 'unknown',
        healthMessage: 'bootstrap-only',
        healthCheckedAt: new Date().toISOString(),
      }) || site;
    }
    return site;
  });
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

function appendManagedSiteLog(rootDir: string, siteId: string, line: string) {
  const site = getManagedSite(rootDir, siteId);
  const logPath = site ? getManagedSiteLogPath(rootDir, site) : path.join(rootDir, '.autonomy', 'manager', 'logs', `${siteId}.log`);
  appendSiteLog(logPath, line);
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
  appendManagedSiteLog,
  bootstrapManagedSite,
  buildManagedSiteSlug,
  canBootstrapManagedSiteLocally,
  createManagedSite,
  reconcileManagedSites,
  restartManagedSite,
  reserveManagedSiteDraft,
  startManagedSite,
  stopManagedSite,
};
