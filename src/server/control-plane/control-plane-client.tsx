/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { Fragment, h, renderToHtml } from './control-plane-jsx-runtime/jsx-runtime.js';

type SiteDeployment = {
  target?: string;
  status?: string;
  provider?: string;
  appName?: string;
  appUrl?: string;
  buildId?: string;
  version?: string;
  lastError?: string;
  updatedAt?: string | null;
};

type SiteSummary = {
  id: string;
  slug?: string;
  name?: string;
  description?: string;
  routePath?: string;
  status?: string;
  desiredState?: string;
  port?: number;
  pid?: number | null;
  healthStatus?: string;
  healthMessage?: string;
  publicUrl?: string | null;
  deploymentStatus?: string;
  deployment?: SiteDeployment;
  content?: {
    title?: string;
    headline?: string;
    body?: string;
    footer?: string;
  } | null;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
  lastExitCode?: number | null;
  lastSignal?: string | null;
};

type ManagerDashboard = {
  siteCount?: number;
  runningSiteCount?: number;
  stoppedSiteCount?: number;
  healthySiteCount?: number;
  deployedSiteCount?: number;
  pendingDeployCount?: number;
  sites?: SiteSummary[];
};

type ManagerStateSnapshot = {
  state?: Record<string, unknown>;
  dashboard?: ManagerDashboard;
  sites?: SiteSummary[];
};

type SiteLogsResponse = {
  lines?: string[];
  text?: string;
};

const siteForm = document.getElementById('site-form') as HTMLFormElement | null;
const refreshButton = document.getElementById('refresh-button');
const messageEl = document.getElementById('form-message');
const lastUpdatedEl = document.getElementById('last-updated');
const managerMetricsEl = document.getElementById('manager-metrics');
const managerSummaryNoteEl = document.getElementById('manager-summary-note');
const siteStackEl = document.getElementById('site-stack');
const siteDetailEl = document.getElementById('site-detail');
const rawManagerStateEl = document.getElementById('raw-manager-state');
const rawSitesEl = document.getElementById('raw-sites');
const rawSelectedSiteEl = document.getElementById('raw-selected-site');
const rawLogsEl = document.getElementById('raw-logs');
const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-tab]'));
const panels: Record<string, HTMLElement | null> = {
  overview: document.getElementById('overview-panel'),
  create: document.getElementById('create-panel'),
  advanced: document.getElementById('advanced-panel'),
};

let latestSnapshot: ManagerStateSnapshot = {};
let selectedSiteId: string | null = null;
let latestSites: SiteSummary[] = [];
let latestLogs = '';

function mountControlPlane() {
  if (
    !siteForm
    || !refreshButton
    || !messageEl
    || !lastUpdatedEl
    || !managerMetricsEl
    || !managerSummaryNoteEl
    || !siteStackEl
    || !siteDetailEl
    || !rawManagerStateEl
    || !rawSitesEl
    || !rawSelectedSiteEl
    || !rawLogsEl
  ) {
    return;
  }

  siteForm.addEventListener('submit', handleSubmit);
  refreshButton.addEventListener('click', () => refresh().catch((error: unknown) => {
    setMessage(getErrorMessage(error));
  }));

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => setActiveTab(String(tab.dataset.tab || 'overview')));
  });

  siteStackEl.addEventListener('click', handleSiteStackClick);
  siteStackEl.addEventListener('keydown', handleSiteStackKeydown);
  siteDetailEl.addEventListener('click', handleSiteDetailClick);

  refresh().catch((error: unknown) => {
    setMessage(getErrorMessage(error));
  });

  window.setInterval(() => refresh().catch(() => {}), 5000);
}

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (!siteForm || !messageEl) {
    return;
  }

  setMessage('Creating site...');

  try {
    const body = buildCreatePayload();
    const response = await requestJson<{ site?: SiteSummary }>('/api/sites', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (response && response.site && response.site.id) {
      selectedSiteId = response.site.id;
    }
    siteForm.reset();
    await refresh();
    setActiveTab('overview');
    setMessage('Site created.');
  } catch (error) {
    setMessage(getErrorMessage(error));
  }
}

function buildCreatePayload() {
  const getValue = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null)?.value.trim() || '';
  const getChecked = (id: string) => Boolean((document.getElementById(id) as HTMLInputElement | null)?.checked);

  return {
    name: getValue('site-name'),
    slug: getValue('site-slug'),
    description: getValue('site-description'),
    autoStart: getChecked('site-auto-start'),
    publishToHeroku: getChecked('site-publish-heroku'),
    content: {
      headline: getValue('site-headline') || getValue('site-name'),
      body: getValue('site-body'),
      footer: getValue('site-footer'),
    },
  };
}

