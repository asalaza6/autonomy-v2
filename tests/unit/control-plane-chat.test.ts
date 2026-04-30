import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import {
  CHAT_RESPONSE_SCHEMA,
  answerControlPlaneAgentChat,
  buildAgentChatPrompt,
  normalizeChatPrdProposal,
  readProjectContextForChatPrompt,
} from '../../src/server/control-plane/control-plane-chat.js';
import {
  buildRepoAssistantGithubPromptContext,
  resolveRepoAssistantGithubCapability,
} from '../../src/server/control-plane/control-plane-github.js';
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
  resetControlPlaneStateCache,
  setRepoStatus,
} from '../../src/server/control-plane/control-plane-store.js';
import { validatePrdAddSubmission } from '../../src/server/control-plane/control-plane-validation.js';

test('control plane chat structured output schema supports optional PRD proposals', () => {
  const schemaProperties = Object.keys(CHAT_RESPONSE_SCHEMA.properties);

  assert.deepEqual(schemaProperties, ['answer', 'prdProposal']);
  assert.deepEqual(CHAT_RESPONSE_SCHEMA.required, ['answer', 'prdProposal']);
  assertStructuredOutputObjectRequirements(CHAT_RESPONSE_SCHEMA);
  assert.match(
    buildAgentChatPrompt('alpha', {
      repoId: 'alpha',
      conversationId: 'conversation-001',
      messageId: 'message-001',
      responseMessageId: 'message-002',
      prompt: 'Hello',
    }, {}),
    /Set prdProposal to null/
  );
});

test('control plane chat prompt includes project context for a first-turn conversation', () => {
  const prompt = buildAgentChatPrompt('alpha', {
    repoId: 'alpha',
    conversationId: 'conversation-001',
    messageId: 'message-001',
    responseMessageId: 'message-002',
    prompt: 'Summarize the repo.',
    history: [],
  }, {}, '# Project Context\n\nRepo default: dev', {
    available: true,
    status: 'enabled',
    statusLabel: 'GitHub access ready',
    detail: 'Validated GitHub read access for asalaza6/autonomy-v2#27.',
    authEnvKeys: ['GITHUB_TOKEN', 'GH_TOKEN'],
    authFiles: ['.env.autonomy'],
    allowedHosts: ['api.github.com'],
    repository: {
      owner: 'asalaza6',
      repo: 'autonomy-v2',
    },
    validation: {
      pullRequestNumber: 27,
      pullRequestSource: 'config',
    },
  });

  assert.match(prompt, /Project context:/);
  assert.match(prompt, /Repo default: dev/);
  assert.match(prompt, /Conversation history:\n\[\]/);
  assert.match(prompt, /Current manager message:\nSummarize the repo\./);
  assert.match(prompt, /GitHub PR inspection capability:/);
  assert.match(prompt, /api\.github\.com/);
  assert.match(prompt, /injected GitHub runtime auth/);
  assert.match(prompt, /\.env\.autonomy/);
  assert.match(prompt, /scripts\/repo-assistant-github-read\.js/);
  assert.match(prompt, /Do not use external GitHub connectors/);
  assert.match(prompt, /--repo asalaza6\/autonomy-v2 --pr 27 --json/);
  assert.match(prompt, /Do not mention failed refresh attempts/);
});

test('control plane chat project context loader degrades cleanly when the file is missing', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-context-'));

  await assert.doesNotReject(() => readProjectContextForChatPrompt(rootDir));
  assert.equal(await readProjectContextForChatPrompt(rootDir), null);

  const degradedPrompt = buildAgentChatPrompt('alpha', {
    repoId: 'alpha',
    conversationId: 'conversation-001',
    messageId: 'message-001',
    responseMessageId: 'message-002',
    prompt: 'Summarize the repo.',
  }, {}, null);

  assert.match(degradedPrompt, /project-context\.md was unavailable/i);
});

test('repo assistant GitHub prompt context stays secret-safe', () => {
  const context = buildRepoAssistantGithubPromptContext({
    available: false,
    status: 'invalid-token',
    statusLabel: 'GitHub token invalid',
    detail: 'The runtime GitHub token was rejected during repo assistant validation.',
    authEnvKeys: ['GITHUB_TOKEN', 'GH_TOKEN'],
    authFiles: ['.env.autonomy'],
    allowedHosts: ['api.github.com'],
    repository: {
      owner: 'asalaza6',
      repo: 'autonomy-v2',
    },
    validation: {
      pullRequestNumber: 27,
      pullRequestSource: 'override',
    },
  });

  assert.equal(context.status, 'invalid-token');
  assert.equal(context.authEnvKeys.includes('GITHUB_TOKEN'), true);
  assert.deepEqual(context.authFiles, ['.env.autonomy']);
  assert.doesNotMatch(JSON.stringify(context), /ghp_|github_pat_/);
});

