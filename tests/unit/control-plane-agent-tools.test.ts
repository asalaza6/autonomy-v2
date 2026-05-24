import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  collectAgentToolTokens,
  handleAgentToolRequest,
} from '../../src/server/control-plane/control-plane-agent-tools.js';
import {
  listJobs,
  setRepoStatus,
} from '../../src/server/control-plane/control-plane-store.js';

function makeRoot() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-agent-tools-'));
  setRepoStatus(rootDir, 'frontend', { ok: true }, {
    repoId: 'frontend',
    label: 'Frontend',
  });
  return rootDir;
}

function authorizedHeaders() {
  return {
    'x-autonomy-agent-key': 'tool-token',
  };
}

test('agent tools reject missing or invalid auth tokens', () => {
  const rootDir = makeRoot();
  const env = {
    AUTONOMY_AGENT_TOOLS_TOKEN: 'tool-token',
  } as NodeJS.ProcessEnv;

  const missing = handleAgentToolRequest(rootDir, {
    method: 'GET',
    pathname: '/api/agent-tools/status',
    headers: {},
    env,
  });
  const invalid = handleAgentToolRequest(rootDir, {
    method: 'GET',
    pathname: '/api/agent-tools/status',
    headers: { 'x-autonomy-agent-key': 'wrong' },
    env,
  });

  assert.equal(missing.statusCode, 401);
  assert.equal(invalid.statusCode, 401);
});