async function refresh() {
  const snapshot = await requestJson<ManagerStateSnapshot>('/api/manager-state');
  latestSnapshot = snapshot || {};
  latestSites = Array.isArray(snapshot.sites) ? snapshot.sites.slice() : Array.isArray(snapshot.dashboard?.sites) ? snapshot.dashboard!.sites!.slice() : [];

  if (selectedSiteId && !latestSites.some((site) => site.id === selectedSiteId)) {
    selectedSiteId = latestSites.length > 0 ? latestSites[0].id : null;
  }
  if (!selectedSiteId && latestSites.length > 0) {
    selectedSiteId = latestSites[0].id;
  }

  renderMetrics(snapshot.dashboard || {});
  renderSiteStack(latestSites);
  renderSiteDetail();
  renderAdvanced();

  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init && init.headers ? init.headers : {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || response.statusText);
  }

  return response.json() as Promise<T>;
}

async function performSiteAction(siteId: string, action: 'start' | 'stop' | 'restart' | 'deploy') {
  setMessage(`${action}ing site...`);
  const response = await requestJson<{ site?: SiteSummary }>(`/api/sites/${encodeURIComponent(siteId)}/${action}`, {
    method: 'POST',
  });
  if (response && response.site && response.site.id) {
    selectedSiteId = response.site.id;
  }
  await refresh();
  setMessage(`${capitalize(action)} complete.`);
}

function handleSiteStackClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }
  const button = target.closest('[data-site-action]') as HTMLElement | null;
  if (button) {
    event.preventDefault();
    event.stopPropagation();
    const siteId = String(button.getAttribute('data-site-id') || '');
    const action = String(button.getAttribute('data-site-action') || '') as 'start' | 'stop' | 'restart' | 'deploy';
    if (siteId && action) {
      void performSiteAction(siteId, action).catch((error: unknown) => {
        setMessage(getErrorMessage(error));
      });
    }
    return;
  }

  const card = target.closest('[data-site-id]') as HTMLElement | null;
  if (card) {
    selectedSiteId = String(card.getAttribute('data-site-id') || '');
    renderSiteStack(latestSites);
    renderSiteDetail();
    renderAdvanced();
  }
}

function handleSiteStackKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }
  if (target.closest('[data-site-action]')) {
    return;
  }
  const card = target.closest('[data-site-id]') as HTMLElement | null;
  if (!card) {
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') {
    return;
  }
  event.preventDefault();
  selectedSiteId = String(card.getAttribute('data-site-id') || '');
  renderSiteStack(latestSites);
  renderSiteDetail();
  renderAdvanced();
}

function handleSiteDetailClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (!target) {
    return;
  }
  const button = target.closest('[data-site-action]') as HTMLElement | null;
  if (!button) {
    return;
  }
  event.preventDefault();
  const siteId = String(button.getAttribute('data-site-id') || selectedSiteId || '');
  const action = String(button.getAttribute('data-site-action') || '') as 'start' | 'stop' | 'restart' | 'deploy';
  if (!siteId || !action) {
    return;
  }
  void performSiteAction(siteId, action).catch((error: unknown) => {
    setMessage(getErrorMessage(error));
  });
}

function renderMetrics(dashboard: ManagerDashboard) {
  if (!managerMetricsEl || !managerSummaryNoteEl) {
    return;
  }

  const metrics = [
    ['Sites', dashboard.siteCount || 0],
    ['Running', dashboard.runningSiteCount || 0],
    ['Stopped', dashboard.stoppedSiteCount || 0],
    ['Healthy', dashboard.healthySiteCount || 0],
    ['Heroku', dashboard.deployedSiteCount || 0],
    ['Pending deploys', dashboard.pendingDeployCount || 0],
  ] as const;

  managerMetricsEl.innerHTML = renderToHtml(
    <MetricGrid metrics={metrics} />
  );
  managerSummaryNoteEl.textContent = dashboard.siteCount && dashboard.siteCount > 0
    ? `${dashboard.siteCount} site${dashboard.siteCount === 1 ? '' : 's'} under management`
    : 'No sites yet';
}

function renderSiteStack(sites: SiteSummary[]) {
  if (!siteStackEl) {
    return;
  }
  siteStackEl.innerHTML = renderToHtml(
    <SiteStack
      sites={sites}
      selectedSiteId={selectedSiteId}
    />
  );
}

function renderSiteDetail() {
  if (!siteDetailEl) {
    return;
  }
  const site = latestSites.find((entry) => entry.id === selectedSiteId) || latestSites[0] || null;
  const logs = site ? latestLogs : '';
  siteDetailEl.innerHTML = renderToHtml(
    <SelectedSitePanel
      site={site}
      logs={logs}
    />
  );
  if (site) {
    void loadSiteLogs(site.id);
  } else {
    latestLogs = '';
  }
}

async function loadSiteLogs(siteId: string) {
  try {
    const response = await requestJson<SiteLogsResponse>(`/api/sites/${encodeURIComponent(siteId)}/logs`);
    latestLogs = Array.isArray(response.lines) ? response.lines.join('\n') : String(response.text || '');
  } catch {
    latestLogs = '';
  }
  renderAdvanced();
  if (selectedSiteId === siteId && siteDetailEl) {
    const site = latestSites.find((entry) => entry.id === siteId) || null;
    siteDetailEl.innerHTML = renderToHtml(
      <SelectedSitePanel
        site={site}
        logs={latestLogs}
      />
    );
  }
}

