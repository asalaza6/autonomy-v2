import type { AnyRecord, ManagedSiteRecord, ManagerState } from '../../types.js';
import { listManagedSites } from './manager-store.js';

interface ManagerDashboard {
  siteCount: number;
  runningSiteCount: number;
  stoppedSiteCount: number;
  healthySiteCount: number;
  deployedSiteCount: number;
  pendingDeployCount: number;
  sites: AnyRecord[];
}

function buildManagerDashboard(rootDir: string, state: ManagerState): ManagerDashboard {
  const sites = listManagedSites(rootDir)
    .slice()
    .sort((left, right) => compareManagedSites(left, right));

  const runningSiteCount = sites.filter((site) => site.status === 'running' || site.status === 'starting').length;
  const stoppedSiteCount = sites.filter((site) => site.status === 'stopped' || site.status === 'error').length;
  const healthySiteCount = sites.filter((site) => site.healthStatus === 'healthy').length;
  const deployedSiteCount = sites.filter((site) => site.deployment?.status === 'deployed' || Boolean(site.publicUrl)).length;
  const pendingDeployCount = sites.filter((site) => site.deployment?.status === 'pending').length;

  return {
    siteCount: sites.length,
    runningSiteCount,
    stoppedSiteCount,
    healthySiteCount,
    deployedSiteCount,
    pendingDeployCount,
    sites: sites.map((site) => summarizeManagedSite(site)),
  };
}

function summarizeManagedSite(site: ManagedSiteRecord) {
  const deploymentStatus = site.deployment?.status || 'idle';
  const displayRoute = site.routePath || `/sites/${site.slug}`;
  return {
    id: site.id,
    slug: site.slug,
    name: site.name,
    description: site.description || '',
    repoRoot: site.repoRoot || site.siteDir,
    branch: site.branch || 'main',
    localUrl: site.localUrl || null,
    routePath: displayRoute,
    status: site.status,
    desiredState: site.desiredState,
    installStatus: site.installStatus || 'installed',
    initStatus: site.initStatus || 'initialized',
    bootstrapError: site.bootstrapError || null,
    port: site.port,
    pid: site.pid || null,
    healthStatus: site.healthStatus || 'unknown',
    healthMessage: site.healthMessage || '',
    healthCheckedAt: site.healthCheckedAt || null,
    publicUrl: site.publicUrl || null,
    deploymentStatus,
    deployment: site.deployment || { status: 'idle' },
    content: site.content || null,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt,
    startedAt: site.startedAt || null,
    stoppedAt: site.stoppedAt || null,
    lastExitCode: site.lastExitCode ?? null,
    lastSignal: site.lastSignal || null,
  };
}

function compareManagedSites(left: ManagedSiteRecord, right: ManagedSiteRecord) {
  const leftRank = siteRank(left);
  const rightRank = siteRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  const leftTime = Date.parse(String(left.updatedAt || left.createdAt || '')) || 0;
  const rightTime = Date.parse(String(right.updatedAt || right.createdAt || '')) || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  return String(left.name || left.id || '').localeCompare(String(right.name || right.id || ''));
}

function siteRank(site: ManagedSiteRecord) {
  if (site.status === 'running' || site.status === 'starting') {
    return 0;
  }
  if (site.deployment?.status === 'pending') {
    return 1;
  }
  if (site.status === 'error') {
    return 2;
  }
  return 3;
}

export {
  buildManagerDashboard,
};
