import type { ControlPlanePrdSourceChat } from '../../types.js';

const SOURCE_CHAT_HEADER_RE = /^#{2,6}\s+Source Chat Message\s*$/im;
const NEXT_MARKDOWN_HEADER_RE = /(?:^|\r?\n)#{1,6}\s+\S/;

function extractPrdSourceChatMetadata(prd: unknown): ControlPlanePrdSourceChat | null {
  if (!isRecord(prd)) {
    return null;
  }

  const specificationSource = extractPrdSourceChatMetadataFromSpecification(prd.specification);
  const recordSource = normalizePrdSourceChat(
    prd.sourceChat ||
    prd.source_chat ||
    prd.sourceChatMessage ||
    prd.source
  );
  return mergePrdSourceChat(specificationSource, recordSource);
}

function extractPrdSourceChatMetadataFromSpecification(specification: unknown): ControlPlanePrdSourceChat | null {
  const text = String(specification || '');
  if (!text.trim()) {
    return null;
  }

  const headerMatch = SOURCE_CHAT_HEADER_RE.exec(text);
  if (!headerMatch) {
    return null;
  }

  const sectionStart = headerMatch.index + headerMatch[0].length;
  const sectionTail = text.slice(sectionStart);
  const nextHeaderMatch = NEXT_MARKDOWN_HEADER_RE.exec(sectionTail);
  const section = nextHeaderMatch
    ? sectionTail.slice(0, nextHeaderMatch.index)
    : sectionTail;
  return parseSourceChatSection(section);
}

function normalizePrdSourceChat(value: unknown): ControlPlanePrdSourceChat | null {
  if (!isRecord(value)) {
    return null;
  }

  const source = {
    repoId: cleanSourceChatText(readFirst(value, ['repoId', 'repo_id', 'repo', 'repositoryId', 'repository'])),
    conversationId: cleanSourceChatText(readFirst(value, [
      'conversationId',
      'conversation_id',
      'conversation',
      'sourceConversationId',
      'source_conversation_id',
      'chatId',
      'chat_id',
    ])),
    managerMessageId: cleanSourceChatText(readFirst(value, [
      'managerMessageId',
      'manager_message_id',
      'managerMessage',
      'messageId',
      'message_id',
    ])),
    agentMessageId: cleanSourceChatText(readFirst(value, [
      'agentMessageId',
      'agent_message_id',
      'agentMessage',
      'responseMessageId',
      'response_message_id',
    ])),
    createdAt: cleanSourceChatText(readFirst(value, ['createdAt', 'created_at', 'created'])),
  };
  return compactPrdSourceChat(source);
}

function parseSourceChatSection(section: string): ControlPlanePrdSourceChat | null {
  const source: ControlPlanePrdSourceChat = {};
  String(section || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*(?:[-*]\s*)?(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.*?)\s*$/);
    if (!match) {
      return;
    }
    const key = normalizeSourceChatSectionKey(match[1]);
    const value = cleanSourceChatText(match[2]);
    if (!value) {
      return;
    }
    if (key === 'repo') {
      source.repoId = value;
    } else if (key === 'conversation') {
      source.conversationId = value;
    } else if (key === 'managerMessage') {
      source.managerMessageId = value;
    } else if (key === 'agentMessage') {
      source.agentMessageId = value;
    } else if (key === 'created') {
      source.createdAt = value;
    }
  });
  return compactPrdSourceChat(source);
}

function normalizeSourceChatSectionKey(value: unknown) {
  const key = String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (key === 'repo' || key === 'repo id' || key === 'repository' || key === 'repository id') {
    return 'repo';
  }
  if (key === 'conversation' || key === 'conversation id' || key === 'chat' || key === 'chat id') {
    return 'conversation';
  }
  if (key === 'manager message' || key === 'manager message id') {
    return 'managerMessage';
  }
  if (key === 'agent message' || key === 'agent message id' || key === 'response message' || key === 'response message id') {
    return 'agentMessage';
  }
  if (key === 'created' || key === 'created at') {
    return 'created';
  }
  return '';
}

function mergePrdSourceChat(
  base: ControlPlanePrdSourceChat | null,
  override: ControlPlanePrdSourceChat | null
) {
  if (!base && !override) {
    return null;
  }
  return compactPrdSourceChat({
    ...(base || {}),
    ...(override || {}),
  });
}

function compactPrdSourceChat(source: ControlPlanePrdSourceChat): ControlPlanePrdSourceChat | null {
  const normalized = Object.fromEntries(
    Object.entries(source)
      .map(([key, value]) => [key, cleanSourceChatText(value)] as const)
      .filter(([, value]) => value)
  ) as ControlPlanePrdSourceChat;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function readFirst(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}

function cleanSourceChatText(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export {
  extractPrdSourceChatMetadata,
  extractPrdSourceChatMetadataFromSpecification,
  normalizePrdSourceChat,
};
