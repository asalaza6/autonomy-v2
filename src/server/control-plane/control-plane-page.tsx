import { h } from './control-plane-jsx-runtime/jsx-runtime.js';

const styles = `
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

  *, *::before, *::after { box-sizing: border-box; }
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

  h1, h2, h3, h4, p { margin: 0; }
  h1 { font-size: clamp(2rem, 4vw, 3rem); letter-spacing: -0.04em; line-height: 1; }
  h2 { font-size: 1.1rem; }
  h3 { font-size: 1rem; }
  h4 { font-size: 0.95rem; }

  .muted { color: var(--muted); }

  .masthead {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: 16px;
    flex-wrap: wrap;
  }

  .eyebrow {
    margin-bottom: 8px;
    color: var(--accent);
    font-size: 0.8rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.15em;
  }

  .lede { margin-top: 10px; max-width: 720px; line-height: 1.5; }

  .status-chip {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: rgba(255, 255, 255, 0.72);
    box-shadow: var(--shadow);
    white-space: nowrap;
  }

  .status-stack {
    display: grid;
    gap: 10px;
  }

  .heartbeat-strip {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: start;
    justify-content: flex-end;
  }

  .status-chip.online .status-dot {
    background: linear-gradient(135deg, #1f7a4f, #4fb37d);
    box-shadow: 0 0 0 5px rgba(31, 122, 79, 0.08);
  }

  .status-chip.stale .status-dot {
    background: linear-gradient(135deg, #b36a18, #e2a34c);
    box-shadow: 0 0 0 5px rgba(179, 106, 24, 0.1);
  }

  .status-chip.offline .status-dot {
    background: linear-gradient(135deg, #8d3a43, #c86b74);
    box-shadow: 0 0 0 5px rgba(141, 58, 67, 0.1);
  }

  .status-chip.aligned .status-dot {
    background: linear-gradient(135deg, #1f7a4f, #4fb37d);
    box-shadow: 0 0 0 5px rgba(31, 122, 79, 0.08);
  }

  .status-chip.pending .status-dot {
    background: linear-gradient(135deg, #b36a18, #e2a34c);
    box-shadow: 0 0 0 5px rgba(179, 106, 24, 0.1);
  }

  .status-chip.diverged .status-dot,
  .status-chip.invalid .status-dot {
    background: linear-gradient(135deg, #8d3a43, #c86b74);
    box-shadow: 0 0 0 5px rgba(141, 58, 67, 0.1);
  }

  .status-chip.unknown .status-dot {
    background: linear-gradient(135deg, #6f657c, #968ba5);
    box-shadow: 0 0 0 5px rgba(111, 101, 124, 0.1);
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: linear-gradient(135deg, var(--accent), #3b839d);
    box-shadow: 0 0 0 5px rgba(36, 91, 117, 0.08);
  }

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

  .tabs-panel { display: none; animation: panel-in 180ms ease-out; }
  .tabs-panel.active { display: block; }

  @keyframes panel-in {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
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
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
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

  .list-note { color: var(--muted); font-size: 0.92rem; }

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

  .queue-title, .agent-title, .pull-request-title { font-weight: 650; }
  .queue-detail, .agent-detail, .pull-request-detail, .job-detail { color: var(--muted); line-height: 1.45; }

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

  .section-divider {
    height: 1px;
    margin: 18px 0;
    background: rgba(31, 26, 21, 0.08);
  }

  .body-note { margin-top: 12px; }
  .repo-section { display: grid; gap: 10px; }
  .repo-section + .repo-section { margin-top: 12px; }
  .repo-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
  }
  .action-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 10px 14px;
    border-radius: 12px;
    border: 1px solid rgba(36, 91, 117, 0.24);
    color: var(--accent);
    background: rgba(255, 255, 255, 0.82);
    text-decoration: none;
    font-weight: 650;
  }
  .action-link:hover { transform: translateY(-1px); }

  @media (max-width: 980px) {
    .metric-grid, .raw-grid, .grid { grid-template-columns: 1fr; }
  }
`;

