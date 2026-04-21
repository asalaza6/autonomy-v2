import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CHAT_RESPONSE_SCHEMA,
  buildAgentChatPrompt,
  normalizeChatPrdProposal,
} from '../../src/server/control-plane/control-plane-chat.js';
import {
  buildPrdSubmissionFromProposal,
  extractPrdProposalFromText,
  normalizePrdProposal,
} from '../../src/server/control-plane/control-plane-prd-proposal.js';
import {
  completeJob,
  createControlPlaneJob,
  enqueueJob,
  listDiscoveredRepos,
  loadControlPlaneState,
  queueAgentChatMessage,
  setRepoStatus,
} from '../../src/server/control-plane/control-plane-store.js';
import { validatePrdAddSubmission } from '../../src/server/control-plane/control-plane-validation.js';

test('control plane chat structured output schema supports optional PRD proposals', () => {
  const schemaProperties = Object.keys(CHAT_RESPONSE_SCHEMA.properties);

  assert.deepEqual(schemaProperties, ['answer', 'prdProposal']);
  assert.deepEqual(CHAT_RESPONSE_SCHEMA.required, ['answer']);
  assert.match(
    buildAgentChatPrompt('alpha', {
      repoId: 'alpha',
      conversationId: 'conversation-001',
      messageId: 'message-001',
      responseMessageId: 'message-002',
      prompt: 'Hello',
    }, {}),
    /optional prdProposal field/
  );
});

test('control plane chat detects structured PRD proposals without treating normal prose as a draft', () => {
  const proposal = normalizeChatPrdProposal({
    answer: 'Queue this after review.',
    prdProposal: {
      title: 'Improve repo chat PRD handoff',
      problem: 'Managers copy chat recommendations by hand.',
      goal: 'Load recommendations as editable PRD drafts.',
      requirements: ['Detect structured proposals'],
      acceptanceCriteria: ['Draft can be submitted manually'],
      verification: ['Run focused UI tests'],
    },
  }, 'Queue this after review.', 'alpha', {
    repoId: 'alpha',
    conversationId: 'chat-1',
    messageId: 'msg-manager',
    responseMessageId: 'msg-agent',
    prompt: 'Can you queue that?',
  });

  assert.equal(proposal?.title, 'Improve repo chat PRD handoff');
  assert.equal(proposal?.source?.repoId, 'alpha');
  assert.equal(proposal?.source?.conversationId, 'chat-1');
  assert.deepEqual(proposal?.requirements, ['Detect structured proposals']);

  assert.equal(
    extractPrdProposalFromText('This is only normal repo status prose.'),
    null
  );
});

test('control plane chat parses machine-readable PRD proposal blocks from answer text', () => {
  const proposal = extractPrdProposalFromText(`
Here is the draft I recommend.

\`\`\`autonomy-prd-proposal
{
  "kind": "prd-proposal",
  "title": "Add chat-generated PRD drafts",
  "problem": "The manager manually copies recommendations.",
  "goal": "Populate a draft in the control plane.",
  "requirements": ["Render a review state"],
  "acceptanceCriteria": ["No automatic submission"],
  "verification": ["Unit test parsing"]
}
\`\`\`
`, {
    repoId: 'alpha',
    responseMessageId: 'msg-agent',
  });

  assert.equal(proposal?.title, 'Add chat-generated PRD drafts');
  assert.deepEqual(proposal?.acceptanceCriteria, ['No automatic submission']);
  assert.equal(proposal?.source?.responseMessageId, 'msg-agent');

  const submission = buildPrdSubmissionFromProposal(proposal!);
  assert.equal(submission.title, 'Add chat-generated PRD drafts');
  assert.match(submission.specification || '', /## Problem/);
  assert.match(submission.specification || '', /Source Chat Message/);
});

test('control plane chat persists conversation messages and bridge replies', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-chat-'));

  const first = queueAgentChatMessage(rootDir, {
    repoId: 'alpha',
    prompt: 'What is the current repo status?',
  });

  assert.equal(first.job.type, 'agent:chat');
  assert.equal(first.job.payload.repoId, 'alpha');
  assert.equal(first.conversation.messages.length, 2);
  assert.equal(first.conversation.messages[0].role, 'manager');
  assert.equal(first.conversation.messages[1].role, 'agent');
  assert.equal(first.conversation.messages[1].status, 'queued');

  completeJob(rootDir, first.job.id, {
    status: 'completed',
    result: {
      answer: 'The repo is idle and ready for a PRD.',
    },
  });

  const afterReply = loadControlPlaneState(rootDir);
  const conversation = afterReply.conversations.alpha[0];
  assert.equal(conversation.messages[1].status, 'complete');
  assert.equal(conversation.messages[1].content, 'The repo is idle and ready for a PRD.');

  const second = queueAgentChatMessage(rootDir, {
    repoId: 'alpha',
    conversationId: conversation.id,
    prompt: 'What should I do next?',
  });

  assert.equal(second.conversation.messages.length, 4);
  const secondPayload = second.job.payload as any;
  assert.equal(secondPayload.history.length, 2);
  assert.equal(secondPayload.history[0].content, 'What is the current repo status?');
  assert.equal(secondPayload.history[1].content, 'The repo is idle and ready for a PRD.');
});

test('control plane chat completion stores PRD proposals on the agent message', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-chat-prd-'));

  const queued = queueAgentChatMessage(rootDir, {
    repoId: 'alpha',
    prompt: 'Please turn that recommendation into a PRD.',
  });

  completeJob(rootDir, queued.job.id, {
    status: 'completed',
    result: {
      answer: 'I prepared a draft PRD for review.',
      prdProposal: {
        title: 'Review chat-generated PRDs',
        problem: 'Chat recommendations need manual copy and paste.',
        goal: 'Expose an editable draft.',
        requirements: ['Show review controls'],
        acceptanceCriteria: ['User explicitly submits'],
        verification: ['Run UI tests'],
      },
    },
  });

  const afterReply = loadControlPlaneState(rootDir);
  const agentMessage = afterReply.conversations.alpha[0].messages[1];
  assert.equal(agentMessage.status, 'complete');
  assert.equal(agentMessage.prdProposal?.title, 'Review chat-generated PRDs');
  assert.equal(agentMessage.prdProposal?.source?.conversationId, queued.conversation.id);
  assert.equal(agentMessage.prdProposal?.source?.responseMessageId, agentMessage.id);
});

test('submitted chat PRD proposals use the normal control plane PRD queue path', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-chat-submit-'));
  setRepoStatus(rootDir, 'alpha', {}, {
    repoId: 'alpha',
    label: 'Alpha',
  });
  const proposal = normalizePrdProposal({
    title: 'Queue submitted chat proposal',
    problem: 'The draft needs to enter the durable queue.',
    goal: 'Use the existing PRD add job path.',
    requirements: ['Submit through /api/jobs semantics'],
    acceptanceCriteria: ['Job type remains prd:add'],
    verification: ['Validate the payload'],
    source: {
      repoId: 'alpha',
      conversationId: 'chat-1',
      responseMessageId: 'msg-agent',
    },
  });

  const submission = buildPrdSubmissionFromProposal(proposal!, { repoId: 'alpha' });
  const { payload } = validatePrdAddSubmission(listDiscoveredRepos(rootDir), submission);
  const job = enqueueJob(rootDir, createControlPlaneJob(payload));

  assert.equal(job.type, 'prd:add');
  assert.equal(job.payload.title, 'Queue submitted chat proposal');
  assert.match(String(job.payload.specification || ''), /Source Chat Message/);
  assert.deepEqual(job.payload.requirements, ['Submit through /api/jobs semantics']);
});
