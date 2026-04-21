import fs from 'fs';
import path from 'path';
import { ensureDir, readJson, writeJson } from '../orchestrator/paths.js';
import type {
  ControlPlaneRepoRecord,
  ControlPlanePrdAddPayload,
  ControlPlaneDeployPayload,
  ControlPlanePackageUpdatePayload,
  ControlPlaneRestartPayload,
  ControlPlaneAgentChatMessagePayload,
  ControlPlaneConversationRecord,
  ControlPlaneChatMessageRecord,
  ControlPlaneJobRecord,
  ControlPlaneHeartbeatRecord,
  ControlPlaneRepoStatusRecord,
  ControlPlaneState,
} from '../../types.js';
import { normalizeRepoRecord } from './control-plane-validation.js';
import {
  extractPrdProposalFromText,
  normalizePrdProposal,
} from './control-plane-prd-proposal.js';

const DEFAULT_CONTROL_PLANE_STATE: ControlPlaneState = {
  schemaVersion: 1,
  jobs: [],
  repoStatuses: {},
  conversations: {},
  heartbeats: {},
};

const MEMORY_CONTROL_PLANE_STATES = new Map<string, ControlPlaneState>();

function getControlPlanePaths(rootDir: string) {
  const controlPlaneDir = path.join(rootDir, '.autonomy', 'control-plane');
  return {
    controlPlaneDir,
    statePath: path.join(controlPlaneDir, 'state.json'),
  };
}

function loadControlPlaneState(rootDir: string): ControlPlaneState {
  const stateKey = getControlPlaneStateKey(rootDir);
  const cachedState = MEMORY_CONTROL_PLANE_STATES.get(stateKey);
  if (cachedState) {
    return cachedState;
  }

  const persistedState = shouldPersistControlPlaneState(rootDir)
    ? normalizeControlPlaneState(readJson(getControlPlanePaths(rootDir).statePath, DEFAULT_CONTROL_PLANE_STATE))
    : normalizeControlPlaneState(DEFAULT_CONTROL_PLANE_STATE);
  MEMORY_CONTROL_PLANE_STATES.set(stateKey, persistedState);
  return persistedState;
}

function saveControlPlaneState(rootDir: string, state: ControlPlaneState) {
  const normalizedState = normalizeControlPlaneState(state);
  MEMORY_CONTROL_PLANE_STATES.set(getControlPlaneStateKey(rootDir), normalizedState);
  if (!shouldPersistControlPlaneState(rootDir)) {
    return normalizedState;
  }

  const paths = getControlPlanePaths(rootDir);
  ensureDir(paths.controlPlaneDir);
  writeJson(paths.statePath, normalizedState);
  return normalizedState;
}

function normalizeControlPlaneState(state: Partial<ControlPlaneState> = {}): ControlPlaneState {
  return {
    schemaVersion: typeof state.schemaVersion === 'number' ? state.schemaVersion : 1,
    jobs: Array.isArray(state.jobs) ? state.jobs.map(normalizeJobRecord).filter(Boolean) : [],
    repoStatuses: normalizeRepoStatuses(state.repoStatuses),
    conversations: normalizeConversations(state.conversations),
    heartbeats: normalizeHeartbeats(state.heartbeats),
  };
}

function normalizeConversations(
  conversations: Record<string, ControlPlaneConversationRecord[]> | undefined | null
) {
  const normalized: Record<string, ControlPlaneConversationRecord[]> = {};
  Object.entries(conversations || {}).forEach(([repoId, entries]) => {
    const normalizedRepoId = String(repoId || '').trim();
    if (!normalizedRepoId || !Array.isArray(entries)) {
      return;
    }
    const repoConversations = entries
      .map((conversation) => normalizeConversationRecord(conversation, normalizedRepoId))
      .filter((conversation): conversation is ControlPlaneConversationRecord => Boolean(conversation));
    if (repoConversations.length > 0) {
      normalized[normalizedRepoId] = repoConversations;
    }
  });
  return normalized;
}

function normalizeConversationRecord(
  conversation: ControlPlaneConversationRecord | null | undefined,
  fallbackRepoId = ''
) {
  if (!conversation || !conversation.id) {
    return null;
  }
  const repoId = String(conversation.repoId || fallbackRepoId || '').trim();
  if (!repoId) {
    return null;
  }
  const createdAt = String(conversation.createdAt || new Date().toISOString());
  return {
    ...conversation,
    id: String(conversation.id),
    repoId,
    title: String(conversation.title || 'Repo conversation').trim() || 'Repo conversation',
    createdAt,
    updatedAt: String(conversation.updatedAt || createdAt),
    messages: Array.isArray(conversation.messages)
      ? conversation.messages.map(normalizeChatMessageRecord).filter((message): message is ControlPlaneChatMessageRecord => Boolean(message))
      : [],
  } as ControlPlaneConversationRecord;
}