test('control plane chat launches disabled GitHub sessions without inheriting host secrets', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-chat-env-'));
  const capturePath = path.join(rootDir, 'capture.json');
  const fakeCodexPath = path.join(rootDir, 'fake-codex.mjs');
  const originalCodexBin = process.env.AUTONOMY_CODEX_BIN;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  const originalUnrelatedSecret = process.env.UNRELATED_SECRET;

  execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/asalaza6/autonomy-v2.git'], {
    cwd: rootDir,
    stdio: 'ignore',
  });

  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    "import fs from 'fs';",
    'const args = process.argv.slice(2);',
    "const outputIndex = args.indexOf('--output-last-message');",
    'const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";',
    `const capturePath = ${JSON.stringify(capturePath)};`,
    'fs.writeFileSync(capturePath, JSON.stringify({',
    '  env: {',
    "    GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,",
    "    GH_TOKEN: process.env.GH_TOKEN || null,",
    "    UNRELATED_SECRET: process.env.UNRELATED_SECRET || null,",
    "    PATH: process.env.PATH || null,",
    '  },',
    '}, null, 2));',
    'fs.writeFileSync(outputPath, JSON.stringify({ answer: "ok", prdProposal: null }));',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  process.env.AUTONOMY_CODEX_BIN = fakeCodexPath;
  process.env.GITHUB_TOKEN = 'host-github-token';
  process.env.GH_TOKEN = 'host-gh-token';
  process.env.UNRELATED_SECRET = 'host-only-secret';

  try {
    const response: any = await answerControlPlaneAgentChat({
      repoRoot: rootDir,
      repoId: 'alpha',
      payload: {
        repoId: 'alpha',
        conversationId: 'conversation-001',
        messageId: 'message-001',
        responseMessageId: 'message-002',
        prompt: 'Summarize the repo.',
        history: [],
      },
      snapshot: {},
    }) as any;

    assert.equal(response.answer, 'ok');

    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(captured.env.GITHUB_TOKEN, null);
    assert.equal(captured.env.GH_TOKEN, null);
    assert.equal(captured.env.UNRELATED_SECRET, null);
    assert.equal(typeof captured.env.PATH, 'string');
  } finally {
    restoreEnv('AUTONOMY_CODEX_BIN', originalCodexBin);
    restoreEnv('GITHUB_TOKEN', originalGithubToken);
    restoreEnv('GH_TOKEN', originalGhToken);
    restoreEnv('UNRELATED_SECRET', originalUnrelatedSecret);
  }
});

