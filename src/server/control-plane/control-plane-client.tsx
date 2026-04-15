/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { Fragment, h, renderToHtml } from './control-plane-jsx-runtime/jsx-runtime.js';

declare global {
  interface Window {
    __AUTONOMY_CONTROL_PLANE_DEV__?: boolean;
    __AUTONOMY_CONTROL_PLANE_DEV_TOKEN__?: string;
    __AUTONOMY_CONTROL_PLANE_API_BASE_URL__?: string;
  }
}

type RepoRecord = {
  repoId: string;
  label: string;
  description?: string;
  default?: boolean;
  deploymentUrl?: string;
  deploymentLabel?: string;
};

type PrdSummary = {
  id?: string;
  title?: string;
  stateLabel?: string;
  detail?: string;
  updatedAt?: string | null;
};

type AgentSummary = {
  role?: string;
  agentId?: string;
  workerStatus?: string;
  detail?: string;
  pid?: number;
};

type PullRequestSummary = {
  title?: string;
  prId?: string;
  statusLabel?: string;
  status?: string;
  action?: string;
  branch?: string;
  url?: string | null;
  updatedAt?: string | null;
};

type JobSummary = {
  id?: string;
  title?: string;
  status?: string;
  statusLabel?: string;
  detail?: string;
  repoId?: string;
  repoLabel?: string;
  updatedAt?: string | null;
  createdAt?: string | null;
  action?: string;
  branch?: string;
};

type HeartbeatSummary = {
  label?: string;
  status?: string;
  statusLabel?: string;
  detail?: string;
  updatedAt?: string | null;
};

type ControlPlaneHeartbeatSummary = {
  overallStatus?: string;
  statusLabel?: string;
  server?: HeartbeatSummary;
  bridge?: HeartbeatSummary;
};

type RepoSummary = {
  repoId?: string;
  label?: string;
  description?: string;
  default?: boolean;
  updatedAt?: string | null;
  overview?: string;
  freshnessStatus?: string;
  freshnessStatusLabel?: string;
  freshnessDetail?: string;
  activePrd?: PrdSummary | null;
  queuedPrds?: PrdSummary[];
  agentStatuses?: AgentSummary[];
  pullRequestStatuses?: PullRequestSummary[];
  deployment?: {
    sourceBranch?: string;
    targetBranch?: string;
    sourceAheadBy?: number;
    targetAheadBy?: number;
    branchesAligned?: boolean;
    hasChanges?: boolean;
    deployable?: boolean;
    status?: string;
    statusLabel?: string;
    detail?: string;
  } | null;
  deploymentUrl?: string | null;
  deploymentLabel?: string | null;
  deployJob?: JobSummary | null;
};

type DashboardSummary = {
  repoCount?: number;
  activePrdCount?: number;
  queuedPrdCount?: number;
  deployableRepoCount?: number;
  pendingJobCount?: number;
  runningAgentCount?: number;
  activePullRequestCount?: number;
  overallHeartbeatStatus?: string;
  statusLabel?: string;
  serverHeartbeat?: HeartbeatSummary;
  bridgeHeartbeat?: HeartbeatSummary;
  repos?: RepoSummary[];
  jobs?: JobSummary[];
};

type StateSnapshot = {
  dashboard?: DashboardSummary;
  jobs?: JobSummary[];
  [key: string]: unknown;
};

type EntranceContext = {
  entrance: 'manager' | 'project';
  repoId: string;
};

const repoSelect = document.getElementById('repo-id') as HTMLSelectElement | null;
const lastUpdatedEl = document.getElementById('last-updated');
const messageEl = document.getElementById('form-message');
const form = document.getElementById('prd-form') as HTMLFormElement | null;
const refreshButton = document.getElementById('refresh-button');
const dashboardMetricsEl = document.getElementById('dashboard-metrics');
const dashboardReposEl = document.getElementById('dashboard-repos');
const dashboardJobsEl = document.getElementById('dashboard-jobs');
const dashboardSummaryNoteEl = document.getElementById('dashboard-summary-note');
const controlPlaneHeartbeatsEl = document.getElementById('control-plane-heartbeats');
const rawStateEl = document.getElementById('raw-state');
const rawDashboardEl = document.getElementById('raw-dashboard');
const rawJobsEl = document.getElementById('raw-jobs');
const rawReposEl = document.getElementById('raw-repos');
const fixedRepoIdEl = document.getElementById('fixed-repo-id');
const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-tab]'));
const panels: Record<string, HTMLElement | null> = {
  dashboard: document.getElementById('dashboard-panel'),
  submit: document.getElementById('submit-panel'),
  advanced: document.getElementById('advanced-panel'),
};
const entranceContext = readEntranceContext();
const apiBaseUrl = String(window.__AUTONOMY_CONTROL_PLANE_API_BASE_URL__ || '').trim().replace(/\/+$/, '');

