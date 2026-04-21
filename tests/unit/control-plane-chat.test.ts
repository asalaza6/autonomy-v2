import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CHAT_RESPONSE_SCHEMA,
  buildAgentChatPrompt,
} from '../../src/server/control-plane/control-plane-chat.js';
import {
  completeJob,
  loadControlPlaneState,
  queueAgentChatMessage,
} from '../../src/server/control-plane/control-plane-store.js';

test('control plane chat structured output schema matches the answer-only prompt', () => {
  const schemaProperties = Object.keys(CHAT_RESPONSE_SCHEMA.properties);

  assert.deepEqual(schemaProperties, ['answer']);
  assert.deepEqual(CHAT_RESPONSE_SCHEMA.required, schemaProperties);
  assert.match(
    buildAgentChatPrompt('alpha', {
      repoId: 'alpha',
      conversationId: 'conversation-001',
      messageId: 'message-001',
      responseMessageId: 'message-002',
      prompt: 'Hello',
    }, {}),
    /Return JSON only with an answer field\./
  );
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
