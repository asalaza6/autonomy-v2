import { useState } from 'react';
import type { FrontendPageProps } from '../../src/frontend/index.js';
import { AgentsPage, ChatPage, OperationStatus, useOperation, useResource } from '../shared/components.js';
import MaintenancePage from '../maintenance/frontend.js';

type Spec = { id: string; title: string; priority?: string; archive?: { archivedAt?: string }; [key: string]: unknown };
const uiCss = `
  .autonomy-shell{min-height:100vh;background:#f5f7fb;color:#172033;font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  .autonomy-shell *{box-sizing:border-box}.autonomy-wrap{max-width:1080px;margin:0 auto;padding:32px 24px 64px}
  .autonomy-header{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:24px}.autonomy-kicker{margin:0 0 4px;color:#667085;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.autonomy-header h1{margin:0;font-size:30px;letter-spacing:-.03em}.autonomy-header p{margin:5px 0 0;color:#667085}
  .autonomy-nav{display:flex;gap:6px;flex-wrap:wrap;padding:5px;background:#e9edf5;border:1px solid #dbe2ee;border-radius:12px}.autonomy-nav button{border:0;border-radius:8px;background:transparent;color:#526078;padding:8px 13px;font-weight:700;cursor:pointer}.autonomy-nav button[aria-current="page"]{background:#fff;color:#1d4ed8;box-shadow:0 1px 4px #1720331c}
  .autonomy-card{background:#fff;border:1px solid #e1e7f0;border-radius:16px;padding:24px;box-shadow:0 8px 28px #1720330a}.autonomy-card h2{margin:0 0 6px;font-size:22px;letter-spacing:-.02em}.autonomy-subtitle{margin:0 0 20px;color:#667085}.autonomy-form{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:16px;background:#f8faff;border:1px solid #e5ebf5;border-radius:12px}.autonomy-form label:last-of-type{grid-column:1/-1}.autonomy-form label,.autonomy-field{display:grid;gap:6px;color:#526078;font-size:13px;font-weight:700}.autonomy-form input,.autonomy-form textarea,.autonomy-card select,.autonomy-card textarea{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:9px 10px;background:#fff;color:#172033;font:inherit}.autonomy-form textarea{min-height:84px;resize:vertical}.autonomy-button{border:0;border-radius:8px;background:#2563eb;color:#fff;padding:9px 14px;font-weight:700;cursor:pointer}.autonomy-button.secondary{background:#eef2ff;color:#3730a3}.autonomy-button.danger{background:#fff1f2;color:#be123c}.autonomy-button:disabled{cursor:wait;opacity:.55}
  .autonomy-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.autonomy-list{display:grid;gap:12px;padding:0;margin:20px 0 0;list-style:none}.autonomy-item{padding:16px;border:1px solid #e5eaf2;border-radius:12px}.autonomy-item h3{margin:0;font-size:16px}.autonomy-meta{margin:3px 0 12px;color:#667085;font-size:13px}.autonomy-status{margin-top:16px;color:#526078}.autonomy-status pre,.autonomy-pre{max-height:280px;overflow:auto;padding:12px;border-radius:10px;background:#111827;color:#d1fae5;font:12px/1.5 ui-monospace,SFMono-Regular,monospace}.autonomy-empty{padding:28px;text-align:center;color:#667085;border:1px dashed #cbd5e1;border-radius:12px}.autonomy-grid{display:grid;gap:16px}.autonomy-chat{min-height:300px}.autonomy-chat ol{display:grid;gap:10px;padding:0;list-style:none}.autonomy-chat li{max-width:80%;padding:10px 13px;border-radius:12px;background:#f1f5f9}.autonomy-chat li:nth-child(even){margin-left:auto;background:#e0e7ff}.autonomy-chat li p{margin:4px 0 0}.autonomy-stack{display:grid;gap:14px}.autonomy-agent{display:flex;align-items:center;justify-content:space-between;gap:14px}.autonomy-agent-name{font-weight:700}.autonomy-pill{display:inline-flex;padding:3px 8px;border-radius:999px;background:#dcfce7;color:#166534;font-size:12px;font-weight:700}.autonomy-pill.off{background:#f1f5f9;color:#667085}
  @media(max-width:680px){.autonomy-wrap{padding:20px 14px 40px}.autonomy-header{display:block}.autonomy-nav{margin-top:18px}.autonomy-form{grid-template-columns:1fr}.autonomy-form label:last-of-type{grid-column:auto}.autonomy-card{padding:18px}.autonomy-agent{align-items:flex-start;flex-direction:column}}
`;
async function queryPrds(runtime: FrontendPageProps['runtime']): Promise<Spec[]> {
  let operation = await runtime.runAction('prd:list', {});
  while (operation.status === 'running') {
    await new Promise(resolve => setTimeout(resolve, 100));
    const next = await runtime.getOperation(operation.id);
    if (!next) throw new Error('PRD query operation disappeared.');
    operation = next;
  }
  if (operation.status === 'failure') throw new Error(operation.error || 'Cannot load PRDs.');
  return operation.result as Spec[];
}
const pendingQueries = new WeakMap<FrontendPageProps['runtime'], Promise<Spec[]>>();
function readPrds(runtime: FrontendPageProps['runtime']) {
  let pending = pendingQueries.get(runtime);
  if (!pending) {
    pending = queryPrds(runtime).finally(() => pendingQueries.delete(runtime));
    pendingQueries.set(runtime, pending);
  }
  return pending;
}
const gitPaths = ['.git/refs/heads', '.git/packed-refs', '.git/HEAD'];
export function MainPage({ runtime, options = {} }: FrontendPageProps) {
  const directory = String(options.specsDir || 'prompts/autonomous/v2/specs/prds');
  const [id, setId] = useState(''), [title, setTitle] = useState(''), [specification, setSpecification] = useState('');
  const action = useOperation(runtime);
  const records = useResource(runtime, [directory, ...gitPaths], async () => (await readPrds(runtime)).filter(record => !record.archived), [directory]);
  return <section className="autonomy-card"><h2>Project work</h2><p className="autonomy-subtitle">Create and track product requirements for this repository.</p>{records.error && <p role="alert">{records.error}</p>}
    <form className="autonomy-form" onSubmit={event => { event.preventDefault(); void action.run('prd:add', { id, title, specification }); }}>
      <label>ID <input required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" value={id} onChange={e => setId(e.target.value)} /></label>
      <label>Title <input required value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Specification<textarea required value={specification} onChange={e => setSpecification(e.target.value)} /></label>
      <div><button className="autonomy-button" disabled={action.busy}>Add PRD</button></div>
    </form>
    {records.value?.length ? <ul className="autonomy-list">{records.value.map(record => <li className="autonomy-item" key={record.id}><h3>{record.title}</h3><p className="autonomy-meta">{record.id} · {record.queued ? 'Queued' : 'Active'}</p><div className="autonomy-actions">
      <label className="autonomy-field">Priority <select disabled={action.busy} value={record.priority || 'normal'} onChange={e => void action.run('prd:priority', { prdId: record.id, priority: e.target.value })}>{['highest', 'high', 'normal', 'low'].map(priority => <option key={priority}>{priority}</option>)}</select></label>
      <button className="autonomy-button danger" disabled={action.busy} onClick={() => void action.run('prd:reset', { prdId: record.id })}>Archive PRD</button></div>
    </li>)}</ul> : <p className="autonomy-empty">No active PRDs yet.</p>}<OperationStatus {...action} />
  </section>;
}
export function HistoryPage({ runtime, options = {} }: FrontendPageProps) {
  const directory = `${String(options.specsDir || 'prompts/autonomous/v2/specs/prds')}/archived`;
  const history = useResource(runtime, [directory, ...gitPaths], async () => (await readPrds(runtime)).filter(record => record.archived), [directory]);
  return <section className="autonomy-card"><h2>History</h2><p className="autonomy-subtitle">Archived requirements and their completion records.</p>{history.error && <p role="alert">{history.error}</p>}{history.value?.length ? <ul className="autonomy-list">{history.value.map(record => <li className="autonomy-item" key={record.id}><h3>{record.title}</h3><p className="autonomy-meta">{record.id} · {record.archive?.archivedAt || 'Archived'}</p><details><summary>View details</summary><pre className="autonomy-pre">{JSON.stringify(record, null, 2)}</pre></details></li>)}</ul> : <p className="autonomy-empty">No archived PRDs yet.</p>}</section>;
}
export function AdvancedPage(props: FrontendPageProps) {
  const action = useOperation(props.runtime);
  return <div className="autonomy-grid"><section className="autonomy-card"><h2>Advanced</h2><p className="autonomy-subtitle">Promote the integration branch using this repository’s configured deployment action.</p><button className="autonomy-button" disabled={action.busy} onClick={() => void action.run('deploy')}>Deploy</button><OperationStatus {...action} /></section><AgentsPage {...props} />{props.options?.maintenance === true && <MaintenancePage {...props} />}</div>;
}
export default function DevelopmentFrontend(props: FrontendPageProps) {
  const [page, setPage] = useState('Main');
  return <div className="autonomy-shell"><style>{uiCss}</style><main className="autonomy-wrap"><header className="autonomy-header"><div><p className="autonomy-kicker">Autonomy control panel</p><h1>{props.context.repository.name || props.context.repository.id}</h1><p>Manage project work and agent activity.</p></div><nav className="autonomy-nav" aria-label="Development pages">{['Main', 'Chat', 'Agents', 'History', 'Advanced'].map(name => <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}>{name}</button>)}</nav></header>{page === 'Main' ? <MainPage {...props} /> : page === 'Chat' ? <ChatPage {...props} /> : page === 'Agents' ? <AgentsPage {...props} /> : page === 'History' ? <HistoryPage {...props} /> : <AdvancedPage {...props} />}</main></div>;
}
