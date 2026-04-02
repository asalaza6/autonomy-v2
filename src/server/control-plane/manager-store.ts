import fs from 'fs';
import path from 'path';
import { ensureDir, readJson, writeJson } from '../orchestrator/paths.js';
import type { ManagedSiteRecord, ManagerState } from '../../types.js';

const DEFAULT_MANAGER_STATE: ManagerState = {
  schemaVersion: 1,
  nextSiteIndex: 1,
  sites: [],
};

const MANAGER_STATE_CACHE = new Map<string, ManagerState>();

function getManagerPaths(rootDir: string) {
  const managerDir = path.join(rootDir, '.autonomy', 'manager');
  return {
    managerDir,
    statePath: path.join(managerDir, 'state.json'),
    sitesDir: path.join(managerDir, 'sites'),
    logsDir: path.join(managerDir, 'logs'),
  };
}

function ensureManagerDataDir(rootDir: string) {
  const paths = getManagerPaths(rootDir);
  ensureDir(paths.managerDir);
  ensureDir(paths.sitesDir);
  ensureDir(paths.logsDir);
  if (!fs.existsSync(paths.statePath)) {
    saveManagerState(rootDir, DEFAULT_MANAGER_STATE);
  }
  return paths;
}

function loadManagerState(rootDir: string): ManagerState {
  const stateKey = getManagerStateKey(rootDir);
  const cachedState = MANAGER_STATE_CACHE.get(stateKey);
  if (cachedState) {
    return cachedState;
  }

  const paths = getManagerPaths(rootDir);
  const persistedState = fs.existsSync(paths.statePath)
    ? normalizeManagerState(readJson(paths.statePath, DEFAULT_MANAGER_STATE))
    : normalizeManagerState(DEFAULT_MANAGER_STATE);
  MANAGER_STATE_CACHE.set(stateKey, persistedState);
  return persistedState;
}

function saveManagerState(rootDir: string, state: ManagerState) {
  const normalizedState = normalizeManagerState(state);
  MANAGER_STATE_CACHE.set(getManagerStateKey(rootDir), normalizedState);
  const paths = getManagerPaths(rootDir);
  ensureDir(paths.managerDir);
  ensureDir(paths.sitesDir);
  ensureDir(paths.logsDir);
  writeJson(paths.statePath, normalizedState);
  return normalizedState;
}

function normalizeManagerState(state: Partial<ManagerState> = {}): ManagerState {
  const nextSiteIndex = Number.isFinite(Number(state.nextSiteIndex)) && Number(state.nextSiteIndex) > 0
    ? Number(state.nextSiteIndex)
    : 1;
  return {
    schemaVersion: typeof state.schemaVersion === 'number' ? state.schemaVersion : 1,
    nextSiteIndex,
    sites: Array.isArray(state.sites)
      ? state.sites.map(normalizeManagedSiteRecord).filter((site): site is ManagedSiteRecord => Boolean(site))
      : [],
  };
}

function normalizeManagedSiteRecord(site: ManagedSiteRecord | Record<string, unknown> | null | undefined): ManagedSiteRecord | null {
  if (!site || !site.id) {
    return null;
  }
  const id = String(site.id || '').trim();
  if (!id) {
    return null;
  }
  const slug = String(site.slug || id).trim() || id;
  const siteDir = String(site.siteDir || path.join('sites', slug)).trim();
  const port = Number(site.port || 0);
  const routePath = String(site.routePath || `/sites/${slug}`).trim();
  const deployment = normalizeDeploymentRecord((site as ManagedSiteRecord).deployment);
  const content = normalizeContentRecord((site as ManagedSiteRecord).content, site as ManagedSiteRecord);

  return {
    id,
    slug,
    name: String(site.name || slug).trim() || slug,
    description: String(site.description || '').trim() || undefined,
    siteDir,
    port: Number.isFinite(port) && port > 0 ? port : 0,
    routePath,
    status: normalizeSiteStatus(String(site.status || 'stopped')),
    desiredState: String(site.desiredState || 'stopped') === 'running' ? 'running' : 'stopped',
    createdAt: String(site.createdAt || new Date().toISOString()),
    updatedAt: String(site.updatedAt || site.createdAt || new Date().toISOString()),
    pid: normalizeOptionalNumber((site as ManagedSiteRecord).pid),
    startedAt: normalizeOptionalString((site as ManagedSiteRecord).startedAt),
    stoppedAt: normalizeOptionalString((site as ManagedSiteRecord).stoppedAt),
    lastExitCode: normalizeOptionalNumber((site as ManagedSiteRecord).lastExitCode),
    lastSignal: normalizeOptionalString((site as ManagedSiteRecord).lastSignal),
    healthStatus: normalizeHealthStatus((site as ManagedSiteRecord).healthStatus),
    healthMessage: normalizeOptionalString((site as ManagedSiteRecord).healthMessage),
    healthCheckedAt: normalizeOptionalString((site as ManagedSiteRecord).healthCheckedAt),
    logPath: String((site as ManagedSiteRecord).logPath || path.join('.autonomy', 'manager', 'logs', `${slug}.log`)),
    publicUrl: normalizeOptionalString((site as ManagedSiteRecord).publicUrl),
    deployment,
    content,
  };
}

function normalizeSiteStatus(status: string | undefined | null) {
  const normalized = String(status || 'stopped').trim();
  if (['starting', 'running', 'stopping', 'stopped', 'error'].includes(normalized)) {
    return normalized as ManagedSiteRecord['status'];
  }
  return 'stopped';
}

