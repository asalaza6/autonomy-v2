import { useState } from 'react';
import type { FrontendPageProps } from '../../src/frontend/index.js';
import { AgentsPage, ChatPage, OperationStatus, useOperation, useResource } from '../shared/components.js';
import MaintenancePage from '../maintenance/frontend.js';

type Spec = { id: string; title: string; priority?: string; archive?: { archivedAt?: string }; [key: string]: unknown };
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
  return <section><h2>PRDs</h2>{records.error && <p role="alert">{records.error}</p>}
    <form onSubmit={event => { event.preventDefault(); void action.run('prd:add', { id, title, specification }); }}>
      <label>ID <input required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]*" value={id} onChange={e => setId(e.target.value)} /></label>{' '}
      <label>Title <input required value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label style={{ display: 'block' }}>Specification<textarea required value={specification} onChange={e => setSpecification(e.target.value)} /></label>
      <button disabled={action.busy}>Add PRD</button>
    </form>
    <ul>{records.value?.map(record => <li key={record.id}><h3>{record.title}</h3><p>{record.id} · {record.queued ? 'Queued' : 'Active'}</p>
      <label>Priority <select disabled={action.busy} value={record.priority || 'normal'} onChange={e => void action.run('prd:priority', { prdId: record.id, priority: e.target.value })}>{['highest', 'high', 'normal', 'low'].map(priority => <option key={priority}>{priority}</option>)}</select></label>{' '}
      <button disabled={action.busy} onClick={() => void action.run('prd:reset', { prdId: record.id })}>Archive and reset {record.id}</button>
    </li>)}</ul>{records.value?.length === 0 && <p>No PRDs yet.</p>}<OperationStatus {...action} />
  </section>;
}
export function HistoryPage({ runtime, options = {} }: FrontendPageProps) {
  const directory = `${String(options.specsDir || 'prompts/autonomous/v2/specs/prds')}/archived`;
  const history = useResource(runtime, [directory, ...gitPaths], async () => (await readPrds(runtime)).filter(record => record.archived), [directory]);
  return <section><h2>History</h2>{history.error && <p role="alert">{history.error}</p>}<ul>{history.value?.map(record => <li key={record.id}><h3>{record.title}</h3><p>{record.id} · {record.archive?.archivedAt || 'Archived'}</p><details><summary>Details</summary><pre>{JSON.stringify(record, null, 2)}</pre></details></li>)}</ul>{history.value?.length === 0 && <p>No archived PRDs.</p>}</section>;
}
export function AdvancedPage(props: FrontendPageProps) {
  const action = useOperation(props.runtime);
  return <section><h2>Advanced</h2><p>Deploy the integration branch using this repository’s configured deployment command.</p><button disabled={action.busy} onClick={() => void action.run('deploy')}>Deploy</button><OperationStatus {...action} /><AgentsPage {...props} />{props.options?.maintenance === true && <MaintenancePage {...props} />}</section>;
}
export default function DevelopmentFrontend(props: FrontendPageProps) {
  const [page, setPage] = useState('Main');
  return <main style={{ fontFamily: 'system-ui', maxWidth: 1000, margin: 'auto', padding: 24 }}><h1>{props.context.repository.name || props.context.repository.id}</h1><nav aria-label="Development pages">{['Main', 'Chat', 'Agents', 'History', 'Advanced'].map(name => <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}>{name}</button>)}</nav>{page === 'Main' ? <MainPage {...props} /> : page === 'Chat' ? <ChatPage {...props} /> : page === 'Agents' ? <AgentsPage {...props} /> : page === 'History' ? <HistoryPage {...props} /> : <AdvancedPage {...props} />}</main>;
}