function ControlPlanePage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>Autonomy v2 Control Plane</title>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body className="control-plane-shell">
        <main>
          <header className="masthead">
            <div>
              <div className="eyebrow">Autonomy v2</div>
              <h1>Control Plane</h1>
              <p className="lede muted">Human-readable PRD status, agent state, and queue tracking. Raw JSON lives in Advanced.</p>
            </div>
            <div className="heartbeat-strip">
              <div id="control-plane-heartbeats" className="heartbeat-strip" aria-live="polite" />
              <div className="status-chip muted">
                <span className="status-dot" />
                <span id="last-updated">Loading...</span>
              </div>
            </div>
          </header>

          <nav className="tabs" role="tablist" aria-label="Control plane views">
            <button type="button" className="tab-button active" data-tab="dashboard" role="tab" aria-selected="true">Dashboard</button>
            <button type="button" className="tab-button" data-tab="submit" role="tab" aria-selected="false">Submit PRD</button>
            <button type="button" className="tab-button" data-tab="advanced" role="tab" aria-selected="false">Advanced</button>
          </nav>

          <section id="dashboard-panel" className="tabs-panel active" role="tabpanel">
            <article className="surface">
              <div className="surface-head">
                <div>
                  <h2>Status dashboard</h2>
                  <p className="muted">Active PRDs, queued PRDs, agent status, and the bridge queue in plain language.</p>
                </div>
                <div className="muted" id="dashboard-summary-note" />
              </div>
              <div id="dashboard-metrics" className="metric-grid" aria-live="polite" />
              <div id="dashboard-repos" className="repo-stack" />
              <div className="section-divider" />
              <div className="surface-head">
                <div>
                  <h3>Bridge queue</h3>
                  <p className="muted">Jobs waiting to be claimed, running, or completed by the local bridge.</p>
                </div>
              </div>
              <div id="dashboard-jobs" className="job-stack" />
            </article>
          </section>

          <section id="submit-panel" className="tabs-panel" role="tabpanel">
            <section className="grid">
              <article className="surface">
                <div className="surface-head">
                  <div>
                    <h2>New PRD</h2>
                    <p className="muted">Queue a PRD with plain-text fields. Advanced fields stay hidden unless you open them.</p>
                  </div>
                </div>
                <form id="prd-form">
                  <label>
                    Repo
                    <select id="repo-id" name="repoId" />
                  </label>
                  <div className="row">
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
                    <textarea id="prd-spec" name="specification" placeholder="Describe the product requirement here." />
                  </label>
                  <label>
                    Requirements, one per line
                    <textarea id="prd-req" name="requirements" placeholder="First requirement&#10;Second requirement" />
                  </label>
                  <div className="row">
                    <label>
                      Sprint ID
                      <input id="prd-sprint" name="sprintId" placeholder="optional" />
                    </label>
                  </div>
                  <details className="subtle-box">
                    <summary>Advanced PRD fields</summary>
                    <div className="muted body-note">Optional JSON payload used for task generation. Hidden by default.</div>
                    <label>
                      Task Specs JSON
                      <textarea id="prd-task-specs" name="taskSpecs" placeholder='[{"id":"...","title":"...","agentId":"..."}]' />
                    </label>
                  </details>
                  <div className="row body-note">
                    <button type="submit" className="primary">Queue PRD</button>
                    <button type="button" className="secondary" id="refresh-button">Refresh</button>
                  </div>
                  <div className="muted body-note" id="form-message" />
                </form>
              </article>

              <article className="surface">
                <div className="surface-head">
                  <div>
                    <h2>Submission notes</h2>
                    <p className="muted">The bridge still executes the same <code>prd:add</code> payload. This view only changes presentation.</p>
                  </div>
                </div>
                <div className="subtle-box">
                  <h3 style={{ marginBottom: '8px' }}>What stays the same</h3>
                  <div className="list-note">• repo allowlist and job payload validation</div>
                  <div className="list-note">• bridge claim / complete behavior</div>
                  <div className="list-note">• PRD commit semantics inside the local repo</div>
                </div>
              </article>
            </section>
          </section>

          <section id="advanced-panel" className="tabs-panel" role="tabpanel">
            <article className="surface">
              <div className="surface-head">
                <div>
                  <h2>Advanced</h2>
                  <p className="muted">Debug and raw state view for queue records, repo snapshots, and the rendered dashboard model.</p>
                </div>
              </div>
              <div className="raw-grid">
                <div className="advanced-block">
                  <h3>State JSON</h3>
                  <pre id="raw-state" />
                </div>
                <div className="advanced-block">
                  <h3>Dashboard JSON</h3>
                  <pre id="raw-dashboard" />
                </div>
                <div className="advanced-block">
                  <h3>Jobs JSON</h3>
                  <pre id="raw-jobs" />
                </div>
                <div className="advanced-block">
                  <h3>Repo status JSON</h3>
                  <pre id="raw-repos" />
                </div>
              </div>
            </article>
          </section>
        </main>

        <script type="module" src="/control-plane-client.js" />
      </body>
    </html>
  );
}

export {
  ControlPlanePage,
  styles,
};