function normalizeHealthStatus(status: ManagedSiteRecord['healthStatus'] | undefined | null) {
  const normalized = String(status || 'unknown').trim();
  if (normalized === 'healthy' || normalized === 'unhealthy') {
    return normalized;
  }
  return 'unknown';
}

function normalizeDeploymentRecord(deployment: ManagedSiteRecord['deployment'] | null | undefined): ManagedSiteRecord['deployment'] {
  if (!deployment) {
    return {
      status: 'idle' as const,
    };
  }
  return {
    target: deployment.target === 'heroku' ? 'heroku' as const : undefined,
    status: normalizeDeploymentStatus(deployment.status),
    provider: deployment.provider === 'heroku' ? 'heroku' as const : undefined,
    appName: normalizeOptionalString(deployment.appName),
    appUrl: normalizeOptionalString(deployment.appUrl),
    buildId: normalizeOptionalString(deployment.buildId),
    version: normalizeOptionalString(deployment.version),
    sourceBundlePath: normalizeOptionalString(deployment.sourceBundlePath),
    lastError: normalizeOptionalString(deployment.lastError),
    updatedAt: normalizeOptionalString(deployment.updatedAt),
  };
}

function normalizeDeploymentStatus(status: string | undefined | null) {
  const normalized = String(status || 'idle').trim();
  if (['idle', 'pending', 'deployed', 'failed', 'skipped'].includes(normalized)) {
    return normalized as NonNullable<ManagedSiteRecord['deployment']>['status'];
  }
  return 'idle';
}

function normalizeContentRecord(content: ManagedSiteRecord['content'] | undefined | null, site: ManagedSiteRecord) {
  const fallbackTitle = String(site.name || site.slug || 'Managed site').trim();
  const fallbackDescription = String(site.description || '').trim();
  return {
    title: String(content?.title || fallbackTitle).trim() || fallbackTitle,
    headline: String(content?.headline || content?.title || fallbackTitle).trim() || fallbackTitle,
    description: String(content?.description || fallbackDescription || '').trim() || undefined,
    body: String(content?.body || 'This site is running locally under the manager and can also be published to Heroku.').trim(),
    footer: String(content?.footer || 'Autonomy v2 managed site').trim(),
    accent: String(content?.accent || '#245b75').trim(),
  };
}

function normalizeOptionalString(value: unknown) {
  const text = String(value || '').trim();
  return text || undefined;
}

function normalizeOptionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function listManagedSites(rootDir: string) {
  return loadManagerState(rootDir).sites.slice();
}

function getManagedSite(rootDir: string, siteId: string) {
  return listManagedSites(rootDir).find((site) => site.id === siteId) || null;
}

function upsertManagedSite(rootDir: string, site: ManagedSiteRecord) {
  const state = loadManagerState(rootDir);
  const normalizedSite = normalizeManagedSiteRecord(site);
  if (!normalizedSite) {
    throw new Error('Invalid managed site record.');
  }
  const index = state.sites.findIndex((entry) => entry.id === normalizedSite.id);
  if (index >= 0) {
    state.sites[index] = normalizedSite;
  } else {
    state.sites.push(normalizedSite);
  }
  saveManagerState(rootDir, state);
  return normalizedSite;
}

function updateManagedSite(rootDir: string, siteId: string, patch: Partial<ManagedSiteRecord>) {
  const state = loadManagerState(rootDir);
  const site = state.sites.find((entry) => entry.id === siteId);
  if (!site) {
    return null;
  }
  const merged = normalizeManagedSiteRecord({
    ...site,
    ...patch,
    id: site.id,
    slug: patch.slug || site.slug,
    siteDir: patch.siteDir || site.siteDir,
    routePath: patch.routePath || site.routePath,
    createdAt: site.createdAt,
  });
  if (!merged) {
    return null;
  }
  const index = state.sites.findIndex((entry) => entry.id === siteId);
  state.sites[index] = merged;
  saveManagerState(rootDir, state);
  return merged;
}

function removeManagedSite(rootDir: string, siteId: string) {
  const state = loadManagerState(rootDir);
  const index = state.sites.findIndex((entry) => entry.id === siteId);
  if (index < 0) {
    return null;
  }
  const [removed] = state.sites.splice(index, 1);
  saveManagerState(rootDir, state);
  return removed || null;
}

function incrementManagedSiteIndex(rootDir: string) {
  const state = loadManagerState(rootDir);
  state.nextSiteIndex = Number(state.nextSiteIndex || 1) + 1;
  saveManagerState(rootDir, state);
  return state.nextSiteIndex;
}

function getManagedSiteRoot(rootDir: string, site: ManagedSiteRecord) {
  return path.resolve(rootDir, site.siteDir);
}

function getManagedSiteLogPath(rootDir: string, site: ManagedSiteRecord) {
  const logPath = site.logPath || path.join('.autonomy', 'manager', 'logs', `${site.slug}.log`);
  return path.resolve(rootDir, logPath);
}

function getManagerStateKey(rootDir: string) {
  return path.resolve(rootDir || process.cwd());
}

export {
  DEFAULT_MANAGER_STATE,
  ensureManagerDataDir,
  getManagedSite,
  getManagedSiteLogPath,
  getManagedSiteRoot,
  getManagerPaths,
  incrementManagedSiteIndex,
  listManagedSites,
  loadManagerState,
  normalizeManagedSiteRecord,
  normalizeManagerState,
  removeManagedSite,
  saveManagerState,
  updateManagedSite,
  upsertManagedSite,
};
