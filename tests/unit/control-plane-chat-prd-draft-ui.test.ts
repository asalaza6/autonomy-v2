import test from 'node:test';
import assert from 'node:assert/strict';

import { h, renderToHtml } from '../../src/server/control-plane/control-plane-jsx-runtime/jsx-runtime.js';
import { buildControlPlaneHtml } from '../../src/server/control-plane/control-plane-browser.js';
import { buildPrdSubmissionFromProposal, normalizePrdProposal } from '../../src/server/control-plane/control-plane-prd-proposal.js';
import { validatePrdAddSubmission } from '../../src/server/control-plane/control-plane-validation.js';

test('project UI renders dedicated chat PRD review popup controls', () => {
  const html = buildControlPlaneHtml({
    entrance: 'project',
    repoId: 'alpha',
  });

  assert.match(html, /button\.repo-chat-submit \{/);
  assert.match(html, /button\.repo-chat-submit:hover:not\(:disabled\) \{/);
  assert.match(html, /button\.repo-chat-submit:focus-visible \{/);
  assert.match(html, /class="primary repo-chat-submit">Send to repo agent<\/button>/);
  assert.doesNotMatch(html, /class="primary repo-chat-submit">Queue PRD<\/button>/);
  assert.match(html, /id="chat-prd-draft-panel"/);
  assert.match(html, /id="open-chat-prd-review"/);
  assert.match(html, /id="chat-prd-review-modal"/);
  assert.match(html, /id="close-chat-prd-review"/);
  assert.match(html, /id="back-chat-prd-review"/);
  assert.match(html, /id="submit-chat-prd-review"/);
  assert.match(html, /id="prd-title"/);
  assert.match(html, /id="discard-chat-prd-draft"/);
  assert.match(html, /id="chat-jump-latest"/);
  assert.match(html, /New messages - jump to latest/);
});

test('chat PRD review popup preserves draft on back and close, and submits through the normal queue path', async () => {
  const proposal = normalizePrdProposal({
    title: 'Draft from chat',
    problem: 'The user has to copy text manually.',
    goal: 'Present a dedicated review popup before queueing.',
    requirements: ['Render a popup review step'],
    acceptanceCriteria: ['Closing the popup does not queue work'],
    verification: ['Submit through /api/jobs'],
    priority: 'medium',
    source: {
      repoId: 'alpha',
      conversationId: 'chat-1',
      responseMessageId: 'msg-agent',
    },
  });
  const interactive = installInteractiveBrowserStubs({
    activeDraft: {
      key: 'proposal-key',
      proposal: proposal!,
      title: 'Draft from chat',
      specification: 'Problem: The user has to copy text manually.\n\nGoal: Present a dedicated review popup before queueing.',
      requirements: ['Render a popup review step'],
      sprintId: '',
      taskSpecsRaw: '',
      updatedAt: '2026-04-26T08:00:00.000Z',
    },
  });
  const controlPlaneClientModule = await import('../../src/server/control-plane/control-plane-client.js');
  const { openChatPrdReviewModal, closeChatPrdReviewModal, submitActiveChatPrdDraftReview } = controlPlaneClientModule;

  openChatPrdReviewModal();
  assert.equal(interactive.elements.chatPrdReviewModal.hidden, false);
  assert.match(interactive.elements.chatPrdReviewContent.innerHTML, /Acceptance Criteria/);
  assert.match(interactive.elements.chatPrdReviewContent.innerHTML, /Verification/);

  closeChatPrdReviewModal();
  assert.equal(interactive.elements.chatPrdReviewModal.hidden, true);
  assert.equal(interactive.storage.get(interactive.activeStorageKey)?.includes('proposal-key'), true);

  openChatPrdReviewModal();
  interactive.elements.chatPrdReviewModal.dispatch('click', { target: interactive.elements.chatPrdReviewModal });
  assert.equal(interactive.elements.chatPrdReviewModal.hidden, true);
  assert.equal(interactive.storage.get(interactive.activeStorageKey)?.includes('proposal-key'), true);

  interactive.elements.prdTitle.value = 'Edited chat PRD title';
  interactive.elements.prdSpec.value = 'Edited PRD specification.';
  interactive.elements.prdReq.value = 'Edited requirement';
  openChatPrdReviewModal();
  await submitActiveChatPrdDraftReview();

  const jobRequest = interactive.fetchCalls.find((call) => call.url === '/api/jobs' && call.method === 'POST');
  assert.ok(jobRequest);
  assert.deepEqual(jobRequest.body, {
    repoId: 'alpha',
    title: 'Edited chat PRD title',
    specification: 'Edited PRD specification.',
    requirements: ['Edited requirement'],
    sprintId: '',
    taskSpecs: [],
  });
  assert.equal(interactive.elements.chatPrdReviewModal.hidden, true);
  assert.equal(interactive.storage.has(interactive.activeStorageKey), false);
});

test('chat PRD review resume keeps edited draft changes after closing the popup', async () => {
  const proposal = normalizePrdProposal({
    title: 'Draft from chat',
    problem: 'The user has to copy text manually.',
    goal: 'Present a dedicated review popup before queueing.',
    requirements: ['Render a popup review step'],
    acceptanceCriteria: ['Closing the popup does not queue work'],
    verification: ['Submit through /api/jobs'],
    priority: 'medium',
    source: {
      repoId: 'alpha',
      conversationId: 'chat-1',
      responseMessageId: 'msg-agent',
    },
  });
  const interactive = installInteractiveBrowserStubs({
    activeDraft: {
      key: 'proposal-key',
      proposal: proposal!,
      title: 'Draft from chat',
      specification: 'Problem: The user has to copy text manually.\n\nGoal: Present a dedicated review popup before queueing.',
      requirements: ['Render a popup review step'],
      sprintId: '',
      taskSpecsRaw: '',
      updatedAt: '2026-04-26T08:00:00.000Z',
    },
  });
  const { openChatPrdReviewModal } = await import(
    `../../src/server/control-plane/control-plane-client.js?resume=${Date.now()}`
  );

  interactive.elements.prdTitle.value = 'Edited chat PRD title';
  interactive.elements.prdSpec.value = 'Edited PRD specification.';
  interactive.elements.prdReq.value = 'Edited requirement';
  interactive.elements.form.dispatch('input');
  assert.equal(interactive.storage.get(interactive.activeStorageKey)?.includes('Edited chat PRD title'), true);

  openChatPrdReviewModal();
  interactive.elements.chatPrdReviewModal.dispatch('click', { target: interactive.elements.chatPrdReviewModal });
  assert.equal(interactive.elements.chatPrdReviewModal.hidden, true);
  assert.equal(interactive.storage.get(interactive.activeStorageKey)?.includes('Edited chat PRD title'), true);

  const reviewButton = new FakeButtonElement('review-chat-prd', {
    action: 'review-chat-prd',
    proposalKey: 'proposal-key',
    messageId: 'msg-agent',
    prdProposal: JSON.stringify(proposal),
  });
  interactive.dispatchDocument('click', { target: reviewButton });

  assert.equal(interactive.elements.chatPrdReviewModal.hidden, false);
  assert.equal(interactive.elements.prdTitle.value, 'Edited chat PRD title');
  assert.equal(interactive.elements.prdSpec.value, 'Edited PRD specification.');
  assert.equal(interactive.elements.prdReq.value, 'Edited requirement');
  assert.equal(interactive.storage.get(interactive.activeStorageKey)?.includes('Edited chat PRD title'), true);
});

test('chat PRD proposal card renders review and discard actions', async () => {
  installBrowserStubs();
  const { ChatMessage } = await import('../../src/server/control-plane/control-plane-client.js');
  const proposal = normalizePrdProposal({
    title: 'Draft from chat',
    problem: 'The user has to copy text manually.',
    goal: 'Load the draft into the PRD form.',
    requirements: ['Render review controls'],
    acceptanceCriteria: ['The user can discard the draft'],
    verification: ['Render component HTML'],
    source: {
      repoId: 'alpha',
      conversationId: 'chat-1',
      responseMessageId: 'msg-agent',
    },
  });

  const html = renderToHtml(h(ChatMessage as any, {
    message: {
      id: 'msg-agent',
      role: 'agent',
      status: 'complete',
      content: 'I prepared a draft PRD.',
      createdAt: '2026-04-21T08:00:00.000Z',
      prdProposal: proposal,
    },
  }));

  assert.match(html, /PRD proposal/);
  assert.match(html, /Draft from chat/);
  assert.match(html, /data-action="review-chat-prd"/);
  assert.match(html, /data-action="discard-chat-prd"/);
  assert.doesNotMatch(html, /repo-chat-submit/);
});

test('chat PRD review popup summary renders proposal sections', async () => {
  installBrowserStubs();
  const { ChatPrdReviewSummary, buildChatPrdDraftFormState } = await import('../../src/server/control-plane/control-plane-client.js');
  const proposal = normalizePrdProposal({
    title: 'Dedicated popup',
    problem: 'The advanced tab is easy to miss.',
    goal: 'Make review explicit before queueing.',
    requirements: ['Show a readable proposal summary'],
    acceptanceCriteria: ['The manager can return without submitting'],
    verification: ['Render summary cards'],
    priority: 'high',
  });
  const draft = buildChatPrdDraftFormState('proposal-key', proposal!, 'alpha');
  const html = renderToHtml(h(ChatPrdReviewSummary as any, { draft }));

  assert.match(html, /Dedicated popup/);
  assert.match(html, /Problem/);
  assert.match(html, /Goal/);
  assert.match(html, /Requirements/);
  assert.match(html, /Acceptance Criteria/);
  assert.match(html, /Verification/);
  assert.match(html, /Priority high/);
});

test('history detail renders continue source chat action for source chat metadata', async () => {
  installBrowserStubs();
  const { PrdHistoryDetail } = await import('../../src/server/control-plane/control-plane-client.js');

  const html = renderToHtml(h(PrdHistoryDetail as any, {
    prd: {
      id: 'prd-chat-history',
      title: 'Chat generated PRD',
      stateLabel: 'Completed',
      specification: 'Completed from chat.',
      sourceChat: {
        repoId: 'alpha',
        conversationId: 'chat-1',
        managerMessageId: 'msg-manager',
        agentMessageId: 'msg-agent',
        createdAt: '2026-04-21T20:00:00.000Z',
      },
    },
  }));

  assert.match(html, /Source Chat/);
  assert.match(html, /Continue source chat/);
  assert.match(html, /data-action="continue-prd-source-chat"/);
  assert.match(html, /data-conversation-id="chat-1"/);

  const fallbackHtml = renderToHtml(h(PrdHistoryDetail as any, {
    prd: {
      id: 'prd-chat-history',
      title: 'Chat generated PRD',
      sourceChat: {
        repoId: 'alpha',
        conversationId: 'chat-missing',
      },
    },
    continueChatMessage: 'chat not available',
  }));
  assert.match(fallbackHtml, /chat not available/);

  const normalHtml = renderToHtml(h(PrdHistoryDetail as any, {
    prd: {
      id: 'prd-normal-history',
      title: 'Normal PRD',
      stateLabel: 'Completed',
      specification: 'Completed outside chat.',
    },
  }));
  assert.doesNotMatch(normalHtml, /data-action="continue-prd-source-chat"/);
});

test('history continue chat resolves existing conversations and unavailable fallback', async () => {
  installBrowserStubs();
  const { resolvePrdHistoryContinueChat } = await import('../../src/server/control-plane/control-plane-client.js');

  const existing = resolvePrdHistoryContinueChat({
    id: 'prd-chat-history',
    sourceChat: {
      repoId: 'alpha',
      conversationId: 'chat-1',
    },
  }, [
    {
      id: 'chat-1',
      repoId: 'alpha',
      title: 'Existing source chat',
      messages: [],
    },
  ], 'alpha');
  const missing = resolvePrdHistoryContinueChat({
    id: 'prd-chat-history',
    sourceChat: {
      repoId: 'alpha',
      conversationId: 'chat-missing',
    },
  }, [], 'alpha');
  const absentConversationId = resolvePrdHistoryContinueChat({
    id: 'prd-chat-history',
    sourceChat: {
      repoId: 'alpha',
      managerMessageId: 'msg-manager',
    },
  }, [], 'alpha');

  assert.equal(existing.status, 'available');
  assert.equal(existing.conversation.id, 'chat-1');
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.message, 'chat not available');
  assert.equal(absentConversationId.status, 'unavailable');
  assert.equal(absentConversationId.message, 'chat not available');
});

test('chat PRD draft state can be edited before normal PRD submission validation', async () => {
  installBrowserStubs();
  const { buildChatPrdDraftFormState } = await import('../../src/server/control-plane/control-plane-client.js');
  const proposal = normalizePrdProposal({
    title: 'Original chat title',
    problem: 'Original problem.',
    goal: 'Original goal.',
    requirements: ['Original requirement'],
    acceptanceCriteria: ['Original acceptance'],
    verification: ['Original verification'],
  });
  const draft = buildChatPrdDraftFormState('proposal-key', proposal!, 'alpha');
  const editedSubmission = {
    ...buildPrdSubmissionFromProposal(draft.proposal, { repoId: 'alpha' }),
    title: 'Edited chat PRD title',
    specification: 'Edited PRD specification.',
    requirements: ['Edited requirement'],
  };
  const { payload } = validatePrdAddSubmission([{ repoId: 'alpha', label: 'Alpha' }], editedSubmission);

  assert.equal(payload.title, 'Edited chat PRD title');
  assert.equal(payload.specification, 'Edited PRD specification.');
  assert.deepEqual(payload.requirements, ['Edited requirement']);
});

test('chat scroll decision preserves reading position and shows jump affordance', async () => {
  installBrowserStubs();
  const { resolveChatScrollDecision } = await import('../../src/server/control-plane/control-plane-client.js');
  const decision = resolveChatScrollDecision({
    scrollTop: 180,
    scrollHeight: 1200,
    clientHeight: 420,
    nearBottom: false,
  }, {
    previousFingerprint: 'message-count:2',
    nextFingerprint: 'message-count:3',
  });

  assert.equal(decision.scrollToLatest, false);
  assert.equal(decision.preserveScrollTop, 180);
  assert.equal(decision.showJumpToLatest, true);
});

test('chat scroll decision keeps latest visible near bottom or after send', async () => {
  installBrowserStubs();
  const { isChatNearBottom, resolveChatScrollDecision } = await import('../../src/server/control-plane/control-plane-client.js');

  assert.equal(isChatNearBottom({
    scrollTop: 580,
    scrollHeight: 1000,
    clientHeight: 360,
  }), true);

  const nearBottomDecision = resolveChatScrollDecision({
    scrollTop: 580,
    scrollHeight: 1000,
    clientHeight: 360,
    nearBottom: true,
  }, {
    previousFingerprint: 'message-count:2',
    nextFingerprint: 'message-count:3',
  });
  const sendDecision = resolveChatScrollDecision({
    scrollTop: 120,
    scrollHeight: 1000,
    clientHeight: 360,
    nearBottom: false,
  }, {
    forceScrollToLatest: true,
    previousFingerprint: 'message-count:2',
    nextFingerprint: 'message-count:3',
  });

  assert.equal(nearBottomDecision.scrollToLatest, true);
  assert.equal(nearBottomDecision.showJumpToLatest, false);
  assert.equal(sendDecision.scrollToLatest, true);
  assert.equal(sendDecision.showJumpToLatest, false);
});

function installBrowserStubs() {
  const storage = new Map<string, string>();
  (globalThis as any).window = {
    __AUTONOMY_CONTROL_PLANE_API_BASE_URL__: '',
    __AUTONOMY_CONTROL_PLANE_DEV_TOKEN__: '',
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
  };
  (globalThis as any).document = {
    body: {
      dataset: {
        controlPlaneEntrance: 'project',
        controlPlaneRepoId: 'alpha',
      },
    },
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener: () => undefined,
  };
}

function installInteractiveBrowserStubs({
  activeDraft,
}: {
  activeDraft: {
    key: string;
    proposal: ReturnType<typeof normalizePrdProposal>;
    title: string;
    specification: string;
    requirements: string[];
    sprintId: string;
    taskSpecsRaw: string;
    updatedAt: string;
  };
}) {
  const storage = new Map<string, string>();
  const activeStorageKey = 'autonomy.controlPlane.chatPrdDraft.alpha.active';
  storage.set(activeStorageKey, JSON.stringify(activeDraft));
  const docListeners = new Map<string, ((event?: any) => void)[]>();
  const details = new FakeElement('details');
  const prdTitle = new FakeElement('prd-title');
  const prdSpec = new FakeElement('prd-spec');
  const prdReq = new FakeElement('prd-req');
  const prdSprint = new FakeElement('prd-sprint');
  const prdTaskSpecs = new FakeElement('prd-task-specs');
  const form = new FakeElement('prd-form');
  form.reset = () => {
    prdTitle.value = '';
    prdSpec.value = '';
    prdReq.value = '';
    prdSprint.value = '';
    prdTaskSpecs.value = '';
  };
  form.querySelector = (selector: string) => (selector === 'details' ? details : null);

  const elements = {
    lastUpdated: new FakeElement('last-updated'),
    dashboardRepos: new FakeElement('dashboard-repos'),
    dashboardSummaryNote: new FakeElement('dashboard-summary-note'),
    controlPlaneHeartbeats: new FakeElement('control-plane-heartbeats'),
    form,
    prdTitle,
    prdSpec,
    prdReq,
    prdSprint,
    prdTaskSpecs,
    chatPrdDraftPanel: new FakeElement('chat-prd-draft-panel'),
    chatPrdDraftTitle: new FakeElement('chat-prd-draft-title'),
    chatPrdDraftMeta: new FakeElement('chat-prd-draft-meta'),
    openChatPrdReview: new FakeElement('open-chat-prd-review'),
    discardChatPrdDraft: new FakeElement('discard-chat-prd-draft'),
    chatPrdReviewModal: new FakeElement('chat-prd-review-modal'),
    chatPrdReviewMeta: new FakeElement('chat-prd-review-meta'),
    chatPrdReviewContent: new FakeElement('chat-prd-review-content'),
    closeChatPrdReview: new FakeElement('close-chat-prd-review'),
    backChatPrdReview: new FakeElement('back-chat-prd-review'),
    submitChatPrdReview: new FakeElement('submit-chat-prd-review'),
    refreshButton: new FakeElement('refresh-button'),
    message: new FakeElement('form-message'),
  };
  elements.chatPrdDraftPanel.hidden = true;
  elements.chatPrdReviewModal.hidden = true;

  const elementMap = new Map<string, FakeElement>([
    ['last-updated', elements.lastUpdated],
    ['dashboard-repos', elements.dashboardRepos],
    ['dashboard-summary-note', elements.dashboardSummaryNote],
    ['control-plane-heartbeats', elements.controlPlaneHeartbeats],
    ['prd-form', form],
    ['prd-title', prdTitle],
    ['prd-spec', prdSpec],
    ['prd-req', prdReq],
    ['prd-sprint', prdSprint],
    ['prd-task-specs', prdTaskSpecs],
    ['chat-prd-draft-panel', elements.chatPrdDraftPanel],
    ['chat-prd-draft-title', elements.chatPrdDraftTitle],
    ['chat-prd-draft-meta', elements.chatPrdDraftMeta],
    ['open-chat-prd-review', elements.openChatPrdReview],
    ['discard-chat-prd-draft', elements.discardChatPrdDraft],
    ['chat-prd-review-modal', elements.chatPrdReviewModal],
    ['chat-prd-review-meta', elements.chatPrdReviewMeta],
    ['chat-prd-review-content', elements.chatPrdReviewContent],
    ['close-chat-prd-review', elements.closeChatPrdReview],
    ['back-chat-prd-review', elements.backChatPrdReview],
    ['submit-chat-prd-review', elements.submitChatPrdReview],
    ['refresh-button', elements.refreshButton],
    ['form-message', elements.message],
  ]);

  const fetchCalls: Array<{ url: string; method: string; body: any }> = [];
  (globalThis as any).fetch = async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fetchCalls.push({ url, method, body });
    if (url.startsWith('/api/repos')) {
      return createJsonResponse({ repos: [{ repoId: 'alpha', label: 'Alpha' }] });
    }
    if (url.startsWith('/api/state')) {
      return createJsonResponse({ dashboard: {}, jobs: [], conversations: { alpha: [] } });
    }
    if (url === '/api/jobs') {
      return createJsonResponse({ payload: { id: 'prd-chat-1', title: body?.title || '' } });
    }
    throw new Error(`Unexpected fetch ${method} ${url}`);
  };

  (globalThis as any).window = {
    __AUTONOMY_CONTROL_PLANE_API_BASE_URL__: '',
    __AUTONOMY_CONTROL_PLANE_DEV_TOKEN__: '',
    __AUTONOMY_CONTROL_PLANE_DEV__: false,
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    },
    setInterval: () => 0,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    location: {
      reload: () => undefined,
    },
  };
  (globalThis as any).document = {
    body: {
      dataset: {
        controlPlaneEntrance: 'project',
        controlPlaneRepoId: 'alpha',
      },
    },
    getElementById: (id: string) => elementMap.get(id) || null,
    querySelectorAll: () => [],
    addEventListener: (type: string, listener: (event?: any) => void) => {
      const entries = docListeners.get(type) || [];
      entries.push(listener);
      docListeners.set(type, entries);
    },
  };

  return {
    activeStorageKey,
    dispatchDocument: (type: string, event: any = {}) => {
      for (const listener of docListeners.get(type) || []) {
        listener(event);
      }
    },
    elements,
    fetchCalls,
    storage,
  };
}

class FakeElement {
  hidden = false;
  textContent = '';
  innerHTML = '';
  value = '';
  disabled = false;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  reset = () => undefined;
  querySelector = (_selector: string) => null as any;
  private listeners = new Map<string, ((event?: any) => void)[]>();

  constructor(public id: string) {}

  addEventListener(type: string, listener: (event?: any) => void) {
    const entries = this.listeners.get(type) || [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  dispatch(type: string, event: any = {}) {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }

  setAttribute(name: string, value: string) {
    this.dataset[name] = value;
  }

  scrollIntoView() {}

  focus() {}
}

class FakeButtonElement {
  constructor(
    public id: string,
    public dataset: Record<string, string>,
  ) {}

  closest(_selector: string) {
    const match = _selector.match(/\[data-action="([^"]+)"\]/);
    if (match && this.dataset.action === match[1]) {
      return { dataset: this.dataset };
    }
    return null;
  }
}

function createJsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
