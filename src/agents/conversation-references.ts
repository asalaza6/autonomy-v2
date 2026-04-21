import { AGENT_ROLES } from './role-catalog.js';
import type { AnyRecord } from '../types.js';

type ConversationReferenceTarget = {
  agentId?: string;
  role?: string;
};

function normalizeConversationId(value: unknown): string {
  return String(value || '').trim();
}

function normalizeConversationReference(value: unknown): AnyRecord | null {
  if (typeof value === 'string') {
    const conversationId = normalizeConversationId(value);
    return conversationId ? { conversationId } : null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as AnyRecord;
  const conversationId = normalizeConversationId(
    record.conversationId
      || record.conversation_id
      || record.sessionId
      || record.session_id
  );
  if (!conversationId) {
    return null;
  }
  return {
    ...record,
    conversationId,
  };
}

function buildAgentConversationKey(target: ConversationReferenceTarget): string {
  const agentId = normalizeConversationId(target && target.agentId);
  if (agentId) {
    return `agent:${agentId}`;
  }
  const role = normalizeConversationId(target && target.role);
  return role ? `role:${role}` : '';
}

function buildRoleConversationKey(role: string): string {
  const normalizedRole = normalizeConversationId(role);
  return normalizedRole ? `role:${normalizedRole}` : '';
}

function listConversationLookupKeys(target: ConversationReferenceTarget): string[] {
  const keys = [
    buildAgentConversationKey(target),
    buildRoleConversationKey(target && target.role || ''),
    normalizeConversationId(target && target.agentId),
    normalizeConversationId(target && target.role),
  ];
  return Array.from(new Set(keys.filter(Boolean)));
}

function normalizeConversationReferences(value: unknown): Record<string, AnyRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value as AnyRecord).reduce((references, [key, entry]) => {
    const normalizedKey = normalizeConversationId(key);
    const reference = normalizeConversationReference(entry);
    if (normalizedKey && reference) {
      references[normalizedKey] = reference;
    }
    return references;
  }, {} as Record<string, AnyRecord>);
}

function getAgentConversationReference(record: AnyRecord | null | undefined, target: ConversationReferenceTarget): AnyRecord | null {
  const references = normalizeConversationReferences(record && record.conversationReferences);
  for (const key of listConversationLookupKeys(target)) {
    const reference = references[key];
    if (reference && reference.conversationId && referenceMatchesTarget(reference, target)) {
      return reference;
    }
  }
  return null;
}

function referenceMatchesTarget(reference: AnyRecord, target: ConversationReferenceTarget): boolean {
  const targetAgentId = normalizeConversationId(target && target.agentId);
  const targetRole = normalizeConversationId(target && target.role);
  const referenceAgentId = normalizeConversationId(reference && reference.agentId);
  const referenceRole = normalizeConversationId(reference && reference.role);
  if (targetAgentId && referenceAgentId && targetAgentId !== referenceAgentId) {
    return false;
  }
  if (targetRole && referenceRole && targetRole !== referenceRole) {
    return false;
  }
  return true;
}

function getAgentConversationId(record: AnyRecord | null | undefined, target: ConversationReferenceTarget): string {
  const reference = getAgentConversationReference(record, target);
  const conversationId = normalizeConversationId(reference && reference.conversationId);
  if (conversationId) {
    return conversationId;
  }
  if (target && target.role === AGENT_ROLES.IMPLEMENTATION) {
    return normalizeConversationId(record && record.implementationConversationId);
  }
  return '';
}

function setAgentConversationReference(
  record: AnyRecord | null | undefined,
  target: ConversationReferenceTarget,
  conversationId: string,
  updatedAt = ''
): AnyRecord | null {
  const normalizedConversationId = normalizeConversationId(conversationId);
  const key = buildAgentConversationKey(target);
  if (!record || !key || !normalizedConversationId) {
    return null;
  }
  const references = normalizeConversationReferences(record.conversationReferences);
  const nextReference: AnyRecord = {
    ...(references[key] || {}),
    conversationId: normalizedConversationId,
  };
  const agentId = normalizeConversationId(target && target.agentId);
  const role = normalizeConversationId(target && target.role);
  if (agentId) {
    nextReference.agentId = agentId;
  }
  if (role) {
    nextReference.role = role;
  }
  if (updatedAt) {
    nextReference.updatedAt = updatedAt;
  }
  references[key] = nextReference;
  record.conversationReferences = references;
  if (role === AGENT_ROLES.IMPLEMENTATION) {
    record.implementationConversationId = normalizedConversationId;
  }
  return nextReference;
}

function copyAgentConversationReference(
  targetRecord: AnyRecord | null | undefined,
  sourceRecord: AnyRecord | null | undefined,
  target: ConversationReferenceTarget,
  updatedAt = ''
): string {
  const conversationId = getAgentConversationId(sourceRecord, target);
  if (conversationId) {
    setAgentConversationReference(targetRecord, target, conversationId, updatedAt);
  }
  return conversationId;
}

function resolveReturnedConversationId(value: AnyRecord | null | undefined): string {
  return normalizeConversationId(value && (
    value.conversationId
      || value.conversation_id
      || value.sessionId
      || value.session_id
      || value.implementationConversationId
      || value.implementationSessionId
      || value.reviewConversationId
      || value.reviewSessionId
  ));
}

export {
  buildAgentConversationKey,
  copyAgentConversationReference,
  getAgentConversationId,
  getAgentConversationReference,
  normalizeConversationReferences,
  resolveReturnedConversationId,
  setAgentConversationReference,
};
