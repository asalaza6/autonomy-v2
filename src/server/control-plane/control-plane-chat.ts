import { runCodexStructured } from '../../codex/cli.js';
import type { AnyRecord, ControlPlaneAgentChatMessagePayload } from '../../types.js';
import {
  extractPrdProposalFromText,
  normalizePrdProposal,
} from './control-plane-prd-proposal.js';

const CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: {
    answer: {
      type: 'string',
    },
    prdProposal: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['title'],
          properties: {
            schemaVersion: { type: 'number' },
            kind: { type: 'string' },
            type: { type: 'string' },
            title: { type: 'string' },
            problem: { type: 'string' },
            goal: { type: 'string' },
            requirements: {
              type: 'array',
              items: { type: 'string' },
            },
            acceptanceCriteria: {
              type: 'array',
              items: { type: 'string' },
            },
            verification: {
              type: 'array',
              items: { type: 'string' },
            },
            priority: { type: 'string' },
            source: {
              type: 'object',
              additionalProperties: false,
              properties: {
                repoId: { type: 'string' },
                conversationId: { type: 'string' },
                messageId: { type: 'string' },
                responseMessageId: { type: 'string' },
                createdAt: { type: 'string' },
              },
            },
          },
        },
        { type: 'null' },
      ],
    },
  },
};

async function answerControlPlaneAgentChat({
  repoRoot,
  repoId,
  payload,
  snapshot,
}: {
  repoRoot: string;
  repoId: string;
  payload: ControlPlaneAgentChatMessagePayload;
  snapshot: AnyRecord;
}) {
  if (process.env.AUTONOMY_CONTROL_PLANE_CHAT_STUB === '1') {
    return buildStubAgentChatAnswer(repoId, payload, snapshot);
  }

  const output = await runCodexStructured({
    cwd: repoRoot,
    readOnly: true,
    schema: CHAT_RESPONSE_SCHEMA,
    prompt: buildAgentChatPrompt(repoId, payload, snapshot),
  });

  const answer = String(output && output.answer || '').trim();
  const prdProposal = normalizeChatPrdProposal(output, answer, repoId, payload);
  return {
    answer: answer || 'I could not produce a useful answer for that repo question.',
    ...(prdProposal ? { prdProposal } : {}),
  };
}

function buildAgentChatPrompt(
  repoId: string,
  payload: ControlPlaneAgentChatMessagePayload,
  snapshot: AnyRecord
) {
  return [
    'You are the read-only repo assistant inside the Autonomy v2 control panel.',
    '',
    'Rules:',
    '- Answer the manager about this repository using the provided repo status and any files you inspect.',
    '- Maintain continuity with the conversation history.',
    '- Do not edit files, run long-lived commands, commit, push, deploy, or queue jobs.',
    '- If the manager asks you to change the repo, explain what change request or PRD should be queued instead.',
    '- When you recommend queueing a repo change or PRD, include a prdProposal object with title, problem, goal, requirements, acceptanceCriteria, verification, and priority when known.',
    '- Do not include prdProposal for normal status answers, explanations, or answers that do not recommend a new PRD.',
    '- Be concise and specific. Mention uncertainty when repo context is insufficient.',
    '',
    `Repo id: ${repoId}`,
    '',
    'Conversation history:',
    JSON.stringify(normalizePromptHistory(payload.history), null, 2),
    '',
    'Current manager message:',
    payload.prompt,
    '',
    'Current repo status summary:',
    JSON.stringify(buildRepoChatContext(snapshot), null, 2),
    '',
    'Return JSON only with an answer field and optional prdProposal field.',
  ].join('\n');
}

function buildRepoChatContext(snapshot: AnyRecord = {}) {
  const prds = Array.isArray(snapshot.prds && snapshot.prds.prds) ? snapshot.prds.prds : [];
  return {
    integrationBranch: snapshot.integrationBranch || null,
    productionBranch: snapshot.productionBranch || null,
    activePrds: prds
      .filter((prd) => prd && prd.isQueued !== true && ['planning', 'planned'].includes(String(prd.status || '')))
      .map(summarizePrdForChat)
      .slice(0, 5),
    queuedPrds: prds
      .filter((prd) => prd && (prd.isQueued === true || String(prd.status || '') === 'queued'))
      .map(summarizePrdForChat)
      .slice(0, 5),
    taskCounts: snapshot.taskCounts || {},
    prCounts: snapshot.prCounts || {},
    queues: Array.isArray(snapshot.queues) ? snapshot.queues : [],
    agentStatuses: Array.isArray(snapshot.agentStatuses) ? snapshot.agentStatuses : [],
    pullRequestStatuses: Array.isArray(snapshot.pullRequestStatuses) ? snapshot.pullRequestStatuses : [],
    deployment: snapshot.deployment || null,
  };
}

function summarizePrdForChat(prd: AnyRecord) {
  return {
    id: String(prd && prd.id || ''),
    title: String(prd && prd.title || prd && prd.id || ''),
    status: String(prd && prd.status || ''),
    plannedTaskIds: Array.isArray(prd && prd.plannedTaskIds) ? prd.plannedTaskIds : [],
    completedTaskSpecIds: Array.isArray(prd && prd.completedTaskSpecIds) ? prd.completedTaskSpecIds : [],
    updatedAt: prd && prd.updatedAt ? String(prd.updatedAt) : null,
  };
}

function normalizePromptHistory(history: ControlPlaneAgentChatMessagePayload['history'] | undefined) {
  return Array.isArray(history)
    ? history
      .map((message) => ({
        role: String(message && message.role || '') === 'agent' ? 'agent' : 'manager',
        content: String(message && message.content || '').trim(),
        createdAt: String(message && message.createdAt || ''),
      }))
      .filter((message) => message.content)
      .slice(-20)
    : [];
}

function buildStubAgentChatAnswer(
  repoId: string,
  payload: ControlPlaneAgentChatMessagePayload,
  snapshot: AnyRecord
) {
  const context = buildRepoChatContext(snapshot);
  const activePrd = context.activePrds[0];
  const queuedCount = context.queuedPrds.length;
  const runningAgents = context.agentStatuses
    .filter((agent) => String(agent && agent.workerStatus || '') === 'running')
    .length;
  const parts = [
    `Repo ${repoId} is on integration branch ${context.integrationBranch || 'unknown'}.`,
    activePrd
      ? `Active PRD: ${activePrd.title || activePrd.id}.`
      : 'There is no active PRD in the latest snapshot.',
    queuedCount > 0
      ? `${queuedCount} queued PRD${queuedCount === 1 ? '' : 's'} are waiting.`
      : 'No queued PRDs are waiting.',
    runningAgents > 0
      ? `${runningAgents} agent${runningAgents === 1 ? '' : 's'} are running.`
      : 'No agents are currently running.',
    `Manager asked: ${payload.prompt}`,
  ];
  return {
    answer: parts.join(' '),
  };
}

function normalizeChatPrdProposal(
  output: AnyRecord,
  answer: string,
  repoId: string,
  payload: ControlPlaneAgentChatMessagePayload
) {
  const source = {
    repoId,
    conversationId: payload.conversationId,
    messageId: payload.messageId,
    responseMessageId: payload.responseMessageId,
  };
  return normalizePrdProposal(output && output.prdProposal, source)
    || extractPrdProposalFromText(answer, source);
}

export {
  CHAT_RESPONSE_SCHEMA,
  answerControlPlaneAgentChat,
  buildAgentChatPrompt,
  buildRepoChatContext,
  normalizeChatPrdProposal,
};