test('control plane chat injects approved GitHub auth into enabled repo assistant sessions', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-chat-enabled-github-'));
  const capturePath = path.join(rootDir, 'capture.json');
  const fakeCodexPath = path.join(rootDir, 'fake-codex-enabled.mjs');
  const originalCodexBin = process.env.AUTONOMY_CODEX_BIN;
  const originalGithubToken = process.env.GITHUB_TOKEN;
  const originalGhToken = process.env.GH_TOKEN;
  const originalUnrelatedSecret = process.env.UNRELATED_SECRET;

  execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/asalaza6/autonomy-v2.git'], {
    cwd: rootDir,
    stdio: 'ignore',
  });
  fs.writeFileSync(path.join(rootDir, '.env.autonomy'), 'GITHUB_TOKEN=approved-chat-token\n', 'utf8');

  resolveRepoAssistantGithubCapability(rootDir, {
    validationPullNumber: 27,
    includePullRequestData: true,
    githubApiRunner(args, options) {
      assert.equal(options.token, 'approved-chat-token');
      if (args[0] === 'repos/asalaza6/autonomy-v2') {
        return JSON.stringify({
          private: false,
          visibility: 'public',
          default_branch: 'main',
        });
      }
      if (args[0] === 'repos/asalaza6/autonomy-v2/pulls/27') {
        return JSON.stringify({
          number: 27,
          title: 'Validation PR',
          state: 'open',
          html_url: 'https://github.com/asalaza6/autonomy-v2/pull/27',
          user: { login: 'asalaza6' },
          base: { ref: 'main' },
          head: { ref: 'feature/validation' },
        });
      }
      if (args[0].includes('/files?per_page=100') || args[0].includes('/comments?per_page=100') || args[0].includes('/reviews?per_page=100')) {
        return '[]';
      }
      if (args[0] === 'graphql') {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                },
              },
            },
          },
        });
      }
      throw new Error(`Unexpected route: ${args[0]}`);
    },
  });

  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    "import fs from 'fs';",
    'const args = process.argv.slice(2);',
    "const outputIndex = args.indexOf('--output-last-message');",
    'const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";',
    `const capturePath = ${JSON.stringify(capturePath)};`,
    'fs.writeFileSync(capturePath, JSON.stringify({',
    '  env: {',
    "    GITHUB_TOKEN: process.env.GITHUB_TOKEN || null,",
    "    GH_TOKEN: process.env.GH_TOKEN || null,",
    "    UNRELATED_SECRET: process.env.UNRELATED_SECRET || null,",
    "    PATH: process.env.PATH || null,",
    '  },',
    '}, null, 2));',
    'fs.writeFileSync(outputPath, JSON.stringify({ answer: "ok", prdProposal: null }));',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  process.env.AUTONOMY_CODEX_BIN = fakeCodexPath;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  process.env.UNRELATED_SECRET = 'host-only-secret';

  try {
    const response: any = await answerControlPlaneAgentChat({
      repoRoot: rootDir,
      repoId: 'alpha',
      payload: {
        repoId: 'alpha',
        conversationId: 'conversation-001',
        messageId: 'message-001',
        responseMessageId: 'message-002',
        prompt: 'Inspect the validation PR.',
        history: [],
      },
      snapshot: {},
    }) as any;

    assert.equal(response.answer, 'ok');

    const captured = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
    assert.equal(captured.env.GITHUB_TOKEN, 'approved-chat-token');
    assert.equal(captured.env.GH_TOKEN, 'approved-chat-token');
    assert.equal(captured.env.UNRELATED_SECRET, null);
    assert.equal(typeof captured.env.PATH, 'string');
  } finally {
    restoreEnv('AUTONOMY_CODEX_BIN', originalCodexBin);
    restoreEnv('GITHUB_TOKEN', originalGithubToken);
    restoreEnv('GH_TOKEN', originalGhToken);
    restoreEnv('UNRELATED_SECRET', originalUnrelatedSecret);
  }
});


test('control plane chat falls back to history continuity when a stored resume session is stale', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-chat-resume-fallback-'));
  const capturePath = path.join(rootDir, 'capture.jsonl');
  const fakeCodexPath = path.join(rootDir, 'fake-codex-resume.mjs');
  const originalCodexBin = process.env.AUTONOMY_CODEX_BIN;

  fs.writeFileSync(fakeCodexPath, [
    '#!/usr/bin/env node',
    "import fs from 'fs';",
    'const args = process.argv.slice(2);',
    "const outputIndex = args.indexOf('--output-last-message');",
    'const outputPath = outputIndex >= 0 ? args[outputIndex + 1] : "";',
    "const resumeIndex = args.indexOf('resume');",
    'const resumeSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : "";',
    `const capturePath = ${JSON.stringify(capturePath)};`,
    'fs.appendFileSync(capturePath, JSON.stringify({ resumeSessionId, args }) + "\\n");',
    'if (resumeSessionId) {',
    "  console.error('unknown conversation');",
    '  process.exit(1);',
    '}',
    'fs.writeFileSync(outputPath, JSON.stringify({ answer: "Recovered from history.", prdProposal: null }));',
    'console.log(JSON.stringify({ conversation_id: "codex-history-002" }));',
  ].join('\n'), 'utf8');
  fs.chmodSync(fakeCodexPath, 0o755);

  process.env.AUTONOMY_CODEX_BIN = fakeCodexPath;

  try {
    const response: any = await answerControlPlaneAgentChat({
      repoRoot: rootDir,
      repoId: 'alpha',
      payload: {
        repoId: 'alpha',
        conversationId: 'conversation-001',
        messageId: 'message-001',
        responseMessageId: 'message-002',
        prompt: 'Continue the last thread.',
        resumeSessionId: 'stale-session-001',
        history: [
          { role: 'manager', content: 'What is next?', createdAt: '2026-04-28T00:00:00.000Z' },
          { role: 'agent', content: 'Open a PRD.', createdAt: '2026-04-28T00:00:01.000Z' },
        ],
      },
      snapshot: {},
    });

    assert.equal(response.answer, 'Recovered from history.');
    assert.equal(response.conversationId, 'codex-history-002');
    assert.equal(response.continuityMode, 'history-only');
    assert.match(String(response.continuityError || ''), /Codex CLI failed/);

    const attempts = fs.readFileSync(capturePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].resumeSessionId, 'stale-session-001');
    assert.equal(attempts[1].resumeSessionId, '');
  } finally {
    restoreEnv('AUTONOMY_CODEX_BIN', originalCodexBin);
  }
});