let latestRepos: RepoRecord[] = [];
let deployingRepoIds = new Set<string>();
let devUiToken = String(window.__AUTONOMY_CONTROL_PLANE_DEV_TOKEN__ || '');

function mountControlPlane() {
  if (
    !lastUpdatedEl
    || !dashboardReposEl
    || !dashboardSummaryNoteEl
    || !controlPlaneHeartbeatsEl
  ) {
    return;
  }

  if (form) {
    form.addEventListener('submit', handleSubmit);
  }
  if (refreshButton) {
    refreshButton.addEventListener('click', () => refresh().catch((error: unknown) => {
      if (messageEl) {
        messageEl.textContent = getErrorMessage(error);
      }
    }));
  }
  dashboardReposEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const button = target ? target.closest<HTMLButtonElement>('[data-action="deploy"]') : null;
    if (!button) {
      return;
    }
    const repoId = String(button.dataset.repoId || '').trim();
    if (!repoId) {
      return;
    }
    handleDeploy(repoId).catch((error: unknown) => {
      if (messageEl) {
        messageEl.textContent = getErrorMessage(error);
      }
    });
  });

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => setActiveTab(String(tab.dataset.tab || 'dashboard')));
  });

  refresh().catch((error: unknown) => {
    if (messageEl) {
      messageEl.textContent = getErrorMessage(error);
    }
  });

  window.setInterval(() => refresh().catch(() => {}), 5000);
  if (window.__AUTONOMY_CONTROL_PLANE_DEV__ === true) {
    window.setInterval(() => checkForUiReload().catch(() => {}), 1000);
  }
}

async function handleSubmit(event: SubmitEvent) {
  event.preventDefault();

  if (!form || !messageEl) {
    return;
  }

  messageEl.textContent = 'Queueing...';

  try {
    const taskSpecsRaw = (document.getElementById('prd-task-specs') as HTMLTextAreaElement | null)?.value.trim() || '';
    const targetRepoId = entranceContext.entrance === 'project'
      ? entranceContext.repoId
      : String(repoSelect && repoSelect.value || '').trim();
    if (!targetRepoId) {
      throw new Error('No repo selected.');
    }
    const body = {
      repoId: targetRepoId,
      id: (document.getElementById('prd-id') as HTMLInputElement | null)?.value.trim() || '',
      title: (document.getElementById('prd-title') as HTMLInputElement | null)?.value.trim() || '',
      specification: (document.getElementById('prd-spec') as HTMLTextAreaElement | null)?.value.trim() || '',
      requirements: ((document.getElementById('prd-req') as HTMLTextAreaElement | null)?.value || '')
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean),
      sprintId: (document.getElementById('prd-sprint') as HTMLInputElement | null)?.value.trim() || '',
      taskSpecs: taskSpecsRaw ? JSON.parse(taskSpecsRaw) : [],
    };

    await requestJson('/api/jobs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    form.reset();
    await refresh();
    messageEl.textContent = 'Queued.';
  } catch (error) {
    messageEl.textContent = getErrorMessage(error);
  }
}

async function refresh() {
  const reposRequestUrl = entranceContext.entrance === 'project' && entranceContext.repoId
    ? `/api/repos?repoId=${encodeURIComponent(entranceContext.repoId)}`
    : '/api/repos';
  const stateRequestUrl = entranceContext.entrance === 'project' && entranceContext.repoId
    ? `/api/state?repoId=${encodeURIComponent(entranceContext.repoId)}`
    : '/api/state';
  const [repos, state] = await Promise.all([
    requestJson<{ repos?: RepoRecord[] }>(reposRequestUrl),
    requestJson<StateSnapshot>(stateRequestUrl),
  ]);

  renderRepos(repos.repos || []);
  renderDashboard(state.dashboard || {});
  renderControlPlaneHeartbeats(state.dashboard || {});
  renderAdvanced(state);

  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }
}