function normalizeChatMessageRecord(message: ControlPlaneChatMessageRecord | null | undefined) {
  if (!message || !message.id) {
    return null;
  }
  const createdAt = String(message.createdAt || new Date().toISOString());
  const normalized: ControlPlaneChatMessageRecord = {
    ...message,
    id: String(message.id),
    role: normalizeChatRole(message.role),
    content: String(message.content || ''),
    createdAt,
    updatedAt: message.updatedAt ? String(message.updatedAt) : undefined,
    status: normalizeChatMessageStatus(message.status),
    jobId: normalizeOptionalString(message.jobId),
    error: normalizeOptionalString(message.error),
  };
  const prdProposal = normalizePrdProposal(message.prdProposal);
  if (prdProposal) {
    normalized.prdProposal = prdProposal;
  } else {
    delete normalized.prdProposal;
  }
  return normalized;
}

function normalizeHeartbeats(heartbeats: Record<string, ControlPlaneHeartbeatRecord> | undefined | null) {
  const normalized: Record<string, ControlPlaneHeartbeatRecord> = {};
  Object.entries(heartbeats || {}).forEach(([kind, heartbeat]) => {
    const normalizedKind = normalizeHeartbeatKind(kind);
    if (!normalizedKind || !heartbeat) {
      return;
    }
    normalized[normalizedKind] = {
      kind: normalizedKind,
      updatedAt: String(heartbeat.updatedAt || new Date().toISOString()),
      note: normalizeOptionalString(heartbeat.note),
    };
  });
  return normalized;
}

function normalizeHeartbeatKind(kind: string | undefined | null) {
  const normalized = String(kind || '').trim();
  if (normalized === 'server' || normalized === 'bridge') {
    return normalized;
  }
  return null;
}

function normalizeRepoStatuses(repoStatuses: Record<string, ControlPlaneRepoStatusRecord> | undefined | null) {
  const normalized: Record<string, ControlPlaneRepoStatusRecord> = {};
  Object.entries(repoStatuses || {}).forEach(([repoId, statusRecord]) => {
    const repo = normalizeRepoRecord(statusRecord, String(repoId || '').trim());
    const normalizedRepoId = String(repo && repo.repoId || '').trim();
    if (!normalizedRepoId || !statusRecord) {
      return;
    }
    normalized[normalizedRepoId] = {
      repoId: normalizedRepoId,
      updatedAt: String(statusRecord.updatedAt || new Date().toISOString()),
      label: repo?.label,
      description: repo?.description,
      default: repo?.default,
      deploymentUrl: repo?.deploymentUrl,
      deploymentLabel: repo?.deploymentLabel,
      snapshot: statusRecord.snapshot || {},
    };
  });
  return normalized;
}

function normalizeJobRecord(job: ControlPlaneJobRecord | null | undefined) {
  if (!job || !job.id || !job.repoId || !job.payload) {
    return null;
  }
  const normalizedStatus = normalizeJobStatus(job.status);
  const normalizedType = normalizeJobType(job.type);
  const payload = normalizeJobPayload(normalizedType, job.payload, job.repoId);
  if (!payload) {
    return null;
  }
  return {
    ...job,
    id: String(job.id),
    type: normalizedType,
    repoId: String(job.repoId),
    status: normalizedStatus,
    createdAt: String(job.createdAt || new Date().toISOString()),
    updatedAt: String(job.updatedAt || job.createdAt || new Date().toISOString()),
    payload,
  };
}

function normalizeJobType(type: ControlPlaneJobRecord['type'] | undefined | null) {
  const normalized = String(type || 'prd:add').trim();
  if (normalized === 'deploy') {
    return 'deploy' as const;
  }
  if (normalized === 'agent:chat') {
    return 'agent:chat' as const;
  }
  if (normalized === 'package:update') {
    return 'package:update' as const;
  }
  if (normalized === 'restart') {
    return 'restart' as const;
  }
  return 'prd:add' as const;
}

