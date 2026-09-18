import React, { useEffect, useRef, useState } from 'react';
import type { AutonomyRuntime, Operation } from '../../src/frontend/index.js';
import type { FrontendPageProps } from '../../src/frontend/index.js';

/** Subscribe through the host, keeping asynchronous refreshes out of unmounted pages. */
export function useResource<T>(runtime: AutonomyRuntime, paths: string[], load: () => Promise<T>, dependencies: unknown[] = []) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    let loading = false, dirty = false;
    async function refresh() {
      dirty = true;
      if (loading) return;
      loading = true;
      while (alive && dirty) {
        dirty = false;
        try { const result = await load(); if (alive && !dirty) { setValue(result); setError(''); } }
        catch (failure) { if (alive && !dirty) setError(String(failure)); }
      }
      loading = false;
    }
    void refresh();
    const stop = runtime.watch(paths, () => { void refresh(); });
    return () => { alive = false; stop(); };
  }, [runtime, ...dependencies]);
  return { value, error };
}

export function useOperation(runtime: AutonomyRuntime) {
  const [operation, setOperation] = useState<Operation>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  const generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, [runtime]);
  useEffect(() => {
    if (operation?.status !== 'running') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await runtime.getOperation(operation.id);
        if (!active) return;
        if (!next) { setError('Operation is no longer available.'); setOperation(undefined); return; }
        setOperation(next);
        if (next.status === 'running') timer = setTimeout(poll, 300);
      } catch (failure) { if (active) { setError(String(failure)); setOperation(undefined); } }
    }
    timer = setTimeout(poll, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [runtime, operation?.id, operation?.status]);
  async function run(name: string, input: unknown = {}) {
    const current = ++generation.current;
    setPending(true); setError(''); setOperation(undefined);
    try { const next = await runtime.runAction(name, input); if (alive.current && current === generation.current) setOperation(next); }
    catch (failure) { if (alive.current && current === generation.current) setError(String(failure)); }
    finally { if (alive.current && current === generation.current) setPending(false); }
  }
  return { operation, error, run, busy: pending || operation?.status === 'running' };
}

export function OperationStatus({ operation, error }: { operation?: Operation; error?: string }) {
  return <div aria-live="polite">{error && <p role="alert">{error}</p>}{operation && <><p>{operation.name}: {operation.status}</p>{operation.error && <p role="alert">{operation.error}</p>}{operation.logs.length > 0 && <pre>{operation.logs.join('\n')}</pre>}</>}</div>;
}

export function ChatPage({ runtime }: FrontendPageProps) {
  const [message, setMessage] = useState('');
  const [threadId, setThreadId] = useState('');
  const action = useOperation(runtime);
  const threads = useResource(runtime, ['.autonomy/runtime/frontend/chat'], async () => {
    const files = await runtime.listFiles('.autonomy/runtime/frontend/chat');
    return Promise.all(files.filter(file => file.type === 'file' && file.path.endsWith('.json')).map(file => runtime.readJson<{ id: string; messages: { role: string; text: string }[] }>(file.path)));
  });
  const result = action.operation?.status === 'success' ? action.operation.result as { id?: string; messages?: { role: string; text: string }[] } : undefined;
  useEffect(() => { if (result?.id) { setThreadId(result.id); setMessage(''); } }, [result?.id, action.operation?.id]);
  const messages = result?.id === threadId ? result.messages : threads.value?.find(thread => thread.id === threadId)?.messages;
  return <section><h2>Chat</h2><label>Conversation <select value={threadId} onChange={event => setThreadId(event.target.value)}><option value="">New conversation</option>{threads.value?.map(thread => <option key={thread.id} value={thread.id}>{thread.id}</option>)}</select></label>{threads.error && <p role="alert">{threads.error}</p>}<ol>{messages?.map((entry, index) => <li key={index}><strong>{entry.role}</strong><p style={{ whiteSpace: 'pre-wrap' }}>{entry.text}</p></li>)}</ol><form onSubmit={event => { event.preventDefault(); void action.run('chat:send', { message, ...(threadId ? { threadId } : {}) }); }}><label>Message<textarea value={message} onChange={event => setMessage(event.target.value)} required maxLength={20000} /></label><button disabled={action.busy || !message.trim()}>Send</button></form><OperationStatus {...action} /></section>;
}

export function AgentsPage({ runtime, context }: FrontendPageProps) {
  const [selected, setSelected] = useState(context.agentKey || '');
  const [runId, setRunId] = useState('');
  const action = useOperation(runtime);
  const agents = useResource(runtime, ['.autonomy/runtime', 'prompts/autonomous/v2/config'], () => runtime.listAgents());
  const details = useResource(runtime, ['.autonomy/runtime'], async () => selected ? { agent: await runtime.getAgent(selected), runs: await runtime.listRuns(selected) } : null, [selected]);
  const run = useResource(runtime, ['.autonomy/runtime'], async () => runId ? { run: await runtime.getRun(runId), logs: await runtime.readLogs(runId, { limit: 65536 }) } : null, [runId]);
  return <section><h2>Agents</h2>{agents.error && <p role="alert">{agents.error}</p>}<ul>{agents.value?.map(agent => <li key={agent.runtimeKey}><button onClick={() => { setSelected(agent.runtimeKey); setRunId(''); }}>{agent.agentId}</button> <span>{agent.enabled === false ? 'Disabled' : 'Enabled'}</span> <button disabled={action.busy} onClick={() => void action.run('agent:toggle', { agentKey: agent.runtimeKey, enabled: agent.enabled === false })}>{agent.enabled === false ? 'Enable' : 'Disable'} {agent.agentId}</button></li>)}</ul>{details.error && <p role="alert">{details.error}</p>}{details.value?.agent && <><h3>{details.value.agent.agentId}</h3><pre>{JSON.stringify(details.value.agent, null, 2)}</pre><h3>Lifecycle runs</h3><ul>{details.value.runs.map(record => <li key={record.invocationId}><button onClick={() => setRunId(record.invocationId)}>{record.invocationId} {String(record.status || '')}</button></li>)}</ul></>}{run.error && <p role="alert">{run.error}</p>}{run.value && <><h3>Run details</h3><pre>{JSON.stringify(run.value.run, null, 2)}</pre><h3>Logs</h3><pre>{run.value.logs.text || 'No logs yet.'}</pre>{!run.value.logs.done && <p>Showing the first 64 KiB.</p>}</>}<OperationStatus {...action} /></section>;
}