function renderAdvanced() {
  if (!rawManagerStateEl || !rawSitesEl || !rawSelectedSiteEl || !rawLogsEl) {
    return;
  }

  rawManagerStateEl.textContent = JSON.stringify(latestSnapshot.state || latestSnapshot, null, 2);
  rawSitesEl.textContent = JSON.stringify(latestSites, null, 2);
  rawSelectedSiteEl.textContent = JSON.stringify(
    latestSites.find((site) => site.id === selectedSiteId) || null,
    null,
    2
  );
  rawLogsEl.textContent = latestLogs || 'No logs yet.';
}

function setActiveTab(tabName: string) {
  tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabName;
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  Object.entries(panels).forEach(([name, panel]) => {
    if (panel) {
      panel.classList.toggle('active', name === tabName);
    }
  });
}

function setMessage(message: string) {
  if (messageEl) {
    messageEl.textContent = message;
  }
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || 'Unexpected error');
}

function MetricGrid({ metrics }: { metrics: readonly (readonly [string, number])[] }) {
  return (
    <>
      {metrics.map(([label, value]) => (
        <div className="metric">
          <span>{label}</span>
          <strong>{String(value)}</strong>
        </div>
      ))}
    </>
  );
}

function SiteStack({
  sites,
  selectedSiteId,
}: {
  sites: SiteSummary[];
  selectedSiteId: string | null;
}) {
  if (!sites.length) {
    return <div className="muted">No sites yet. Create one to start managing it.</div>;
  }

  return (
    <>
      {sites.map((site) => (
        <SiteCard
          site={site}
          selected={site.id === selectedSiteId}
        />
      ))}
    </>
  );
}

function SiteCard({
  site,
  selected,
}: {
  site: SiteSummary;
  selected: boolean;
}) {
  return (
    <article
      className={`site-card${selected ? ' selected' : ''}`}
      data-site-id={site.id}
      role="button"
      tabIndex={0}
    >
      <div className="site-head">
        <div>
          <div className="site-title">{site.name || site.slug || site.id}</div>
          <div className="muted">{site.description || site.routePath || ''}</div>
        </div>
        <div className="site-badges">
          <span className={`pill${site.status === 'error' ? ' warn' : ''}`}>{site.status || 'stopped'}</span>
          <span className="pill">{site.port ? `:${site.port}` : 'no port'}</span>
          <span className={`pill${site.deploymentStatus === 'failed' ? ' warn' : ''}`}>{site.deploymentStatus || 'idle'}</span>
        </div>
      </div>
      <div className="overview">
        {site.healthStatus ? `${site.healthStatus}. ` : ''}
        {site.publicUrl ? `Heroku: ${site.publicUrl}` : site.routePath || ''}
      </div>
      <div className="row">
        <button type="button" data-site-id={site.id} data-site-action="start">Start</button>
        <button type="button" data-site-id={site.id} data-site-action="stop">Stop</button>
        <button type="button" data-site-id={site.id} data-site-action="restart">Restart</button>
        <button type="button" data-site-id={site.id} data-site-action="deploy">Deploy</button>
      </div>
    </article>
  );
}

function SelectedSitePanel({
  site,
  logs,
}: {
  site: SiteSummary | null;
  logs: string;
}) {
  if (!site) {
    return (
      <div>
        <h3>Selected site</h3>
        <div className="list-note">Select a site to view process details, proxy links, and deployment status.</div>
      </div>
    );
  }

  return (
    <>
      <div className="item-head">
        <div>
          <div className="pill">Selected site</div>
          <h3 style={{ marginTop: '8px' }}>{site.name || site.id}</h3>
        </div>
        <div className="site-badges">
          <span className="pill">{site.status || 'stopped'}</span>
          <span className="pill">{site.healthStatus || 'unknown'}</span>
        </div>
      </div>
      <div className="list-note">{site.description || 'No description provided.'}</div>
      <div className="section-row">
        <div className="list-note">Route: <a href={site.routePath || '#'}>{site.routePath || 'n/a'}</a></div>
        <div className="list-note">Local port: {site.port ? `:${site.port}` : 'n/a'}</div>
        <div className="list-note">Process id: {site.pid || 'n/a'}</div>
        <div className="list-note">Public URL: {site.publicUrl || 'Not published yet'}</div>
        <div className="list-note">Deployment: {site.deploymentStatus || 'idle'}</div>
        <div className="list-note">Health: {site.healthMessage || 'No health check yet.'}</div>
      </div>
      <div className="row body-note">
        <button type="button" data-site-id={site.id} data-site-action="start">Start</button>
        <button type="button" data-site-id={site.id} data-site-action="stop">Stop</button>
        <button type="button" data-site-id={site.id} data-site-action="restart">Restart</button>
        <button type="button" data-site-id={site.id} data-site-action="deploy">Deploy</button>
      </div>
      <div className="section-divider" />
      <div>
        <h4>Site logs</h4>
        <pre>{logs || 'No logs yet.'}</pre>
      </div>
    </>
  );
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountControlPlane();
}

export {
  mountControlPlane,
};