test('agent tools can discover token env names from custom-agent config', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-agent-tools-config-'));
  const configDir = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'control-plane.json'), `${JSON.stringify({
    schemaVersion: 1,
    repoId: 'frontend',
    spawnCustomAgents: ['prompts/autonomous/v2/config/feedback-bots.json'],
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(configDir, 'feedback-bots.json'), `${JSON.stringify({
    schemaVersion: 1,
    kind: 'feedback-bots',
    agentTools: {
      autonomy: {
        baseUrl: 'https://autonomy.example/api/agent-tools',
        authHeader: 'x-autonomy-agent-key',
      },
    },
    agents: [
      {
        id: 'feedback-bot',
        tools: {
          autonomy: {
            authEnv: 'FEEDBACK_BOT_AUTONOMY_TOKEN',
          },
        },
      },
    ],
  }, null, 2)}\n`, 'utf8');

  const tokens = collectAgentToolTokens(rootDir, {
    FEEDBACK_BOT_AUTONOMY_TOKEN: 'configured-token',
  } as NodeJS.ProcessEnv);

  assert.deepEqual(tokens, ['configured-token']);
});

test('agent tool PRD propose queues the normal prd:add control-plane job', () => {
  const rootDir = makeRoot();
  const env = {
    AUTONOMY_AGENT_TOOLS_TOKEN: 'tool-token',
  } as NodeJS.ProcessEnv;

  const result = handleAgentToolRequest(rootDir, {
    method: 'POST',
    pathname: '/api/agent-tools/prd/propose',
    headers: authorizedHeaders(),
    env,
    body: {
      repoId: 'frontend',
      id: 'prd-feedback-1',
      title: 'Feedback request',
      priority: 'highest',
      specification: 'Turn the customer feedback into a scoped PRD.',
    },
  });

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.job.type, 'prd:add');
  assert.equal(result.payload.job.repoId, 'frontend');
  assert.equal(result.payload.job.payload.priority, 'highest');
  assert.equal(listJobs(rootDir, { type: 'prd:add' as any }).length, 1);
});

test('agent tool PRD reset queues the normal prd:reset control-plane job', () => {
  const rootDir = makeRoot();
  const env = {
    AUTONOMY_AGENT_TOOLS_TOKEN: 'tool-token',
  } as NodeJS.ProcessEnv;

  const result = handleAgentToolRequest(rootDir, {
    method: 'POST',
    pathname: '/api/agent-tools/prd/reset',
    headers: authorizedHeaders(),
    env,
    body: {
      repoId: 'frontend',
      confirmPrdId: 'prd-active-1',
      reason: 'Active PRD is frozen after all agent queues drained.',
    },
  });

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.job.type, 'prd:reset');
  assert.equal(result.payload.job.repoId, 'frontend');
  assert.equal(result.payload.job.payload.confirmPrdId, 'prd-active-1');
  assert.equal(listJobs(rootDir, { type: 'prd:reset' as any }).length, 1);
});

test('agent tool PRD priority queues the normal prd:priority control-plane job', () => {
  const rootDir = makeRoot();
  const env = {
    AUTONOMY_AGENT_TOOLS_TOKEN: 'tool-token',
  } as NodeJS.ProcessEnv;

  const result = handleAgentToolRequest(rootDir, {
    method: 'POST',
    pathname: '/api/agent-tools/prd/priority',
    headers: authorizedHeaders(),
    env,
    body: {
      repoId: 'frontend',
      prdId: 'prd-queued-1',
      priority: 'highest',
      reason: 'Escalated feedback.',
    },
  });

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.job.type, 'prd:priority');
  assert.equal(result.payload.job.repoId, 'frontend');
  assert.equal(result.payload.job.payload.prdId, 'prd-queued-1');
  assert.equal(result.payload.job.payload.priority, 'highest');
  assert.equal(listJobs(rootDir, { type: 'prd:priority' as any }).length, 1);
});

test('agent tool deploy queues the normal deploy control-plane job', () => {
  const rootDir = makeRoot();
  const env = {
    AUTONOMY_AGENT_TOOLS_TOKEN: 'tool-token',
  } as NodeJS.ProcessEnv;

  const result = handleAgentToolRequest(rootDir, {
    method: 'POST',
    pathname: '/api/agent-tools/deploy',
    headers: authorizedHeaders(),
    env,
    body: {
      repoId: 'frontend',
    },
  });

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.job.type, 'deploy');
  assert.equal(result.payload.job.repoId, 'frontend');
  assert.equal(listJobs(rootDir, { type: 'deploy' as any }).length, 1);
});

test('agent tool package-update queues the normal package:update control-plane job', () => {
  const rootDir = makeRoot();
  const env = {
    AUTONOMY_AGENT_TOOLS_TOKEN: 'tool-token',
  } as NodeJS.ProcessEnv;

  const result = handleAgentToolRequest(rootDir, {
    method: 'POST',
    pathname: '/api/agent-tools/package-update',
    headers: authorizedHeaders(),
    env,
    body: {
      repoId: 'frontend',
    },
  });

  assert.equal(result.statusCode, 201);
  assert.equal(result.payload.job.type, 'package:update');
  assert.equal(result.payload.job.repoId, 'frontend');
  assert.equal(listJobs(rootDir, { type: 'package:update' as any }).length, 1);
});

test('agent tools expose status, PRD check, and job lookup', () => {
  const rootDir = makeRoot();
  const env = {
    AUTONOMY_AGENT_TOOLS_TOKEN: 'tool-token',
  } as NodeJS.ProcessEnv;
  const propose = handleAgentToolRequest(rootDir, {
    method: 'POST',
    pathname: '/api/agent-tools/prd/propose',
    headers: authorizedHeaders(),
    env,
    body: {
      repoId: 'frontend',
      id: 'prd-feedback-2',
      title: 'Feedback request two',
      requirements: ['Create a queued PRD.'],
    },
  });
  const jobId = propose.payload.job.id;

  const status = handleAgentToolRequest(rootDir, {
    method: 'GET',
    pathname: '/api/agent-tools/status',
    searchParams: new URLSearchParams({ repoId: 'frontend' }),
    headers: authorizedHeaders(),
    env,
  });
  const check = handleAgentToolRequest(rootDir, {
    method: 'POST',
    pathname: '/api/agent-tools/prd/check',
    headers: authorizedHeaders(),
    env,
    body: {
      repoId: 'frontend',
      id: 'prd-feedback-2',
    },
  });
  const lookup = handleAgentToolRequest(rootDir, {
    method: 'GET',
    pathname: `/api/agent-tools/jobs/${encodeURIComponent(jobId)}`,
    headers: authorizedHeaders(),
    env,
  });

  assert.equal(status.statusCode, 200);
  assert.equal(status.payload.repoStatus.repoId, 'frontend');
  assert.equal(check.payload.existingJobs.length, 1);
  assert.equal(lookup.payload.job.id, jobId);
});
