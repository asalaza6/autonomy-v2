function buildControlPlaneHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Autonomy v2 Control Plane</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe7;
      --surface: rgba(255, 253, 248, 0.9);
      --surface-strong: #fffdf8;
      --text: #1f1a15;
      --muted: #6a6056;
      --accent: #245b75;
      --accent-2: #c04a57;
      --border: rgba(31, 26, 21, 0.12);
      --shadow: 0 18px 45px rgba(31, 26, 21, 0.08);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(196, 208, 255, 0.25), transparent 36%),
        radial-gradient(circle at top right, rgba(240, 210, 184, 0.34), transparent 32%),
        linear-gradient(180deg, #fbf8f3 0%, var(--bg) 100%);
      color: var(--text);
    }
    main {
      max-width: 1320px;
      margin: 0 auto;
      padding: 28px 20px 56px;
      display: grid;
      gap: 18px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 16px;
      flex-wrap: wrap;
    }
    h1, h2, h3, h4, p { margin: 0; }
    h1 {
      font-size: clamp(2rem, 4vw, 3rem);
      letter-spacing: -0.04em;
      line-height: 1;
    }
    h2 { font-size: 1.1rem; }
    h3 { font-size: 1rem; }
    h4 { font-size: 0.95rem; }
    .muted { color: var(--muted); }
    .tabs {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.55);
      backdrop-filter: blur(10px);
      width: fit-content;
    }
    .tab-button {
      border: none;
      background: transparent;
      color: var(--muted);
      padding: 10px 14px;
      border-radius: 999px;
      font-weight: 650;
      cursor: pointer;
      transition: background 180ms ease, color 180ms ease, transform 180ms ease;
    }
    .tab-button:hover { transform: translateY(-1px); }
    .tab-button.active {
      background: linear-gradient(135deg, var(--accent), #3b839d);
      color: white;
      box-shadow: 0 10px 24px rgba(36, 91, 117, 0.24);
    }
    .surface {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 18px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .surface-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .surface-head .muted {
      max-width: 760px;
      line-height: 1.45;
    }
    .metric-grid {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .metric {
      padding: 14px;
      border-radius: 16px;
      background: rgba(255, 255, 255, 0.7);
      border: 1px solid rgba(31, 26, 21, 0.08);
      display: grid;
      gap: 6px;
      min-height: 92px;
    }
    .metric span {
      color: var(--muted);
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .metric strong {
      font-size: 1.6rem;
      line-height: 1;
      letter-spacing: -0.03em;
    }
    .repo-stack, .job-stack, .agent-stack, .queue-stack, .pull-request-stack {
      display: grid;
      gap: 12px;
    }
    .repo, .job, .agent, .queued-prd, .pull-request, .advanced-block {
      border: 1px solid rgba(31, 26, 21, 0.1);
      border-radius: 18px;
      padding: 14px;
      background: rgba(255, 255, 255, 0.76);
    }
    .repo-head, .job-head, .agent-head, .item-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: start;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 0.78rem;
      background: rgba(36, 91, 117, 0.12);
      color: var(--accent);
      white-space: nowrap;
    }
    .pill.warn {
      background: rgba(192, 74, 87, 0.12);
      color: var(--accent-2);
    }
    .overview {
      font-size: 0.98rem;
      line-height: 1.5;
      margin-bottom: 12px;
    }
    .section-row {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }
    .list-note {
      color: var(--muted);
      font-size: 0.92rem;
    }
    .queue-item, .agent-item, .pull-request-item {
      display: grid;
      gap: 6px;
      padding: 10px 0;
      border-top: 1px solid rgba(31, 26, 21, 0.08);
    }
    .queue-item:first-child, .agent-item:first-child, .pull-request-item:first-child {
      border-top: none;
      padding-top: 0;
    }
    .queue-title, .agent-title, .pull-request-title {
      font-weight: 650;
    }
    .queue-detail, .agent-detail, .pull-request-detail, .job-detail {
      color: var(--muted);
      line-height: 1.45;
    }
    .tabs-panel {
      display: none;
      animation: panel-in 180ms ease-out;
    }
    .tabs-panel.active { display: block; }
    @keyframes panel-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .grid {
      display: grid;
      gap: 18px;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
    }
    label {
      display: grid;
      gap: 6px;
      margin-bottom: 12px;
      font-size: 0.95rem;
    }
    input, select, textarea, button {
      font: inherit;
      border-radius: 12px;
      border: 1px solid var(--border);
      padding: 10px 12px;
      background: white;
      color: var(--text);
    }
    textarea { min-height: 140px; resize: vertical; }
    button.primary {
      cursor: pointer;
      background: linear-gradient(135deg, var(--accent), #3a86a0);
      color: white;
      border: none;
      padding: 12px 16px;
      font-weight: 650;
    }
    button.secondary {
      background: white;
      color: var(--accent);
      border: 1px solid rgba(36, 91, 117, 0.3);
    }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .row > * { flex: 1 1 180px; }
    .subtle-box {
      border-radius: 16px;
      border: 1px dashed rgba(31, 26, 21, 0.14);
      background: rgba(255, 255, 255, 0.5);
      padding: 14px;
    }
    details summary {
      cursor: pointer;
      font-weight: 650;
      color: var(--accent);
      margin-bottom: 10px;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(31, 26, 21, 0.04);
      border-radius: 14px;
      padding: 12px;
      overflow: auto;
      margin: 0;
    }
    .raw-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .raw-grid .advanced-block:last-child {
      grid-column: 1 / -1;
    }
    @media (max-width: 980px) {
      .metric-grid, .raw-grid, .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Autonomy v2 Control Plane</h1>
        <p class="muted">Human-readable PRD status, agent state, and queue tracking. Raw JSON lives in Advanced.</p>
      </div>
      <div class="muted" id="last-updated">Loading...</div>
    </header>

    <nav class="tabs" role="tablist" aria-label="Control plane views">
      <button type="button" class="tab-button active" data-tab="dashboard" role="tab" aria-selected="true">Dashboard</button>
      <button type="button" class="tab-button" data-tab="submit" role="tab" aria-selected="false">Submit PRD</button>
      <button type="button" class="tab-button" data-tab="advanced" role="tab" aria-selected="false">Advanced</button>
    </nav>

    <section id="dashboard-panel" class="tabs-panel active" role="tabpanel">
      <article class="surface">
        <div class="surface-head">
          <div>
            <h2>Status dashboard</h2>
            <p class="muted">Active PRDs, queued PRDs, agent status, and the bridge queue in plain language.</p>
          </div>
          <div class="muted" id="dashboard-summary-note"></div>
        </div>
        <div id="dashboard-metrics" class="metric-grid"></div>
        <div id="dashboard-repos" class="repo-stack"></div>
        <div style="height: 16px"></div>
        <div class="surface-head">
          <div>
            <h3>Bridge queue</h3>
            <p class="muted">Jobs waiting to be claimed, running, or completed by the local bridge.</p>
          </div>
        </div>
        <div id="dashboard-jobs" class="job-stack"></div>
      </article>
    </section>

    <section id="submit-panel" class="tabs-panel" role="tabpanel">
      <section class="grid">
        <article class="surface">
          <div class="surface-head">
            <div>
              <h2>New PRD</h2>
              <p class="muted">Queue a PRD with plain-text fields. Advanced fields stay hidden unless you open them.</p>
            </div>
          </div>
          <form id="prd-form">
            <label>
              Repo
              <select id="repo-id" name="repoId"></select>
            </label>
            <div class="row">
              <label>
                PRD ID
                <input id="prd-id" name="id" placeholder="prd-123" />
              </label>
              <label>
                Title
                <input id="prd-title" name="title" placeholder="New capability" />
              </label>
            </div>
            <label>
              Specification
              <textarea id="prd-spec" name="specification" placeholder="Describe the product requirement here."></textarea>
            </label>
            <label>
              Requirements, one per line
              <textarea id="prd-req" name="requirements" placeholder="First requirement&#10;Second requirement"></textarea>
            </label>
            <div class="row">
              <label>
                Sprint ID
                <input id="prd-sprint" name="sprintId" placeholder="optional" />
              </label>
            </div>
            <details class="subtle-box">
              <summary>Advanced PRD fields</summary>
              <div class="muted" style="margin-bottom: 12px;">Optional JSON payload used for task generation. Hidden by default.</div>
              <label>
                Task Specs JSON
                <textarea id="prd-task-specs" name="taskSpecs" placeholder='[{"id":"...","title":"...","agentId":"..."}]'></textarea>
              </label>
            </details>
            <div class="row" style="margin-top: 16px;">
              <button type="submit" class="primary">Queue PRD</button>
              <button type="button" class="secondary" id="refresh-button">Refresh</button>
            </div>
            <div class="muted" id="form-message" style="margin-top: 12px;"></div>
          </form>
        </article>

        <article class="surface">
          <div class="surface-head">
            <div>
              <h2>Submission notes</h2>
              <p class="muted">The bridge still executes the same <code>prd:add</code> payload. This view only changes presentation.</p>
            </div>
          </div>
          <div class="subtle-box">
            <h3 style="margin-bottom: 8px;">What stays the same</h3>
            <div class="list-note">• repo allowlist and job payload validation</div>
            <div class="list-note">• bridge claim / complete behavior</div>
            <div class="list-note">• PRD commit semantics inside the local repo</div>
          </div>
        </article>
      </section>
    </section>

    <section id="advanced-panel" class="tabs-panel" role="tabpanel">
      <article class="surface">
        <div class="surface-head">
          <div>
            <h2>Advanced</h2>
            <p class="muted">Debug and raw state view for queue records, repo snapshots, and the rendered dashboard model.</p>
          </div>
        </div>
        <div class="raw-grid">
          <div class="advanced-block">
            <h3>State JSON</h3>
            <pre id="raw-state"></pre>
          </div>
          <div class="advanced-block">
            <h3>Dashboard JSON</h3>
            <pre id="raw-dashboard"></pre>
          </div>
          <div class="advanced-block">
            <h3>Jobs JSON</h3>
            <pre id="raw-jobs"></pre>
          </div>
          <div class="advanced-block">
            <h3>Repo status JSON</h3>
            <pre id="raw-repos"></pre>
          </div>
        </div>
      </article>
    </section>
  </main>

  <script>
    const repoSelect = document.getElementById('repo-id');
    const lastUpdatedEl = document.getElementById('last-updated');
    const messageEl = document.getElementById('form-message');
    const form = document.getElementById('prd-form');
    const refreshButton = document.getElementById('refresh-button');
    const dashboardMetricsEl = document.getElementById('dashboard-metrics');
    const dashboardReposEl = document.getElementById('dashboard-repos');
    const dashboardJobsEl = document.getElementById('dashboard-jobs');
    const dashboardSummaryNoteEl = document.getElementById('dashboard-summary-note');
    const rawStateEl = document.getElementById('raw-state');
    const rawDashboardEl = document.getElementById('raw-dashboard');
    const rawJobsEl = document.getElementById('raw-jobs');
    const rawReposEl = document.getElementById('raw-repos');
    const tabs = Array.from(document.querySelectorAll('[data-tab]'));
    const panels = {
      dashboard: document.getElementById('dashboard-panel'),
      submit: document.getElementById('submit-panel'),
      advanced: document.getElementById('advanced-panel'),
    };

    let latestRepos = [];
    let latestState = null;

    async function requestJson(url, init) {
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
      return response.json();
    }

    function renderRepos(repos) {
      latestRepos = Array.isArray(repos) ? repos.slice() : [];
      const previous = repoSelect.value;
      repoSelect.innerHTML = latestRepos.map((repo) => {
        const label = repo.description ? repo.label + ' - ' + repo.description : repo.label;
        return '<option value="' + escapeHtml(repo.id) + '"' + (repo.default ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
      }).join('');
      if (previous && latestRepos.some((repo) => repo.id === previous)) {
        repoSelect.value = previous;
      } else if (!repoSelect.value && latestRepos.length > 0) {
        repoSelect.value = latestRepos[0].id;
      }
      repoSelect.disabled = latestRepos.length === 0;
    }

    function renderDashboard(dashboard) {
      const metrics = [
        ['Repos', dashboard.repoCount || 0],
        ['Active PRDs', dashboard.activePrdCount || 0],
        ['Queued PRDs', dashboard.queuedPrdCount || 0],
        ['Bridge jobs', dashboard.pendingJobCount || 0],
        ['Agents running', dashboard.runningAgentCount || 0],
        ['Active PRs', dashboard.activePullRequestCount || 0],
      ];
      dashboardMetricsEl.innerHTML = metrics.map((metric) => {
        return '<div class="metric"><span>' + escapeHtml(metric[0]) + '</span><strong>' + escapeHtml(String(metric[1])) + '</strong></div>';
      }).join('');
      dashboardSummaryNoteEl.textContent = dashboard.repoCount > 0
        ? dashboard.repoCount + ' repo' + (dashboard.repoCount === 1 ? '' : 's') + ' online'
        : 'No repo snapshots yet';
      dashboardReposEl.innerHTML = (dashboard.repos || []).map(renderRepo).join('');
      dashboardJobsEl.innerHTML = (dashboard.jobs || []).length > 0
        ? (dashboard.jobs || []).map(renderJob).join('')
        : '<div class="muted">No bridge jobs queued yet.</div>';
    }

    function renderRepo(repo) {
      const activePrd = repo.activePrd ? renderPrd(repo.activePrd, 'Active PRD') : '<div class="list-note">No active PRD yet.</div>';
      const queuedPrds = (repo.queuedPrds || []).length > 0
        ? (repo.queuedPrds || []).map((prd) => renderPrd(prd, 'Queued PRD')).join('')
        : '<div class="list-note">No queued PRDs.</div>';
      const agentStatuses = (repo.agentStatuses || []).length > 0
        ? (repo.agentStatuses || []).map(renderAgent).join('')
        : '<div class="list-note">No agent status yet.</div>';
      const pullRequests = (repo.pullRequestStatuses || []).length > 0
        ? (repo.pullRequestStatuses || []).map(renderPullRequest).join('')
        : '<div class="list-note">No active PRs.</div>';
      const updated = repo.updatedAt ? 'Updated ' + formatTimestamp(repo.updatedAt) : 'No status snapshot yet';
      const defaultPill = repo.default ? '<span class="pill">Default repo</span>' : '';
      return [
        '<article class="repo">',
        '<div class="repo-head">',
        '<div>',
        '<h3>' + escapeHtml(repo.label || repo.repoId || 'Repository') + '</h3>',
        '<div class="muted">' + escapeHtml(repo.description || repo.repoId || '') + '</div>',
        '</div>',
        '<div class="row" style="justify-content:flex-end; flex: 0 0 auto;">' + defaultPill + '<span class="pill">' + escapeHtml(updated) + '</span></div>',
        '</div>',
        '<p class="overview">' + escapeHtml(repo.overview || 'No status snapshot yet') + '</p>',
        '<div class="section-row">',
        '<div>',
        '<h4>Active PRD</h4>',
        activePrd,
        '</div>',
        '<div>',
        '<h4>Queued PRDs</h4>',
        queuedPrds,
        '</div>',
        '<div>',
        '<h4>Agents</h4>',
        agentStatuses,
        '</div>',
        '<div>',
        '<h4>Active PRs</h4>',
        pullRequests,
        '</div>',
        '</div>',
        '</article>',
      ].join('');
    }

    function renderPrd(prd, label) {
      const headline = prd.title || prd.id || 'Untitled PRD';
      const meta = [prd.stateLabel, prd.detail].filter(Boolean).join(' | ');
      return [
        '<div class="queued-prd">',
        '<div class="item-head">',
        '<div>',
        '<div class="pill">' + escapeHtml(label) + '</div>',
        '<div class="queue-title">' + escapeHtml(headline) + '</div>',
        '</div>',
        prd.updatedAt ? '<span class="pill">' + escapeHtml(formatTimestamp(prd.updatedAt)) + '</span>' : '',
        '</div>',
        meta ? '<div class="queue-detail">' + escapeHtml(meta) + '</div>' : '',
        '</div>',
      ].join('');
    }

    function renderAgent(agent) {
      const details = [agent.workerStatus, agent.detail].filter(Boolean).join(' | ');
      return [
        '<div class="agent">',
        '<div class="agent-head">',
        '<div>',
        '<div class="pill">' + escapeHtml(agent.role || agent.agentId || 'Agent') + '</div>',
        '<div class="agent-title">' + escapeHtml(agent.agentId || 'unknown agent') + '</div>',
        '</div>',
        agent.pid ? '<span class="pill">' + escapeHtml('pid ' + agent.pid) + '</span>' : '<span class="pill">pid -</span>',
        '</div>',
        details ? '<div class="agent-detail">' + escapeHtml(details) + '</div>' : '',
        '</div>',
      ].join('');
    }

    function renderPullRequest(pr) {
      const details = [pr.statusLabel || pr.status, pr.action, pr.branch ? 'branch ' + pr.branch : ''].filter(Boolean).join(' | ');
      return [
        '<div class="pull-request">',
        '<div class="item-head">',
        '<div>',
        '<div class="pill">Active PR</div>',
        '<div class="pull-request-title">' + escapeHtml(pr.title || pr.prId || 'Untitled PR') + '</div>',
        '</div>',
        pr.updatedAt ? '<span class="pill">' + escapeHtml(formatTimestamp(pr.updatedAt)) + '</span>' : '',
        '</div>',
        details ? '<div class="pull-request-detail">' + escapeHtml(details) + '</div>' : '',
        '</div>',
      ].join('');
    }

    function renderJob(job) {
      const details = [job.repoLabel, job.detail].filter(Boolean).join(' | ');
      return [
        '<div class="job">',
        '<div class="job-head">',
        '<div>',
        '<div class="pill">' + escapeHtml(job.statusLabel || job.status || 'queued') + '</div>',
        '<h3 style="margin-top:8px;">' + escapeHtml(job.title || job.id || 'Untitled job') + '</h3>',
        '</div>',
        job.updatedAt ? '<span class="pill">' + escapeHtml(formatTimestamp(job.updatedAt)) + '</span>' : '',
        '</div>',
        '<div class="job-detail">' + escapeHtml(job.repoId || '') + (details ? ' | ' + escapeHtml(details) : '') + '</div>',
        '</div>',
      ].join('');
    }

    function renderAdvanced(state) {
      rawStateEl.textContent = JSON.stringify(state, null, 2);
      rawDashboardEl.textContent = JSON.stringify((state && state.dashboard) || {}, null, 2);
      rawJobsEl.textContent = JSON.stringify((state && state.jobs) || [], null, 2);
      rawReposEl.textContent = JSON.stringify(
        latestRepos.map((repo) => {
          return {
            id: repo.id,
            label: repo.label,
            description: repo.description || '',
            default: Boolean(repo.default),
          };
        }),
        null,
        2
      );
    }

    function setActiveTab(tabName) {
      tabs.forEach((tab) => {
        const isActive = tab.dataset.tab === tabName;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      Object.entries(panels).forEach(([name, panel]) => {
        panel.classList.toggle('active', name === tabName);
      });
    }

    async function refresh() {
      const [repos, state] = await Promise.all([
        requestJson('/api/repos'),
        requestJson('/api/state'),
      ]);
      latestState = state;
      renderRepos(repos.repos || []);
      renderDashboard((state && state.dashboard) || {});
      renderAdvanced(state);
      lastUpdatedEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      messageEl.textContent = 'Queueing...';
      const taskSpecsRaw = document.getElementById('prd-task-specs').value.trim();
      let taskSpecs = [];
      if (taskSpecsRaw) {
        taskSpecs = JSON.parse(taskSpecsRaw);
      }
      const body = {
        repoId: repoSelect.value,
        id: document.getElementById('prd-id').value.trim(),
        title: document.getElementById('prd-title').value.trim(),
        specification: document.getElementById('prd-spec').value.trim(),
        requirements: document.getElementById('prd-req').value
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
        sprintId: document.getElementById('prd-sprint').value.trim(),
        taskSpecs,
      };
      try {
        await requestJson('/api/jobs', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        form.reset();
        await refresh();
        messageEl.textContent = 'Queued.';
      } catch (error) {
        messageEl.textContent = error.message;
      }
    });

    refreshButton.addEventListener('click', () => refresh().catch((error) => {
      messageEl.textContent = error.message;
    }));

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => setActiveTab(tab.dataset.tab));
    });

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatTimestamp(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return String(value || 'unknown time');
      }
      return date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    }

    refresh().catch((error) => {
      messageEl.textContent = error.message;
    });
    setInterval(() => refresh().catch(() => {}), 5000);
  </script>
</body>
</html>`;
}

export { buildControlPlaneHtml };