async function handleDeploy(repoId: string) {
  if (!repoId || deployingRepoIds.has(repoId)) {
    return;
  }

  deployingRepoIds = new Set(deployingRepoIds).add(repoId);
  if (messageEl) {
    messageEl.textContent = `Queueing deploy for ${repoId}...`;
  }

  try {
    await requestJson(`/api/repos/${encodeURIComponent(repoId)}/deploy`, {
      method: 'POST',
      body: JSON.stringify({ repoId }),
    });
    await refresh();
    if (messageEl) {
      messageEl.textContent = `Deploy queued for ${repoId}.`;
    }
  } finally {
    const next = new Set(deployingRepoIds);
    next.delete(repoId);
    deployingRepoIds = next;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(url), {
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

async function checkForUiReload() {
  const payload = await requestJson<{ devMode?: boolean; devToken?: string }>('/api/dev-meta', {
    headers: {},
  });
  if (payload.devMode !== true) {
    return;
  }
  const nextToken = String(payload.devToken || '');
  if (!devUiToken) {
    devUiToken = nextToken;
    return;
  }
  if (nextToken && nextToken !== devUiToken) {
    window.location.reload();
  }
}

function renderRepos(repos: RepoRecord[]) {
  latestRepos = Array.isArray(repos) ? repos.slice() : [];
  if (repoSelect) {
    const previous = repoSelect.value;
    repoSelect.innerHTML = renderToHtml(<RepoOptions repos={latestRepos} />);

    if (previous && latestRepos.some((repo) => repo.repoId === previous)) {
      repoSelect.value = previous;
    } else if (!repoSelect.value && latestRepos.length > 0) {
      repoSelect.value = latestRepos[0].repoId;
    }

    repoSelect.disabled = latestRepos.length === 0;
  }

  if (fixedRepoIdEl) {
    const activeRepo = latestRepos.find((repo) => repo.repoId === entranceContext.repoId);
    fixedRepoIdEl.textContent = activeRepo
      ? `${activeRepo.label}${activeRepo.description ? ` - ${activeRepo.description}` : ''}`
      : entranceContext.repoId || 'Unknown repo';
  }
}

function renderDashboard(dashboard: DashboardSummary) {
  if (!dashboardReposEl || !dashboardSummaryNoteEl) {
    return;
  }

  const deployableRepoCount = resolveDeployableRepoCount(dashboard);
  const deployableRepoLabel = `${deployableRepoCount} deployable repo${deployableRepoCount === 1 ? '' : 's'}`;
  if (dashboardMetricsEl) {
    dashboardMetricsEl.innerHTML = renderToHtml(<MetricGrid dashboard={dashboard} />);
  }
  dashboardSummaryNoteEl.textContent = entranceContext.entrance === 'manager'
    ? (
      dashboard.repoCount && dashboard.repoCount > 0
        ? `${dashboard.repoCount} repo${dashboard.repoCount === 1 ? '' : 's'} visible`
        : 'No repo snapshots yet'
    )
    : dashboard.repoCount && dashboard.repoCount > 0
      ? `${dashboard.repoCount} repo${dashboard.repoCount === 1 ? '' : 's'} visible · ${deployableRepoLabel}`
      : `Repo ${entranceContext.repoId || ''} is not registered yet.`;
  dashboardReposEl.innerHTML = renderToHtml(
    <RepoStack
      repos={dashboard.repos || []}
      emptyMessage={entranceContext.entrance === 'project'
        ? `Repo ${entranceContext.repoId || 'unknown'} is unavailable or has not registered yet.`
        : 'No repository snapshots yet.'}
    />
  );
  if (dashboardJobsEl) {
    dashboardJobsEl.innerHTML = renderToHtml(<JobStack jobs={dashboard.jobs || []} />);
  }
}

function renderControlPlaneHeartbeats(dashboard: DashboardSummary) {
  if (!controlPlaneHeartbeatsEl) {
    return;
  }

  controlPlaneHeartbeatsEl.innerHTML = renderToHtml(
    <HeartbeatStrip
      controlPlane={{
        overallStatus: dashboard.overallHeartbeatStatus,
        statusLabel: dashboard.statusLabel,
        server: dashboard.serverHeartbeat,
        bridge: dashboard.bridgeHeartbeat,
      }}
    />
  );
}

function renderAdvanced(state: StateSnapshot) {
  if (!rawStateEl || !rawDashboardEl || !rawJobsEl || !rawReposEl) {
    return;
  }

  rawStateEl.textContent = JSON.stringify(state, null, 2);
  rawDashboardEl.textContent = JSON.stringify(state.dashboard || {}, null, 2);
  rawJobsEl.textContent = JSON.stringify(state.jobs || [], null, 2);
  rawReposEl.textContent = JSON.stringify(
    latestRepos.map((repo) => ({
      repoId: repo.repoId,
      label: repo.label,
      description: repo.description || '',
      default: Boolean(repo.default),
    })),
    null,
    2
  );
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

function RepoOptions({ repos }: { repos: RepoRecord[] }) {
  return (
    <>
      {repos.map((repo) => {
        const label = repo.description ? `${repo.label} - ${repo.description}` : repo.label;
        return <option value={repo.repoId}>{label}</option>;
      })}
    </>
  );
}

function MetricGrid({ dashboard }: { dashboard: DashboardSummary }) {
  const deployableRepoCount = resolveDeployableRepoCount(dashboard);
  const metrics = [
    ['Repos', dashboard.repoCount || 0],
    ['Active PRDs', dashboard.activePrdCount || 0],
    ['Queued PRDs', dashboard.queuedPrdCount || 0],
    ['Deployable repos', deployableRepoCount],
    ['Bridge jobs', dashboard.pendingJobCount || 0],
    ['Agents running', dashboard.runningAgentCount || 0],
    ['Active PRs', dashboard.activePullRequestCount || 0],
  ] as const;

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

function HeartbeatStrip({
  controlPlane,
}: {
  controlPlane: ControlPlaneHeartbeatSummary;
}) {
  const server = controlPlane.server || {};
  const bridge = controlPlane.bridge || {};
  return (
    <>
      <div className={`status-chip ${statusClass(controlPlane.overallStatus)}`}>
        <span className="status-dot" />
        <span>Control plane: {controlPlane.statusLabel || 'Offline'}</span>
      </div>
      <div className="status-stack">
        <div className={`status-chip ${statusClass(server.status)}`}>
          <span className="status-dot" />
          <span>{server.label || 'Server'}: {server.statusLabel || 'Offline'}</span>
        </div>
        <div className={`status-chip ${statusClass(bridge.status)}`}>
          <span className="status-dot" />
          <span>{bridge.label || 'Bridge'}: {bridge.statusLabel || 'Offline'}</span>
        </div>
      </div>
    </>
  );
}

function statusClass(status?: string) {
  return String(status || 'offline');
}

function resolveDeployableRepoCount(dashboard: DashboardSummary) {
  if (typeof dashboard.deployableRepoCount === 'number') {
    return dashboard.deployableRepoCount;
  }
  return countDeployableRepos(dashboard.repos || []);
}

function countDeployableRepos(repos: RepoSummary[]) {
  return repos.filter((repo) => Boolean(repo && repo.deployment && (repo.deployment.hasChanges || repo.deployment.deployable))).length;
}

function resolveApiUrl(pathname: string) {
  const normalizedPath = String(pathname || '').trim();
  if (!normalizedPath) {
    return normalizedPath;
  }
  if (/^https?:\/\//i.test(normalizedPath)) {
    return normalizedPath;
  }
  if (normalizedPath === '/api/dev-meta') {
    return normalizedPath;
  }
  return apiBaseUrl ? `${apiBaseUrl}${normalizedPath}` : normalizedPath;
}

function RepoStack({ repos, emptyMessage }: { repos: RepoSummary[]; emptyMessage: string }) {
  if (!repos.length) {
    return <div className="muted">{emptyMessage}</div>;
  }

  return (
    <>
      {repos.map((repo) => (
        entranceContext.entrance === 'manager'
          ? <ManagerRepoCard repo={repo} />
          : <ProjectRepoCard repo={repo} />
      ))}
    </>
  );
}

function ManagerRepoCard({ repo }: { repo: RepoSummary }) {
  const updated = repo.updatedAt ? `Updated ${formatTimestamp(repo.updatedAt)}` : 'No status snapshot yet';
  const freshnessStatus = String(repo.freshnessStatus || 'offline');
  const freshnessLabel = repo.freshnessStatusLabel || 'Offline';
  const deployment = repo.deployment || null;
  const projectUrl = repo.repoId ? `/project/${encodeURIComponent(repo.repoId)}` : '';

  return (
    <article className="repo">
      <div className="repo-head">
        <div>
          <h3>{repo.label || repo.repoId || 'Repository'}</h3>
          <div className="muted">{repo.description || repo.repoId || ''}</div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', flex: '0 0 auto' }}>
          <div className={`status-chip ${statusClass(freshnessStatus)}`}>
            <span className="status-dot" />
            <span>{freshnessLabel}</span>
          </div>
          <span className="pill">{updated}</span>
        </div>
      </div>
      <p className="overview">{repo.freshnessDetail || repo.overview || 'No status snapshot yet'}</p>
      <div className="section-row">
        <RepoSection title="Repo">
          <div className="list-note">ID: {repo.repoId || 'unknown'}</div>
          {projectUrl ? (
            <a className="action-link" href={projectUrl}>
              Open repo control page
            </a>
          ) : null}
        </RepoSection>
        <RepoSection title="Deployment">
          <div className={`status-chip ${statusClass(deployment && deployment.status)}`}>
            <span className="status-dot" />
            <span>{deployment && deployment.statusLabel ? deployment.statusLabel : 'Deployment status unavailable'}</span>
          </div>
          <div className="list-note" style={{ marginTop: '8px' }}>
            {deployment && deployment.detail ? deployment.detail : 'No deployment status snapshot yet.'}
          </div>
          {repo.deploymentUrl ? (
            <a
              className="action-link"
              href={repo.deploymentUrl}
              target="_blank"
              rel="noreferrer"
            >
              {repo.deploymentLabel || 'Deployment site'}
            </a>
          ) : null}
        </RepoSection>
      </div>
    </article>
  );
}

function ProjectRepoCard({ repo }: { repo: RepoSummary }) {
  const updated = repo.updatedAt ? `Updated ${formatTimestamp(repo.updatedAt)}` : 'No status snapshot yet';
  const deployment = repo.deployment || null;
  const deployJobPending = ['queued', 'claimed', 'running'].includes(String(repo.deployJob && repo.deployJob.status || ''));
  const showDeployButton = Boolean(repo.repoId && deployment && deployment.hasChanges);
  const deployButtonLabel = deployJobPending ? 'Deploy queued' : `Deploy ${deployment && deployment.sourceBranch ? deployment.sourceBranch : 'dev'} to ${deployment && deployment.targetBranch ? deployment.targetBranch : 'main'}`;
  const deploymentStatus = deployment ? deployment.status : null;

  return (
    <article className="repo">
      <div className="repo-head">
        <div>
          <h3>{repo.label || repo.repoId || 'Repository'}</h3>
          <div className="muted">{repo.description || repo.repoId || ''}</div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', flex: '0 0 auto' }}>
          {repo.default ? <span className="pill">Default repo</span> : null}
          <span className="pill">{updated}</span>
        </div>
      </div>
      <p className="overview">{repo.overview || 'No status snapshot yet'}</p>
      <div className="section-row">
        <RepoSection title="Active PRD">
          {repo.activePrd ? <PrdCard prd={repo.activePrd} label="Active PRD" /> : <div className="list-note">No active PRD yet.</div>}
        </RepoSection>
        <RepoSection title="Queued PRDs">
          {repo.queuedPrds && repo.queuedPrds.length > 0
            ? repo.queuedPrds.map((prd) => <PrdCard prd={prd} label="Queued PRD" />)
            : <div className="list-note">No queued PRDs.</div>}
        </RepoSection>
        <RepoSection title="Agents">
          {repo.agentStatuses && repo.agentStatuses.length > 0
            ? repo.agentStatuses.map((agent) => <AgentCard agent={agent} />)
            : <div className="list-note">No agent status yet.</div>}
        </RepoSection>
        <RepoSection title="Active PRs">
          {repo.pullRequestStatuses && repo.pullRequestStatuses.length > 0
            ? repo.pullRequestStatuses.map((pullRequest) => <PullRequestCard pullRequest={pullRequest} />)
            : <div className="list-note">No active PRs.</div>}
        </RepoSection>
        <RepoSection title="Deployment">
          <div className="queued-prd">
            <div className="item-head">
              <div>
                <div className={`status-chip ${statusClass(deploymentStatus)}`}>
                  <span className="status-dot" />
                  <span>{deployment && deployment.statusLabel ? deployment.statusLabel : 'Deploy status unavailable'}</span>
                </div>
                <div className="queue-title">
                  {deployment
                    ? `${deployment.sourceBranch || 'dev'} -> ${deployment.targetBranch || 'main'}`
                    : 'Deployment status'}
                </div>
              </div>
            </div>
            <div className="queue-detail">
              {deployment && deployment.detail ? deployment.detail : 'No deployment status snapshot yet.'}
            </div>
            {repo.deployJob ? (
              <div className="queue-detail" style={{ marginTop: '8px' }}>
                Latest deploy job: {repo.deployJob.statusLabel || repo.deployJob.status || 'queued'}
                {repo.deployJob.detail ? ` | ${repo.deployJob.detail}` : ''}
              </div>
            ) : null}
            <div className="repo-actions" style={{ marginTop: '12px' }}>
              {showDeployButton ? (
                <button
                  type="button"
                  className="primary"
                  data-action="deploy"
                  data-repo-id={repo.repoId || ''}
                  disabled={deployJobPending || deployingRepoIds.has(String(repo.repoId || ''))}
                >
                  {deployingRepoIds.has(String(repo.repoId || '')) ? 'Queueing deploy...' : deployButtonLabel}
                </button>
              ) : null}
              {repo.deploymentUrl ? (
                <a
                  className="action-link"
                  href={repo.deploymentUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {repo.deploymentLabel || 'Deployment site'}
                </a>
              ) : null}
            </div>
          </div>
        </RepoSection>
      </div>
    </article>
  );
}

function RepoSection({ title, children }: { title: string; children: JSX.Element | JSX.Element[] }) {
  return (
    <div className="repo-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function PrdCard({ prd, label }: { prd: PrdSummary; label: string }) {
  const headline = prd.title || prd.id || 'Untitled PRD';
  const meta = [prd.stateLabel, prd.detail].filter(Boolean).join(' | ');

  return (
    <div className="queued-prd">
      <div className="item-head">
        <div>
          <div className="pill">{label}</div>
          <div className="queue-title">{headline}</div>
        </div>
        {prd.updatedAt ? <span className="pill">{formatTimestamp(prd.updatedAt)}</span> : null}
      </div>
      {meta ? <div className="queue-detail">{meta}</div> : null}
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentSummary }) {
  const details = [agent.workerStatus, agent.detail].filter(Boolean).join(' | ');

  return (
    <div className="agent">
      <div className="agent-head">
        <div>
          <div className="pill">{agent.role || agent.agentId || 'Agent'}</div>
          <div className="agent-title">{agent.agentId || 'unknown agent'}</div>
        </div>
        <span className="pill">{agent.pid ? `pid ${agent.pid}` : 'pid -'}</span>
      </div>
      {details ? <div className="agent-detail">{details}</div> : null}
    </div>
  );
}

function PullRequestCard({ pullRequest }: { pullRequest: PullRequestSummary }) {
  const details = [pullRequest.statusLabel || pullRequest.status, pullRequest.action, pullRequest.branch ? `branch ${pullRequest.branch}` : '']
    .filter(Boolean)
    .join(' | ');
  const title = pullRequest.title || pullRequest.prId || 'Untitled PR';

  return (
    <div className="pull-request">
      <div className="item-head">
        <div>
          <div className="pill">Active PR</div>
          {pullRequest.url ? (
            <a
              className="pull-request-title pull-request-link"
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
            >
              {title}
            </a>
          ) : (
            <div className="pull-request-title">{title}</div>
          )}
        </div>
        {pullRequest.updatedAt ? <span className="pill">{formatTimestamp(pullRequest.updatedAt)}</span> : null}
      </div>
      {details ? <div className="pull-request-detail">{details}</div> : null}
    </div>
  );
}

function JobStack({ jobs }: { jobs: JobSummary[] }) {
  if (!jobs.length) {
    return <div className="muted">No bridge jobs queued yet.</div>;
  }

  return (
    <>
      {jobs.map((job) => <JobCard job={job} />)}
    </>
  );
}

function JobCard({ job }: { job: JobSummary }) {
  const details = [job.repoLabel, job.detail].filter(Boolean).join(' | ');

  return (
    <div className="job">
      <div className="job-head">
        <div>
          <div className="pill">{job.statusLabel || job.status || 'queued'}</div>
          <h3 style={{ marginTop: '8px' }}>{job.title || job.id || 'Untitled job'}</h3>
        </div>
        {job.updatedAt ? <span className="pill">{formatTimestamp(job.updatedAt)}</span> : null}
      </div>
      <div className="job-detail">{job.repoId || ''}{details ? ` | ${details}` : ''}</div>
    </div>
  );
}

function formatTimestamp(value: string | null | undefined) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) {
    return String(value || 'unknown time');
  }

  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error || 'Unexpected error');
}

function readEntranceContext(): EntranceContext {
  const body = document.body;
  const entrance = String(body?.dataset.controlPlaneEntrance || 'manager').trim() === 'project'
    ? 'project'
    : 'manager';
  return {
    entrance,
    repoId: String(body?.dataset.controlPlaneRepoId || '').trim(),
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  mountControlPlane();
}

export {
  mountControlPlane,
};