function normalizeJobPayload(
  type: ControlPlaneJobRecord['type'],
  payload: ControlPlaneJobRecord['payload'],
  repoId: string
) {
  if (type === 'deploy') {
    return {
      repoId: String((payload as ControlPlaneDeployPayload).repoId || repoId).trim() || repoId,
    } as ControlPlaneDeployPayload;
  }

  if (type === 'package:update') {
    return {
      repoId: String((payload as ControlPlanePackageUpdatePayload).repoId || repoId).trim() || repoId,
    } as ControlPlanePackageUpdatePayload;
  }

  if (type === 'restart') {
    return {
      repoId: String((payload as ControlPlaneRestartPayload).repoId || repoId).trim() || repoId,
    } as ControlPlaneRestartPayload;
  }

  if (type === 'agent:chat') {
    const chatPayload = payload as ControlPlaneAgentChatMessagePayload;
    const conversationId = String(chatPayload.conversationId || '').trim();
    const messageId = String(chatPayload.messageId || '').trim();
    const responseMessageId = String(chatPayload.responseMessageId || '').trim();
    const prompt = String(chatPayload.prompt || '').trim();
    if (!conversationId || !messageId || !responseMessageId || !prompt) {
      return null;
    }
    return {
      repoId: String(chatPayload.repoId || repoId).trim() || repoId,
      conversationId,
      messageId,
      responseMessageId,
      prompt,
      history: normalizeChatHistory(chatPayload.history),
    } as ControlPlaneAgentChatMessagePayload;
  }

  return {
    repoId: String((payload as ControlPlanePrdAddPayload).repoId || repoId),
    id: String((payload as ControlPlanePrdAddPayload).id || ''),
    title: String((payload as ControlPlanePrdAddPayload).title || ''),
    specification: String((payload as ControlPlanePrdAddPayload).specification || '').trim() || undefined,
    requirements: Array.isArray((payload as ControlPlanePrdAddPayload).requirements)
      ? (payload as ControlPlanePrdAddPayload).requirements.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [],
    taskSpecs: Array.isArray((payload as ControlPlanePrdAddPayload).taskSpecs)
      ? (payload as ControlPlanePrdAddPayload).taskSpecs
      : [],
    sprintId: String((payload as ControlPlanePrdAddPayload).sprintId || '').trim() || undefined,
  } as ControlPlanePrdAddPayload;
}

function normalizeOptionalString(value: unknown) {
  const text = String(value || '').trim();
  return text || undefined;
}

function normalizeChatHistory(history: ControlPlaneAgentChatMessagePayload['history'] | undefined) {
  if (!Array.isArray(history)) {
    return [];
  }
  return history
    .map((message) => ({
      role: normalizeChatRole(message && message.role),
      content: String(message && message.content || '').trim(),
      createdAt: String(message && message.createdAt || ''),
    }))
    .filter((message) => message.content);
}

function normalizeChatRole(role: string | undefined | null) {
  return String(role || '').trim() === 'agent' ? 'agent' as const : 'manager' as const;
}

function normalizeChatMessageStatus(status: string | undefined | null) {
  const normalized = String(status || 'complete').trim();
  if (['queued', 'responding', 'complete', 'failed'].includes(normalized)) {
    return normalized as ControlPlaneChatMessageRecord['status'];
  }
  return 'complete' as const;
}

function normalizeJobStatus(status: string | undefined | null) {
  const normalized = String(status || 'queued').trim();
  if (['queued', 'claimed', 'running', 'completed', 'failed'].includes(normalized)) {
    return normalized as ControlPlaneJobRecord['status'];
  }
  return 'queued';
}

function enqueueJob(rootDir: string, job: ControlPlaneJobRecord) {
  const state = loadControlPlaneState(rootDir);
  state.jobs.push(normalizeJobRecord(job) || job);
  saveControlPlaneState(rootDir, state);
  return job;
}

function listJobs(rootDir: string, filter: Partial<Pick<ControlPlaneJobRecord, 'repoId' | 'status' | 'type'>> = {}) {
  const state = loadControlPlaneState(rootDir);
  return state.jobs.filter((job) => {
    if (filter.repoId && job.repoId !== filter.repoId) {
      return false;
    }
    if (filter.status && job.status !== filter.status) {
      return false;
    }
    if (filter.type && job.type !== filter.type) {
      return false;
    }
    return true;
  });
}

