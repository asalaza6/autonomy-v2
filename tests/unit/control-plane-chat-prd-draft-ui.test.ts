import test from 'node:test';
import assert from 'node:assert/strict';

import { h, renderToHtml } from '../../src/server/control-plane/control-plane-jsx-runtime/jsx-runtime.js';
import { buildControlPlaneHtml } from '../../src/server/control-plane/control-plane-browser.js';
import { buildPrdSubmissionFromProposal, normalizePrdProposal } from '../../src/server/control-plane/control-plane-prd-proposal.js';
import { validatePrdAddSubmission } from '../../src/server/control-plane/control-plane-validation.js';

test('project UI renders chat PRD draft review controls in the existing PRD form', () => {
  const html = buildControlPlaneHtml({
    entrance: 'project',
    repoId: 'alpha',
  });

  assert.match(html, /id="chat-prd-draft-panel"/);
  assert.match(html, /Review and submit/);
  assert.match(html, /id="prd-title"/);
  assert.match(html, /id="discard-chat-prd-draft"/);
  assert.match(html, /id="chat-jump-latest"/);
  assert.match(html, /New messages - jump to latest/);
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
