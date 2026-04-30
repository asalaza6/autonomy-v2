import fs from 'node:fs/promises';
import path from 'node:path';

import { runCodexStructured } from '../../codex/cli.js';
import type { AnyRecord, ControlPlaneAgentChatMessagePayload } from '../../types.js';
import {
  extractPrdProposalFromText,
  normalizePrdProposal,
} from './control-plane-prd-proposal.js';
import {
  buildRepoAssistantGithubCodexConfigOverrides,
  buildRepoAssistantGithubSessionEnv,
  buildRepoAssistantGithubPromptContext,
  resolveRepoAssistantGithubCapability,
} from './control-plane-github.js';
import { readControlPlaneConfig } from './control-plane-config.js';

const CHAT_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'prdProposal'],
  properties: {
    answer: {
      type: 'string',
    },
    prdProposal: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'title',
            'problem',
            'goal',
            'requirements',
            'acceptanceCriteria',
            'verification',
            'priority',
          ],
          properties: {
            title: { type: 'string' },
            problem: { type: ['string', 'null'] },
            goal: { type: ['string', 'null'] },
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
            priority: { type: ['string', 'null'] },
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

  const projectContext = await readProjectContextForChatPrompt(repoRoot);
  const controlPlaneConfig = readControlPlaneConfig(repoRoot);
  const githubCapability = resolveRepoAssistantGithubCapability(repoRoot, {
    includePullRequestData: true,
    configuredValidationPullNumber: controlPlaneConfig && typeof controlPlaneConfig.repoAssistantValidationPullRequest === 'number'
      ? controlPlaneConfig.repoAssistantValidationPullRequest
      : null,
  });
  const repoAssistantEnv = githubCapability.available === true
    ? buildRepoAssistantGithubSessionEnv(repoRoot, githubCapability)
    : {};
  const prompt = buildAgentChatPrompt(repoId, payload, snapshot, projectContext, githubCapability);
  const configOverrides = githubCapability.available === true
    ? buildRepoAssistantGithubCodexConfigOverrides()
    : [];
  const requestedResumeSessionId = String(payload.resumeSessionId || '').trim();
  const runChat = (resumeSessionId = '') => runCodexStructured({
    cwd: repoRoot,
    readOnly: true,
    schema: CHAT_RESPONSE_SCHEMA,
    prompt,
    resumeSessionId,
    captureConversationId: true,
    env: repoAssistantEnv,
    inheritHostEnv: false,
    configOverrides,
  });

  let output: AnyRecord;
  let continuityMode: 'history-only' | 'codex-session' = requestedResumeSessionId ? 'codex-session' : 'history-only';
  let continuityError = '';
  try {
    output = await runChat(requestedResumeSessionId);
  } catch (error) {
    if (!requestedResumeSessionId) {
      throw error;
    }
    continuityMode = 'history-only';
    continuityError = error instanceof Error ? error.message : String(error);
    output = await runChat('');
  }

  const answer = String(output && output.answer || '').trim();
  const prdProposal = normalizeChatPrdProposal(output, answer, repoId, payload);
  const returnedConversationId = String(output && output.conversationId || '').trim();
  return {
    answer: answer || 'I could not produce a useful answer for that repo question.',
    conversationId: returnedConversationId || undefined,
    continuityMode: continuityError
      ? 'history-only'
      : (returnedConversationId ? 'codex-session' : continuityMode),
    continuityError: continuityError || undefined,
    ...(prdProposal ? { prdProposal } : {}),
  };
}

function buildAgentChatPrompt(
  repoId: string,
  payload: ControlPlaneAgentChatMessagePayload,
  snapshot: AnyRecord,
  projectContext?: string | null,
  githubCapability?: AnyRecord | null,
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
    '- Never print raw secret values or ask the manager to paste GitHub tokens into the chat.',
    '- Do not inspect local env files for credentials. Use the injected GitHub runtime auth only when the GitHub capability below is enabled.',
    '',
    `Repo id: ${repoId}`,
    '',
    'Project context:',
    projectContext
      ? projectContext
      : 'Project context file prompts/autonomous/v2/project-context.md was unavailable. Continue with the repo status and conversation context.',
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
    'GitHub PR inspection capability:',
    JSON.stringify(buildRepoAssistantGithubPromptContext(githubCapability), null, 2),
    '',
    ...buildRepoAssistantGithubUsageGuidance(githubCapability),
    '',
    'When GitHub PR inspection is enabled:',
    '- Do not use external GitHub connectors or MCP GitHub tools for repo-assistant PR inspection. Use the provided GitHub capability data and the local repo script only.',
    '- Use that script for PR metadata, changed files, commits, issue comments, reviews, and unresolved review threads instead of relying only on the snapshot.',
    '- Limit direct GitHub network reads to api.github.com endpoints needed for pull request metadata, changed files, commits, issue comments, reviews, and review threads.',
    '- If GitHub access is not enabled, do not pretend live PR inspection succeeded; explain the reported status instead.',
    '',
    'Return JSON only with answer and prdProposal fields. Set prdProposal to null unless you are recommending a new PRD.',
  ].join('\n');
}

function buildRepoAssistantGithubUsageGuidance(githubCapability?: AnyRecord | null) {
  const github = githubCapability && typeof githubCapability === 'object' ? githubCapability : {};
  const repository = github.repository && typeof github.repository === 'object'
    ? github.repository
    : null;
  const pullRequest = github.pullRequest && typeof github.pullRequest === 'object'
    ? github.pullRequest
    : null;
  const owner = repository && String(repository.owner || '').trim();
  const repo = repository && String(repository.repo || '').trim();
  const pullNumber = Number(pullRequest && pullRequest.number || 0) || Number(github.validation && github.validation.pullRequestNumber || 0) || null;
  const lines = [
    'GitHub usage guidance:',
  ];
  if (pullRequest && pullNumber) {
    lines.push(`- The \`pullRequest\` object in the GitHub capability block is already a live GitHub read for PR #${pullNumber}. Use it directly when the manager asks about that PR.`);
    lines.push(`- For questions about PR #${pullNumber}, do not rerun the local GitHub read script unless the manager explicitly asks for a refresh or newer remote state than the provided bundle.`);
  }
  if (owner && repo && pullNumber) {
    lines.push(`- If you need to refresh or inspect that same PR again, run \`node scripts/repo-assistant-github-read.js --repo ${owner}/${repo} --pr ${pullNumber} --json\`.`);
  } else if (owner && repo) {
    lines.push(`- If you need live PR data, run \`node scripts/repo-assistant-github-read.js --repo ${owner}/${repo} --pr <number> --json\`.`);
  } else {
    lines.push('- If you need live PR data, run `node scripts/repo-assistant-github-read.js --repo owner/name --pr <number> --json`.');
  }
  lines.push('- Prefer the provided live pullRequest bundle over extra commands when it already answers the manager question.');
  lines.push('- Do not mention failed refresh attempts when the provided live pullRequest bundle already answers the question.');
  return lines;
}

async function readProjectContextForChatPrompt(repoRoot: string) {
  try {
    const projectContextPath = path.join(repoRoot, 'prompts', 'autonomous', 'v2', 'project-context.md');
    const content = await fs.readFile(projectContextPath, 'utf8');
    const normalized = content.trim();
    return normalized || null;
  } catch {
    return null;
  }
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
  buildRepoAssistantGithubUsageGuidance,
  buildRepoChatContext,
  normalizeChatPrdProposal,
  readProjectContextForChatPrompt,
};