function listConversations(rootDir: string, repoId: string) {
  const state = loadControlPlaneState(rootDir);
  const normalizedRepoId = String(repoId || '').trim();
  if (!normalizedRepoId) {
    return [];
  }
  return (state.conversations[normalizedRepoId] || [])
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(String(left.updatedAt || left.createdAt || '')) || 0;
      const rightTime = Date.parse(String(right.updatedAt || right.createdAt || '')) || 0;
      if (leftTime !== rightTime) {
        return rightTime - leftTime;
      }
      return String(left.id || '').localeCompare(String(right.id || ''));
    });
}

function queueAgentChatMessage(rootDir: string, input: {
  repoId: string;
  conversationId?: string;
  prompt: string;
}) {
  const state = loadControlPlaneState(rootDir);
  const repoId = String(input.repoId || '').trim();
  const prompt = String(input.prompt || '').trim();
  if (!repoId) {
    throw new Error('Missing repoId.');
  }
  if (!prompt) {
    throw new Error('Provide a message for the repo agent.');
  }

  const now = new Date().toISOString();
  const conversations = state.conversations[repoId] || [];
  state.conversations[repoId] = conversations;
  let conversation = conversations.find((entry) => entry.id === String(input.conversationId || '').trim()) || null;
  if (!conversation) {
    conversation = {
      id: createControlPlaneRecordId('chat'),
      repoId,
      title: buildConversationTitle(prompt),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    conversations.push(conversation);
  }

  const history = buildConversationHistory(conversation);
  const managerMessage: ControlPlaneChatMessageRecord = {
    id: createControlPlaneRecordId('msg'),
    role: 'manager',
    content: prompt,
    createdAt: now,
    updatedAt: now,
    status: 'complete',
  };
  const responseMessage: ControlPlaneChatMessageRecord = {
    id: createControlPlaneRecordId('msg'),
    role: 'agent',
    content: 'Waiting for the bridge to reply...',
    createdAt: now,
    updatedAt: now,
    status: 'queued',
  };
  const job = createControlPlaneAgentChatJob({
    repoId,
    conversationId: conversation.id,
    messageId: managerMessage.id,
    responseMessageId: responseMessage.id,
    prompt,
    history,
  });
  responseMessage.jobId = job.id;
  conversation.messages.push(managerMessage, responseMessage);
  conversation.updatedAt = now;
  state.jobs.push(normalizeJobRecord(job) || job);
  saveControlPlaneState(rootDir, state);
  return {
    conversation,
    job,
  };
}

function claimJob(rootDir: string, jobId: string, options: { repoIds?: string[] } = {}) {
  const state = loadControlPlaneState(rootDir);
  const job = state.jobs.find((entry) => entry.id === jobId);
  if (!job || job.status !== 'queued') {
    return null;
  }
  const eligibleRepoIds = Array.isArray(options.repoIds)
    ? options.repoIds.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (eligibleRepoIds.length > 0 && !eligibleRepoIds.includes(String(job.repoId || '').trim())) {
    return null;
  }
  job.status = 'claimed';
  job.claimedAt = new Date().toISOString();
  job.updatedAt = job.claimedAt;
  if (job.type === 'agent:chat') {
    updateAgentChatResponseMessage(state, job, {
      status: 'responding',
      content: 'Bridge is drafting a reply...',
      updatedAt: job.updatedAt,
    });
  }
  saveControlPlaneState(rootDir, state);
  return job;
}

function completeJob(rootDir: string, jobId: string, patch: Partial<ControlPlaneJobRecord> = {}) {
  const state = loadControlPlaneState(rootDir);
  const job = state.jobs.find((entry) => entry.id === jobId);
  if (!job) {
    return null;
  }
  job.status = normalizeJobStatus(patch.status || job.status);
  job.updatedAt = new Date().toISOString();
  job.completedAt = patch.completedAt || (job.status === 'completed' || job.status === 'failed' ? job.updatedAt : job.completedAt);
  if (typeof patch.error !== 'undefined') {
    job.error = patch.error;
  }
  if (typeof patch.result !== 'undefined') {
    job.result = patch.result;
  }
  if (job.type === 'agent:chat') {
    applyAgentChatJobCompletion(state, job);
  }
  saveControlPlaneState(rootDir, state);
  return job;
}

function touchHeartbeat(rootDir: string, kind: 'server' | 'bridge', patch: Partial<ControlPlaneHeartbeatRecord> = {}) {
  const state = loadControlPlaneState(rootDir);
  state.heartbeats[kind] = {
    kind,
    updatedAt: new Date().toISOString(),
    note: normalizeOptionalString(patch.note),
  };
  saveControlPlaneState(rootDir, state);
  return state.heartbeats[kind];
}

function setRepoStatus(
  rootDir: string,
  repoId: string,
  snapshot: Record<string, unknown>,
  repo: Partial<ControlPlaneRepoRecord> = {}
) {
  const state = loadControlPlaneState(rootDir);
  const normalizedRepo = normalizeRepoRecord({
    ...repo,
    repoId,
  });
  const normalizedRepoId = String(normalizedRepo && normalizedRepo.repoId || '').trim();
  if (!normalizedRepoId) {
    throw new Error('Missing repoId.');
  }
  const existing = state.repoStatuses[normalizedRepoId];
  state.repoStatuses[normalizedRepoId] = {
    repoId: normalizedRepoId,
    updatedAt: new Date().toISOString(),
    label: normalizedRepo?.label || existing?.label,
    description: normalizedRepo?.description || existing?.description,
    default: normalizedRepo?.default === true || existing?.default === true,
    deploymentUrl: normalizedRepo?.deploymentUrl || existing?.deploymentUrl,
    deploymentLabel: normalizedRepo?.deploymentLabel || existing?.deploymentLabel,
    snapshot,
  };
  saveControlPlaneState(rootDir, state);
  return state.repoStatuses[normalizedRepoId];
}

function getRepoStatuses(rootDir: string) {
  const state = loadControlPlaneState(rootDir);
  return state.repoStatuses;
}

function listDiscoveredRepos(rootDir: string) {
  const state = loadControlPlaneState(rootDir);
  return Object.values(state.repoStatuses || {})
    .map((repo) => normalizeRepoRecord(repo))
    .filter((repo): repo is ControlPlaneRepoRecord => Boolean(repo && repo.repoId))
    .sort((left, right) => {
      const leftLabel = String(left && left.label || left && left.repoId || '');
      const rightLabel = String(right && right.label || right && right.repoId || '');
      return leftLabel.localeCompare(rightLabel);
    });
}

function ensureControlPlaneDataDir(rootDir: string) {
  const paths = getControlPlanePaths(rootDir);
  if (shouldPersistControlPlaneState(rootDir)) {
    ensureDir(paths.controlPlaneDir);
    if (!fs.existsSync(paths.statePath)) {
      saveControlPlaneState(rootDir, DEFAULT_CONTROL_PLANE_STATE);
    }
  } else {
    loadControlPlaneState(rootDir);
  }
  return paths;
}

function createControlPlaneJob(payload: ControlPlanePrdAddPayload): ControlPlaneJobRecord {
  const job: ControlPlaneJobRecord = {
    id: `job_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: 'prd:add' as const,
    repoId: payload.repoId,
    payload,
    status: 'queued' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return job;
}

function createControlPlaneDeployJob(payload: ControlPlaneDeployPayload): ControlPlaneJobRecord {
  const job: ControlPlaneJobRecord = {
    id: `job_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: 'deploy' as const,
    repoId: payload.repoId,
    payload: {
      repoId: payload.repoId,
    },
    status: 'queued' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return job;
}

function createControlPlanePackageUpdateJob(payload: ControlPlanePackageUpdatePayload): ControlPlaneJobRecord {
  const job: ControlPlaneJobRecord = {
    id: createControlPlaneRecordId('job'),
    type: 'package:update' as const,
    repoId: payload.repoId,
    payload: {
      repoId: payload.repoId,
    },
    status: 'queued' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return job;
}

function createControlPlaneRestartJob(payload: ControlPlaneRestartPayload): ControlPlaneJobRecord {
  const job: ControlPlaneJobRecord = {
    id: createControlPlaneRecordId('job'),
    type: 'restart' as const,
    repoId: payload.repoId,
    payload: {
      repoId: payload.repoId,
    },
    status: 'queued' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return job;
}

function createControlPlaneAgentChatJob(payload: ControlPlaneAgentChatMessagePayload): ControlPlaneJobRecord {
  const job: ControlPlaneJobRecord = {
    id: createControlPlaneRecordId('job'),
    type: 'agent:chat' as const,
    repoId: payload.repoId,
    payload: {
      repoId: payload.repoId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      responseMessageId: payload.responseMessageId,
      prompt: payload.prompt,
      history: normalizeChatHistory(payload.history),
    },
    status: 'queued' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return job;
}

function applyAgentChatJobCompletion(state: ControlPlaneState, job: ControlPlaneJobRecord) {
  const now = job.updatedAt || new Date().toISOString();
  if (job.status === 'completed') {
    const answer = String(job.result && (job.result.answer || job.result.message) || '').trim();
    const payload = job.payload as ControlPlaneAgentChatMessagePayload;
    const prdProposal = normalizePrdProposal(job.result && job.result.prdProposal, {
      repoId: job.repoId || payload.repoId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      responseMessageId: payload.responseMessageId,
      createdAt: now,
    }) || extractPrdProposalFromText(answer, {
      repoId: job.repoId || payload.repoId,
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      responseMessageId: payload.responseMessageId,
      createdAt: now,
    });
    updateAgentChatResponseMessage(state, job, {
      status: 'complete',
      content: answer || 'The repo agent completed without returning a message.',
      ...(prdProposal ? { prdProposal } : {}),
      updatedAt: now,
    });
    return;
  }

  if (job.status === 'failed') {
    const error = String(job.error || 'The repo agent could not reply.').trim();
    updateAgentChatResponseMessage(state, job, {
      status: 'failed',
      content: error,
      error,
      updatedAt: now,
    });
  }
}

function updateAgentChatResponseMessage(
  state: ControlPlaneState,
  job: ControlPlaneJobRecord,
  patch: Partial<ControlPlaneChatMessageRecord>
) {
  const payload = job.payload as ControlPlaneAgentChatMessagePayload;
  const repoId = String(job.repoId || payload.repoId || '').trim();
  const conversationId = String(payload.conversationId || '').trim();
  const responseMessageId = String(payload.responseMessageId || '').trim();
  if (!repoId || !conversationId || !responseMessageId) {
    return;
  }
  const conversation = (state.conversations[repoId] || []).find((entry) => entry.id === conversationId);
  if (!conversation) {
    return;
  }
  let message = conversation.messages.find((entry) => entry.id === responseMessageId) || null;
  if (!message) {
    message = {
      id: responseMessageId,
      role: 'agent',
      content: '',
      createdAt: patch.updatedAt || new Date().toISOString(),
      jobId: job.id,
      status: 'queued',
    };
    conversation.messages.push(message);
  }
  message.role = 'agent';
  message.jobId = job.id;
  if (typeof patch.content !== 'undefined') {
    message.content = String(patch.content || '');
  }
  if (typeof patch.status !== 'undefined') {
    message.status = normalizeChatMessageStatus(patch.status);
  }
  if (typeof patch.error !== 'undefined') {
    message.error = normalizeOptionalString(patch.error);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'prdProposal')) {
    const prdProposal = normalizePrdProposal(patch.prdProposal);
    if (prdProposal) {
      message.prdProposal = prdProposal;
    } else {
      delete message.prdProposal;
    }
  }
  message.updatedAt = String(patch.updatedAt || new Date().toISOString());
  conversation.updatedAt = message.updatedAt;
}

function buildConversationHistory(conversation: ControlPlaneConversationRecord) {
  return (conversation.messages || [])
    .filter((message) => message && message.status !== 'queued' && message.status !== 'responding')
    .map((message) => ({
      role: normalizeChatRole(message.role),
      content: String(message.content || '').trim(),
      createdAt: String(message.createdAt || ''),
    }))
    .filter((message) => message.content)
    .slice(-20);
}

function buildConversationTitle(prompt: string) {
  const words = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 8)
    .join(' ');
  return words || 'Repo conversation';
}

function createControlPlaneRecordId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function getControlPlaneStateKey(rootDir: string) {
  return path.resolve(rootDir || process.cwd());
}

function shouldPersistControlPlaneState(rootDir: string) {
  const explicitSetting = String(process.env.AUTONOMY_CONTROL_PLANE_PERSIST || '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off', 'memory'].includes(explicitSetting)) {
    return false;
  }
  if (['1', 'true', 'yes', 'on', 'disk', 'file'].includes(explicitSetting)) {
    return true;
  }
  return !process.env.DYNO && Boolean(rootDir);
}

export {
  claimJob,
  completeJob,
  createControlPlaneAgentChatJob,
  createControlPlaneJob,
  createControlPlaneDeployJob,
  createControlPlanePackageUpdateJob,
  createControlPlaneRestartJob,
  ensureControlPlaneDataDir,
  enqueueJob,
  getControlPlanePaths,
  listConversations,
  listDiscoveredRepos,
  getRepoStatuses,
  listJobs,
  loadControlPlaneState,
  queueAgentChatMessage,
  saveControlPlaneState,
  setRepoStatus,
  touchHeartbeat,
  shouldPersistControlPlaneState,
};
