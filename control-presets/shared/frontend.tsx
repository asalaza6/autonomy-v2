import React, { useState } from 'react';
import type { FrontendPageProps } from '../../src/frontend/index.js';
import { AgentsPage, ChatPage } from './components.js';
export default function SharedFrontend(props: FrontendPageProps) {
  const [page, setPage] = useState('Agents');
  return <main><h1>{props.context.repository.name || props.context.repository.id}</h1><nav aria-label="Workspace">{['Agents', 'Chat'].map(name => <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}>{name}</button>)}</nav>{page === 'Chat' ? <ChatPage {...props} /> : <AgentsPage {...props} />}</main>;
}
