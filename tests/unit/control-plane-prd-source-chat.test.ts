import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPrdSourceChatMetadata,
  extractPrdSourceChatMetadataFromSpecification,
  normalizePrdSourceChat,
} from '../../src/autonomy-v2/control-plane/prd-source-chat.js';

test('PRD source chat parser extracts archived Source Chat Message sections', () => {
  const sourceChat = extractPrdSourceChatMetadataFromSpecification(`
# PRD: Continue Source Chat

## Problem
History cannot open the originating chat.

## Source Chat Message
Repo: autonomy-v2
Conversation: chat_1776803047254_7360afb3bd09d8
Manager message: msg_1776803047254_5078a396cd95d
Agent message: msg_1776803047254_6b212890726a58
Created: 2026-04-21T20:26:10.668Z

## Acceptance Criteria
- Continue the chat.
`);

  assert.deepEqual(sourceChat, {
    repoId: 'autonomy-v2',
    conversationId: 'chat_1776803047254_7360afb3bd09d8',
    managerMessageId: 'msg_1776803047254_5078a396cd95d',
    agentMessageId: 'msg_1776803047254_6b212890726a58',
    createdAt: '2026-04-21T20:26:10.668Z',
  });
});

test('PRD source chat parser supports structured metadata and partial legacy blocks', () => {
  assert.deepEqual(normalizePrdSourceChat({
    repoId: 'alpha',
    conversationId: 'chat-1',
    messageId: 'msg-manager',
    responseMessageId: 'msg-agent',
    createdAt: '2026-04-21T20:00:00.000Z',
  }), {
    repoId: 'alpha',
    conversationId: 'chat-1',
    managerMessageId: 'msg-manager',
    agentMessageId: 'msg-agent',
    createdAt: '2026-04-21T20:00:00.000Z',
  });

  assert.deepEqual(extractPrdSourceChatMetadata({
    specification: `
## Source Chat Message
Repo: alpha
Manager message: msg-manager
`,
  }), {
    repoId: 'alpha',
    managerMessageId: 'msg-manager',
  });
});
