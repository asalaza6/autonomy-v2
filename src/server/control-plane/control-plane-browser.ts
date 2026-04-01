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
      --bg: #f7f4ee;
      --panel: #fffdf8;
      --text: #1f1b16;
      --muted: #6d6258;
      --accent: #22577a;
      --accent-2: #d1495b;
      --border: rgba(31, 27, 22, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: radial-gradient(circle at top, #fff7e8, var(--bg) 55%);
      color: var(--text);
    }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 20px 64px;
      display: grid;
      gap: 20px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: 16px;
      flex-wrap: wrap;
    }
    h1, h2, h3 { margin: 0; }
    .muted { color: var(--muted); }
    .grid {
      display: grid;
      gap: 20px;
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 10px 30px rgba(31, 27, 22, 0.06);
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
    button {
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
      border: 1px solid rgba(34, 87, 122, 0.3);
    }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .row > * { flex: 1 1 180px; }
    .jobs, .statuses { display: grid; gap: 12px; }
    .job, .status-card {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 12px;
      background: rgba(255,255,255,0.72);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 3px 10px;
      font-size: 0.8rem;
      background: rgba(34, 87, 122, 0.12);
      color: var(--accent);
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: rgba(31, 27, 22, 0.04);
      border-radius: 12px;
      padding: 12px;
      overflow: auto;
    }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Autonomy v2 Control Plane</h1>
        <div class="muted">Queue PRDs in the browser, execute them on the local machine, and relay status back.</div>
      </div>
      <div class="muted" id="last-updated">Loading...</div>
    </header>

    <section class="grid">
      <article class="panel">
        <h2>New PRD</h2>
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
            <label>
              Task Specs JSON
              <textarea id="prd-task-specs" name="taskSpecs" placeholder='[{"id":"...","title":"...","agentId":"..."}]'></textarea>
            </label>
          </div>
          <div class="row">
            <button type="submit">Queue PRD</button>
            <button type="button" class="secondary" id="refresh-button">Refresh</button>
          </div>
          <div class="muted" id="form-message"></div>
        </form>
      </article>

      <article class="panel">
        <h2>Repos</h2>
        <div id="repo-statuses" class="statuses"></div>
      </article>
    </section>

    <section class="panel">
      <h2>Jobs</h2>
      <div id="jobs" class="jobs"></div>
    </section>
  </main>

  <script>
    const repoSelect = document.getElementById('repo-id');
    const jobsEl = document.getElementById('jobs');
    const repoStatusesEl = document.getElementById('repo-statuses');
    const lastUpdatedEl = document.getElementById('last-updated');
    const messageEl = document.getElementById('form-message');
    const form = document.getElementById('prd-form');
    const refreshButton = document.getElementById('refresh-button');

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
      repoSelect.innerHTML = repos.map((repo) => {
        const label = repo.description ? \`\${repo.label} - \${repo.description}\` : repo.label;
        return \`<option value="\${escapeHtml(repo.id)}">\${escapeHtml(label)}</option>\`;
      }).join('');
    }

    function renderJobs(jobs) {
      if (!jobs.length) {
        jobsEl.innerHTML = '<div class="muted">No queued jobs yet.</div>';
        return;
      }
      jobsEl.innerHTML = jobs.map((job) => \`
        <div class="job">
          <div class="row" style="align-items:center">
            <strong>\${escapeHtml(job.payload.title)}</strong>
            <span class="pill">\${escapeHtml(job.status)}</span>
            <span class="muted">\${escapeHtml(job.repoId)}</span>
          </div>
          <div class="muted">\${escapeHtml(job.id)}</div>
          <pre>\${escapeHtml(JSON.stringify(job.payload, null, 2))}</pre>
        </div>
      \`).join('');
    }

    function renderStatuses(statuses) {
      const entries = Object.values(statuses || {});
      if (!entries.length) {
        repoStatusesEl.innerHTML = '<div class="muted">No status snapshots yet.</div>';
        return;
      }
      repoStatusesEl.innerHTML = entries.map((entry) => \`
        <div class="status-card">
          <div class="row" style="align-items:center">
            <strong>\${escapeHtml(entry.repoId)}</strong>
            <span class="pill">\${escapeHtml(entry.updatedAt)}</span>
          </div>
          <pre>\${escapeHtml(JSON.stringify(entry.snapshot, null, 2))}</pre>
        </div>
      \`).join('');
    }

    async function refresh() {
      const [repos, state] = await Promise.all([
        requestJson('/api/repos'),
        requestJson('/api/state'),
      ]);
      renderRepos(repos.repos || []);
      renderJobs((state.jobs || []).slice().reverse());
      renderStatuses(state.repoStatuses || {});
      lastUpdatedEl.textContent = \`Updated \${new Date().toLocaleTimeString()}\`;
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
          .split('\\n')
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

    function escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
