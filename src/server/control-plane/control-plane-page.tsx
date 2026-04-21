import { Fragment, h } from './control-plane-jsx-runtime/jsx-runtime.js';

interface ControlPlanePageProps {
  entrance: 'manager' | 'project';
  repoId?: string;
}

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
  .pull-request-link {
    color: var(--text);
    text-decoration: none;
    display: inline-block;
  }
  .pull-request-link:hover {
    color: var(--accent);
    text-decoration: underline;
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

  button.primary:disabled {
    cursor: default;
    opacity: 0.76;
  }

  button.deploy-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 168px;
  }

  .deploy-spinner {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    border-radius: 999px;
    border: 2px solid rgba(255, 255, 255, 0.45);
    border-top-color: white;
    animation: deploy-spin 0.8s linear infinite;
  }

  @keyframes deploy-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .deploy-spinner { animation: none; }
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

  .main-panel {
    display: grid;
    gap: 18px;
  }

  .main-stage {
    display: grid;
    gap: 18px;
    padding: 22px;
    border-radius: 26px;
    background:
      linear-gradient(135deg, rgba(36, 91, 117, 0.96), rgba(27, 52, 77, 0.92)),
      radial-gradient(circle at top right, rgba(255, 255, 255, 0.14), transparent 32%);
    color: white;
    box-shadow: 0 22px 55px rgba(27, 52, 77, 0.28);
  }

  .main-stage .muted {
    color: rgba(255, 255, 255, 0.72);
  }

  .main-stage-actions {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
  }

  .main-stage-cta {
    display: grid;
    gap: 10px;
    max-width: 720px;
  }

  .main-stage-button {
    min-height: 58px;
    padding: 16px 20px;
    border-radius: 18px;
    border: none;
    background: linear-gradient(135deg, #fff2d6, #ffd18c);
    color: #352516;
    font-size: 1.05rem;
    font-weight: 750;
    box-shadow: 0 16px 32px rgba(16, 22, 31, 0.24);
    cursor: pointer;
  }

  .main-stage-button:hover {
    transform: translateY(-1px);
  }

  .main-stage-deploy {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
  }

  .main-stage-deploy .action-link {
    background: rgba(255, 255, 255, 0.12);
    border-color: rgba(255, 255, 255, 0.22);
    color: white;
  }

  .progress-shell {
    display: grid;
    gap: 12px;
  }

  .progress-head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: end;
    flex-wrap: wrap;
  }

  .progress-headline {
    display: grid;
    gap: 6px;
  }

  .progress-title {
    font-size: clamp(1.3rem, 3vw, 1.9rem);
    line-height: 1.05;
    letter-spacing: -0.04em;
  }

  .progress-track {
    position: relative;
    height: 16px;
    border-radius: 999px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.18);
    border: 1px solid rgba(255, 255, 255, 0.16);
  }

  .progress-fill {
    position: absolute;
    inset: 0 auto 0 0;
    width: 0%;
    border-radius: inherit;
    background: linear-gradient(90deg, #ffd889, #ff9d5c 55%, #ff6f61);
    box-shadow: inset 0 0 18px rgba(255, 255, 255, 0.24);
    transition: width 240ms ease;
  }

  .progress-steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .progress-step {
    min-height: 84px;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px;
    align-items: start;
    padding: 12px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.1);
  }

  .progress-step.done {
    background: rgba(255, 255, 255, 0.18);
  }

  .progress-step.active {
    background: rgba(255, 216, 137, 0.24);
    border-color: rgba(255, 216, 137, 0.45);
  }

  .progress-step-marker {
    width: 12px;
    height: 12px;
    margin-top: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.36);
  }

  .progress-step.done .progress-step-marker {
    background: #9ee2bd;
  }

  .progress-step.active .progress-step-marker {
    background: #ffd889;
    box-shadow: 0 0 0 5px rgba(255, 216, 137, 0.16);
  }

  .progress-step-copy {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .progress-step-copy strong {
    line-height: 1.1;
  }

  .progress-step-copy span {
    color: rgba(255, 255, 255, 0.72);
    font-size: 0.88rem;
    line-height: 1.35;
  }

  .progress-foot {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    color: rgba(255, 255, 255, 0.82);
    font-size: 0.95rem;
  }

  .modal-shell[hidden] {
    display: none;
  }

  .modal-shell {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(16, 22, 31, 0.38);
    backdrop-filter: blur(8px);
  }

  .modal-card {
    width: min(680px, 100%);
    display: grid;
    gap: 16px;
    padding: 22px;
    border-radius: 24px;
    background: rgba(255, 253, 248, 0.98);
    border: 1px solid rgba(31, 26, 21, 0.1);
    box-shadow: 0 28px 70px rgba(16, 22, 31, 0.24);
  }

  .modal-head {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: start;
  }

  .history-layout {
    display: grid;
    grid-template-columns: minmax(240px, 0.36fr) minmax(0, 1fr);
    gap: 14px;
  }

  .history-list-panel, .history-detail-panel {
    display: grid;
    gap: 10px;
    align-content: start;
  }

  .history-item {
    width: 100%;
    min-height: 74px;
    display: grid;
    gap: 5px;
    text-align: left;
    border-radius: 14px;
    border: 1px solid rgba(31, 26, 21, 0.1);
    background: rgba(255, 255, 255, 0.76);
    cursor: pointer;
  }

  .history-item.selected {
    border-color: rgba(36, 91, 117, 0.38);
    background: rgba(36, 91, 117, 0.1);
  }

  .history-item-title {
    font-weight: 700;
    line-height: 1.25;
  }

  .history-item-meta {
    color: var(--muted);
    font-size: 0.84rem;
  }

  .history-detail-card {
    display: grid;
    gap: 14px;
    border-radius: 16px;
    border: 1px solid rgba(31, 26, 21, 0.1);
    background: rgba(255, 255, 255, 0.76);
    padding: 14px;
  }

  .history-detail-title {
    margin-top: 8px;
    font-size: 1.15rem;
  }

  .history-block {
    display: grid;
    gap: 8px;
  }

  .history-block p {
    color: var(--muted);
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .history-list {
    margin: 0;
    padding-left: 20px;
    color: var(--muted);
    line-height: 1.45;
  }

  .history-task-stack {
    display: grid;
    gap: 10px;
  }

  .history-task {
    display: grid;
    gap: 6px;
    border-top: 1px solid rgba(31, 26, 21, 0.08);
    padding-top: 10px;
  }

  .history-task:first-child {
    border-top: none;
    padding-top: 0;
  }

  .chat-layout {
    display: grid;
    gap: 14px;
  }

  .chat-controls {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  .chat-controls select {
    min-width: min(100%, 280px);
  }

  .chat-thread {
    min-height: 360px;
    max-height: 560px;
    overflow: auto;
    display: grid;
    align-content: start;
    gap: 12px;
    padding: 14px;
    border-radius: 16px;
    border: 1px solid rgba(31, 26, 21, 0.1);
    background: rgba(255, 255, 255, 0.7);
  }

  .chat-message {
    width: min(760px, 92%);
    display: grid;
    gap: 6px;
    padding: 12px 14px;
    border-radius: 16px;
    border: 1px solid rgba(31, 26, 21, 0.08);
    background: rgba(255, 255, 255, 0.86);
  }

  .chat-message.manager {
    justify-self: end;
    background: rgba(36, 91, 117, 0.1);
    border-color: rgba(36, 91, 117, 0.18);
  }

  .chat-message.agent {
    justify-self: start;
  }

  .chat-message.failed {
    border-color: rgba(192, 74, 87, 0.35);
    background: rgba(192, 74, 87, 0.08);
  }

  .chat-message-head {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    color: var(--muted);
    font-size: 0.82rem;
    font-weight: 650;
  }

  .chat-message-body {
    white-space: pre-wrap;
    line-height: 1.5;
  }

  .chat-prd-proposal {
    display: grid;
    gap: 10px;
    margin-top: 4px;
    padding: 12px;
    border-radius: 14px;
    border: 1px solid rgba(36, 91, 117, 0.2);
    background: rgba(36, 91, 117, 0.08);
  }

  .chat-prd-proposal-title {
    font-weight: 750;
    line-height: 1.25;
  }

  .chat-prd-proposal-detail {
    color: var(--muted);
    line-height: 1.45;
    font-size: 0.92rem;
  }

  .chat-prd-draft-panel[hidden] {
    display: none;
  }

  .chat-prd-draft-panel {
    display: grid;
    gap: 10px;
    border-radius: 16px;
    border: 1px solid rgba(36, 91, 117, 0.2);
    background: rgba(36, 91, 117, 0.08);
    padding: 14px;
    margin-bottom: 14px;
  }

  .chat-form {
    display: grid;
    gap: 10px;
  }

  .chat-form textarea {
    min-height: 110px;
  }

  @media (max-width: 980px) {
    .metric-grid, .raw-grid, .grid, .history-layout, .progress-steps { grid-template-columns: 1fr; }
    .main-stage-actions, .progress-head, .progress-foot { align-items: start; }
  }
`;

function ControlPlanePage(props: ControlPlanePageProps) {
  const entrance = props.entrance;
  const repoId = String(props.repoId || '').trim();
  const isManager = entrance === 'manager';
  const shellTitle = isManager
    ? 'Manager Control Plane'
    : repoId
      ? `${repoId} Control Plane`
      : 'Repository Control Plane';
  const shellLede = isManager
    ? 'Browse discovered repos and inspect their current status from the shared hosted control plane.'
    : '';
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>Autonomy v2 Control Plane</title>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body
        className="control-plane-shell"
        data-control-plane-entrance={entrance}
        data-control-plane-repo-id={repoId}
      >
        <main>
          <header className="masthead">
            <div>
              <div className="eyebrow">Autonomy v2</div>
              <h1>{shellTitle}</h1>
              {shellLede ? <p className="lede muted">{shellLede}</p> : null}
            </div>
            <div className="heartbeat-strip">
              <div id="control-plane-heartbeats" className="heartbeat-strip" aria-live="polite" />
              <div className="status-chip muted">
                <span className="status-dot" />
                <span id="last-updated">Loading...</span>
              </div>
            </div>
          </header>

          {isManager ? null : (
            <nav className="tabs" role="tablist" aria-label="Control plane views">
              <button type="button" className="tab-button active" data-tab="main" role="tab" aria-selected="true">Main</button>
              <button type="button" className="tab-button" data-tab="chat" role="tab" aria-selected="false">Chat</button>
              <button type="button" className="tab-button" data-tab="history" role="tab" aria-selected="false">History</button>
              <button type="button" className="tab-button" data-tab="advanced" role="tab" aria-selected="false">Advanced</button>
            </nav>
          )}

          {isManager ? (
            <section id="dashboard-panel" className="tabs-panel active" role="tabpanel">
              <article className="surface">
                <div className="surface-head">
                  <div>
                    <h2>Status dashboard</h2>
                    <p className="muted">Available repos and their current status.</p>
                  </div>
                  <div className="muted" id="dashboard-summary-note" />
                </div>
                <div id="dashboard-repos" className="repo-stack" />
              </article>
            </section>
          ) : null}

          {isManager ? null : (
            <>
              <section id="main-panel" className="tabs-panel active" role="tabpanel">
                <div className="main-panel">
                  <article className="main-stage">
                    <div className="main-stage-actions">
                      <div className="main-stage-cta">
                        <button type="button" className="main-stage-button" id="open-prd-modal">
                          <span id="main-hero-action-label">{`Make a change to ${repoId || 'this repo'}`}</span>
                        </button>
                        <p className="muted">Start a new change request from one action, then watch task progress move forward here.</p>
                      </div>
                      <div id="main-deploy-actions" className="main-stage-deploy" />
                    </div>

                    <div className="progress-shell">
                      <div className="progress-head">
                        <div className="progress-headline">
                          <h2 id="main-progress-title" className="progress-title">Ready for a new run</h2>
                          <p id="main-progress-detail" className="muted">No active PRD is working through tasks right now.</p>
                        </div>
                        <div id="main-progress-stats">0 complete · 0 remaining</div>
                      </div>
                      <div className="progress-track" aria-hidden="true">
                        <div id="main-progress-fill" className="progress-fill" />
                      </div>
                      <div id="main-progress-steps" className="progress-steps" aria-live="polite" />
                      <div className="progress-foot">
                        <span>Progress moves as planned tasks complete.</span>
                        <span>Finished PRDs move into History.</span>
                      </div>
                    </div>
                  </article>
                </div>
              </section>

              <section id="chat-panel" className="tabs-panel" role="tabpanel">
                <article className="surface">
                  <div className="surface-head">
                    <div>
                      <h2>Repo Chat</h2>
                      <p className="muted">Ask the repo agent about current status, active PRDs, queued work, and repository context.</p>
                    </div>
                    <div className="chat-controls">
                      <select id="chat-conversation-select" aria-label="Conversation" />
                      <button type="button" className="secondary" id="new-chat-button">New conversation</button>
                    </div>
                  </div>
                  <div className="chat-layout">
                    <div id="chat-thread" className="chat-thread" aria-live="polite" />
                    <form id="chat-form" className="chat-form">
                      <label>
                        Message
                        <textarea id="chat-input" name="message" placeholder="Ask about this repo." />
                      </label>
                      <div className="row">
                        <button type="submit" className="primary">Send to repo agent</button>
                        <button type="button" className="secondary" id="chat-refresh-button">Refresh</button>
                      </div>
                      <div className="muted body-note" id="chat-message" />
                    </form>
                  </div>
                </article>
              </section>

              <section id="history-panel" className="tabs-panel" role="tabpanel">
                <article className="surface">
                  <div className="surface-head">
                    <div>
                      <h2>PRD History</h2>
                      <p className="muted">Finished PRDs appear here with their full specification, requirements, tasks, and raw record.</p>
                    </div>
                    <div className="muted" id="prd-history-summary">History populates after a PRD finishes.</div>
                  </div>
                  <div className="history-layout">
                    <div id="prd-history-list" className="history-list-panel" />
                    <div id="prd-history-detail" className="history-detail-panel" />
                  </div>
                </article>
              </section>

              <section id="advanced-panel" className="tabs-panel" role="tabpanel">
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

                <section className="grid">
                  <article className="surface">
                    <div className="surface-head">
                      <div>
                        <h2>New PRD</h2>
                        <p className="muted">Write or review PRD content. The system generates the PRD id automatically.</p>
                      </div>
                    </div>
                    <form id="prd-form">
                      <div id="chat-prd-draft-panel" className="chat-prd-draft-panel" hidden>
                        <div>
                          <div className="pill">Chat PRD draft</div>
                          <h3 id="chat-prd-draft-title" style={{ marginTop: '8px' }}>Review and submit</h3>
                          <div id="chat-prd-draft-meta" className="chat-prd-proposal-detail" />
                        </div>
                        <div className="row body-note">
                          <button type="button" className="secondary" id="discard-chat-prd-draft">Discard draft</button>
                        </div>
                      </div>
                      {isManager ? (
                        <label id="repo-select-field">
                          Repo
                          <select id="repo-id" name="repoId" />
                        </label>
                      ) : (
                        <div className="subtle-box">
                          <h3 style={{ marginBottom: '8px' }}>Target repo</h3>
                          <div className="muted body-note" id="fixed-repo-id">{repoId || 'Unknown repo'}</div>
                        </div>
                      )}
                      <label>
                        Title
                        <input id="prd-title" name="title" placeholder="Generated from the PRD content if left blank" />
                      </label>
                      <label>
                        Specification
                        <textarea id="prd-spec" name="specification" placeholder="Describe the product requirement here." />
                      </label>
                      <details className="subtle-box">
                        <summary>Advanced PRD fields</summary>
                        <div className="muted body-note">Optional fields for requirements, sprint routing, and task generation. PRD id and title are autogenerated on submit.</div>
                        <label>
                          Requirements, one per line
                          <textarea id="prd-req" name="requirements" placeholder="First requirement&#10;Second requirement" />
                        </label>
                        <label>
                          Sprint ID
                          <input id="prd-sprint" name="sprintId" placeholder="optional" />
                        </label>
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
                      <div className="list-note">• repo-local PRD payload validation</div>
                      <div className="list-note">• bridge claim / complete execution flow</div>
                      <div className="list-note">• PRD commit semantics inside the local repo</div>
                    </div>
                  </article>
                </section>

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
            </>
          )}
        </main>

        {isManager ? null : (
          <div id="prd-modal" className="modal-shell" hidden>
            <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="quick-prd-title">
              <div className="modal-head">
                <div>
                  <div className="eyebrow">New change</div>
                  <h2 id="quick-prd-title">{`Make a change to ${repoId || 'this repo'}`}</h2>
                  <p className="lede muted">Add the specification only. The PRD title and id are generated on submit.</p>
                </div>
                <button type="button" className="secondary" id="close-prd-modal">Close</button>
              </div>
              <form id="quick-prd-form">
                <label>
                  Specification
                  <textarea id="quick-prd-spec" name="specification" placeholder="Describe the change you want to make." />
                </label>
                <div className="row body-note">
                  <button type="submit" className="primary">Queue PRD</button>
                </div>
                <div className="muted body-note" id="quick-form-message" />
              </form>
            </div>
          </div>
        )}

        <script type="module" src="/control-plane-client.js" />
      </body>
    </html>
  );
}

function ControlPlaneMissingEntrancePage() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>Autonomy v2 Control Plane</title>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
      </head>
      <body>
        <main>
          <article className="surface">
            <div className="eyebrow">Autonomy v2</div>
            <h1>404</h1>
            <p className="lede muted">Page not found.</p>
          </article>
        </main>
      </body>
    </html>
  );
}

export {
  ControlPlaneMissingEntrancePage,
  ControlPlanePage,
  styles,
};