function assertStructuredOutputObjectRequirements(schema: any, path = 'schema') {
  if (!schema || typeof schema !== 'object') {
    return;
  }

  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    const propertyNames = Object.keys(schema.properties).sort();
    const required = Array.isArray(schema.required) ? [...schema.required].sort() : [];
    assert.deepEqual(required, propertyNames, `${path}.required must include every property`);
  }

  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, value] of Object.entries(schema.properties)) {
      assertStructuredOutputObjectRequirements(value, `${path}.properties.${key}`);
    }
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[keyword])) {
      schema[keyword].forEach((entry: any, index: number) => {
        assertStructuredOutputObjectRequirements(entry, `${path}.${keyword}.${index}`);
      });
    }
  }

  if (schema.items) {
    assertStructuredOutputObjectRequirements(schema.items, `${path}.items`);
  }
}

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

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === 'undefined') {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

test('control plane chat parses machine-readable PRD proposal blocks from answer text', () => {
  const proposal = extractPrdProposalFromText(`
Here is the draft I recommend.

\`\`\`autonomy-prd-proposal
{
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

test('control plane chat ignores unmarked PRD-shaped JSON status summaries in answer text', () => {
  const statusSummary = {
    title: 'Existing PRD: Add chat-generated PRD drafts',
    status: 'active',
    problem: 'This describes already queued work.',
    goal: 'Show the current queue state without creating a new PRD.',
    requirements: ['Render a review state', 'Keep manual submission'],
    acceptanceCriteria: ['The existing PRD remains visible'],
    verification: ['No new PRD is created from status output'],
    updatedAt: '2026-04-21T08:00:00.000Z',
  };
  const statusAnswer = `
The current PRD state is:

\`\`\`json
${JSON.stringify(statusSummary, null, 2)}
\`\`\`
`;

  assert.equal(extractPrdProposalFromText(JSON.stringify(statusSummary)), null);
  assert.equal(extractPrdProposalFromText(statusAnswer), null);
  assert.equal(
    normalizeChatPrdProposal({ answer: statusAnswer }, statusAnswer, 'alpha', {
      repoId: 'alpha',
      conversationId: 'chat-1',
      messageId: 'msg-manager',
      responseMessageId: 'msg-agent',
      prompt: 'What is the current PRD state?',
    }),
    null
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

test('control plane chat persistence survives hosted restart recovery and reuses stored Codex conversation ids', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-plane-chat-persisted-'));
  const originalPersist = process.env.AUTONOMY_CONTROL_PLANE_PERSIST;
  const originalDyno = process.env.DYNO;

  process.env.AUTONOMY_CONTROL_PLANE_PERSIST = '';
  process.env.DYNO = 'web.1';

  try {
    const first = queueAgentChatMessage(rootDir, {
      repoId: 'alpha',
      prompt: 'Summarize the repo state.',
    });

    completeJob(rootDir, first.job.id, {
      status: 'completed',
      result: {
        answer: 'The repo is idle.',
        conversationId: 'codex-session-001',
        continuityMode: 'codex-session',
      },
    });

    resetControlPlaneStateCache(rootDir);
    const reloaded = loadControlPlaneState(rootDir);
    assert.equal(reloaded.conversations.alpha[0].id, first.conversation.id);
    assert.equal(reloaded.conversations.alpha[0].codexConversationId, 'codex-session-001');
    assert.equal(reloaded.conversations.alpha[0].continuityMode, 'codex-session');
    assert.equal(reloaded.conversations.alpha[0].messages.length, 2);

    const second = queueAgentChatMessage(rootDir, {
      repoId: 'alpha',
      conversationId: first.conversation.id,
      prompt: 'Continue the same conversation.',
    });

    assert.equal(second.conversation.id, first.conversation.id);
    assert.equal((second.job.payload as any).resumeSessionId, 'codex-session-001');
    assert.equal(second.conversation.messages.length, 4);

    resetControlPlaneStateCache(rootDir);
    const persisted = JSON.parse(fs.readFileSync(path.join(rootDir, '.autonomy', 'control-plane', 'state.json'), 'utf8'));
    assert.equal(persisted.conversations.alpha[0].id, first.conversation.id);
    assert.equal(persisted.conversations.alpha[0].messages[3].status, 'queued');
  } finally {
    restoreEnv('AUTONOMY_CONTROL_PLANE_PERSIST', originalPersist);
    restoreEnv('DYNO', originalDyno);
    resetControlPlaneStateCache(rootDir);
  }
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
