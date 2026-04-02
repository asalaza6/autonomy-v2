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
    max-width: 1360px;
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

  .lede { margin-top: 10px; max-width: 760px; line-height: 1.5; }

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

  .manager-grid {
    display: grid;
    gap: 18px;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr);
  }

  .site-stack {
    display: grid;
    gap: 12px;
  }

  .site-card, .site-detail, .advanced-block {
    border: 1px solid rgba(31, 26, 21, 0.1);
    border-radius: 18px;
    padding: 14px;
    background: rgba(255, 255, 255, 0.76);
  }

  .site-card {
    cursor: pointer;
    transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
  }

  .site-card:hover {
    transform: translateY(-1px);
    box-shadow: 0 14px 30px rgba(31, 26, 21, 0.08);
  }

  .site-card.selected {
    border-color: rgba(36, 91, 117, 0.32);
    box-shadow: 0 16px 36px rgba(36, 91, 117, 0.14);
  }

  .site-head, .item-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: start;
    flex-wrap: wrap;
    margin-bottom: 10px;
  }

  .site-title {
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .site-detail {
    display: grid;
    gap: 12px;
    align-content: start;
  }

  .site-badges, .row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
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
    line-height: 1.45;
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

  button {
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    filter: brightness(0.985);
  }

  button:active:not(:disabled) {
    transform: translateY(1px);
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

  .section-divider {
    height: 1px;
    margin: 18px 0;
    background: rgba(31, 26, 21, 0.08);
  }

  .body-note { margin-top: 12px; }

  .raw-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
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

  details summary {
    cursor: pointer;
    font-weight: 650;
    color: var(--accent);
    margin-bottom: 10px;
  }

  .subtle-box {
    border-radius: 16px;
    border: 1px dashed rgba(31, 26, 21, 0.14);
    background: rgba(255, 255, 255, 0.5);
    padding: 14px;
  }

  @media (max-width: 1080px) {
    .metric-grid, .raw-grid, .manager-grid { grid-template-columns: 1fr; }
  }
`;

function ControlPlanePage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>Autonomy v2 Manager</title>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body className="control-plane-shell">
        <main>
          <header className="masthead">
            <div>
              <div className="eyebrow">Autonomy v2</div>
              <h1>Manager</h1>
              <p className="lede muted">
                One local server manages all site processes, routes traffic, and publishes sites to Heroku when requested.
              </p>
            </div>
            <div className="status-chip muted">
              <span className="status-dot" />
              <span id="last-updated">Loading...</span>
            </div>
          </header>

          <nav className="tabs" role="tablist" aria-label="Manager views">
            <button type="button" className="tab-button active" data-tab="overview" role="tab" aria-selected="true">Sites</button>
            <button type="button" className="tab-button" data-tab="create" role="tab" aria-selected="false">Create site</button>
            <button type="button" className="tab-button" data-tab="advanced" role="tab" aria-selected="false">Advanced</button>
          </nav>

          <section id="overview-panel" className="tabs-panel active" role="tabpanel">
            <article className="surface">
              <div className="surface-head">
                <div>
                  <h2>Local sites</h2>
                  <p className="muted">Running processes, deployment state, and proxy routes.</p>
                </div>
                <div className="muted" id="manager-summary-note" />
              </div>
              <div id="manager-metrics" className="metric-grid" aria-live="polite" />
              <div className="manager-grid">
                <div>
                  <div id="site-stack" className="site-stack" />
                </div>
                <aside id="site-detail" className="site-detail" aria-label="Selected site details" />
              </div>
            </article>
          </section>

          <section id="create-panel" className="tabs-panel" role="tabpanel">
            <section className="manager-grid">
              <article className="surface">
                <div className="surface-head">
                  <div>
                    <h2>Create site</h2>
                    <p className="muted">Scaffold a new website, start it locally, and optionally publish it to Heroku.</p>
                  </div>
                </div>
                <form id="site-form">
                  <div className="row">
                    <label>
                      Site name
                      <input id="site-name" name="name" placeholder="Acme storefront" />
                    </label>
                    <label>
                      Slug
                      <input id="site-slug" name="slug" placeholder="acme-storefront" />
                    </label>
                  </div>
                  <label>
                    Description
                    <textarea id="site-description" name="description" placeholder="A short description for the site dashboard and scaffolded homepage." />
                  </label>
                  <details className="subtle-box">
                    <summary>Homepage content</summary>
                    <label>
                      Headline
                      <input id="site-headline" name="headline" placeholder="Welcome to Acme" />
                    </label>
                    <label>
                      Body
                      <textarea id="site-body" name="body" placeholder="This site was created by the manager." />
                    </label>
                    <label>
                      Footer
                      <input id="site-footer" name="footer" placeholder="Managed by Autonomy v2" />
                    </label>
                  </details>
                  <div className="row body-note">
                    <label>
                      <span>Start immediately</span>
                      <input id="site-auto-start" name="autoStart" type="checkbox" defaultChecked />
                    </label>
                    <label>
                      <span>Publish to Heroku</span>
                      <input id="site-publish-heroku" name="publishToHeroku" type="checkbox" />
                    </label>
                  </div>
                  <div className="row body-note">
                    <button type="submit" className="primary">Create site</button>
                    <button type="button" className="secondary" id="refresh-button">Refresh</button>
                  </div>
                  <div className="muted body-note" id="form-message" />
                </form>
              </article>

              <article className="surface">
                <div className="surface-head">
                  <div>
                    <h2>How it works</h2>
                    <p className="muted">Each site is scaffolded into its own folder and launched as its own local Node process.</p>
                  </div>
                </div>
                <div className="subtle-box">
                  <div className="list-note">• one site record per process</div>
                  <div className="list-note">• one local port per site</div>
                  <div className="list-note">• one reverse-proxy front door on the manager</div>
                  <div className="list-note">• optional Heroku build + publish from the same site folder</div>
                </div>
              </article>
            </section>
          </section>

          <section id="advanced-panel" className="tabs-panel" role="tabpanel">
            <article className="surface">
              <div className="surface-head">
                <div>
                  <h2>Advanced</h2>
                  <p className="muted">Raw state for the manager, selected site details, and the latest site logs.</p>
                </div>
              </div>
              <div className="raw-grid">
                <div className="advanced-block">
                  <h3>Manager state</h3>
                  <pre id="raw-manager-state" />
                </div>
                <div className="advanced-block">
                  <h3>Sites</h3>
                  <pre id="raw-sites" />
                </div>
                <div className="advanced-block">
                  <h3>Selected site</h3>
                  <pre id="raw-selected-site" />
                </div>
                <div className="advanced-block">
                  <h3>Logs</h3>
                  <pre id="raw-logs" />
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
