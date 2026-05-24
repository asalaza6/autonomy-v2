import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildCustomAgentNetworkConfigOverrides,
  buildCustomAgentPrompt,
  main,
} from '../../src/server/custom-agents/custom-agent-worker.js';

test('custom agent worker allowlists configured control hosts', () => {
  const overrides = buildCustomAgentNetworkConfigOverrides(
    {
      controlPanel: {
        baseUrl: 'https://whispering-everglades-64534-f5ea8b76f95d.herokuapp.com/v0/agent-control',
      },
    },
    {
      AUTONOMY_CONTROL_PLANE_SERVER_URL: 'https://autonomy-v2-mgr-703614-45205c824326.herokuapp.com',
    } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(overrides, [
    'sandbox_workspace_write.network_access=true',
    'experimental_network.allowed_domains=["whispering-everglades-64534-f5ea8b76f95d.herokuapp.com","autonomy-v2-mgr-703614-45205c824326.herokuapp.com"]',
    'experimental_network.open_world_enabled=false',
  ]);
});

test('custom agent worker omits empty network allowlist config', () => {
  const overrides = buildCustomAgentNetworkConfigOverrides({}, {} as NodeJS.ProcessEnv);

  assert.deepEqual(overrides, []);
});

test('custom agent worker deduplicates repeated network allowlist hosts', () => {
  const overrides = buildCustomAgentNetworkConfigOverrides(
    {
      controlPanel: {
        baseUrl: 'https://control.example/v0/agent-control',
      },
    },
    {
      AUTONOMY_CONTROL_PLANE_SERVER_URL: 'https://control.example/dashboard',
    } as NodeJS.ProcessEnv,
  );

  assert.deepEqual(overrides, [
    'sandbox_workspace_write.network_access=true',
    'experimental_network.allowed_domains=["control.example"]',
    'experimental_network.open_world_enabled=false',
  ]);
});

test('custom agent worker allowlists configured tool hosts', () => {
  const overrides = buildCustomAgentNetworkConfigOverrides(
    {
      controlPanel: {
        baseUrl: 'https://control.example/v0/agent-control',
      },
      tools: {
        autonomy: {
          baseUrl: 'https://autonomy.example/api/agent-tools',
        },
      },
    },
    {} as NodeJS.ProcessEnv,
  );

  assert.deepEqual(overrides, [
    'sandbox_workspace_write.network_access=true',
    'experimental_network.allowed_domains=["control.example","autonomy.example"]',
    'experimental_network.open_world_enabled=false',
  ]);
});

test('custom agent prompt includes tool metadata without token values', () => {
  const prompt = buildCustomAgentPrompt({
    rootDir: process.cwd(),
    agent: { id: 'feedback-bot' },
    target: { type: 'project', id: 'frontend' },
    workspacePath: '/tmp/feedback-bot',
    controlPanel: {},
    context: {},
    tools: {
      autonomy: {
        baseUrl: 'https://autonomy.example/api/agent-tools',
        authHeader: 'x-autonomy-agent-key',
        authEnv: 'FEEDBACK_BOT_AUTONOMY_TOKEN',
        value: 'secret-tool-token',
      },
    },
  });

  assert.match(prompt, /"autonomy"/);
  assert.match(prompt, /FEEDBACK_BOT_AUTONOMY_TOKEN/);
  assert.doesNotMatch(prompt, /secret-tool-token/);
});

test('custom agent worker uses configured prompt role in wrapper text', () => {
  const prompt = buildCustomAgentPrompt({
    rootDir: process.cwd(),
    promptRole: 'trading strategy operator agent',
    agent: { id: 'strategy-agent' },
    target: { type: 'strategy', id: 'target-1' },
    workspacePath: '/tmp/strategy-agent',
    controlPanel: {},
    context: {},
  });

  assert.match(prompt, /^You are a trading strategy operator agent\./);
  assert.doesNotMatch(prompt, /repo-defined custom Autonomy agent/);
});

test('custom agent worker lets agent prompt intro override prompt role', () => {
  const prompt = buildCustomAgentPrompt({
    rootDir: process.cwd(),
    promptRole: 'trading strategy operator agent',
    agent: {
      id: 'strategy-agent',
      promptIntro: 'You are the overnight crypto strategy operator.',
    },
    target: { type: 'strategy', id: 'target-1' },
    workspacePath: '/tmp/strategy-agent',
    controlPanel: {},
    context: {},
  });

  assert.match(prompt, /^You are the overnight crypto strategy operator\./);
  assert.doesNotMatch(prompt, /^You are a trading strategy operator agent\./);
});

test('custom agent prompt can allow explicit runtime-state recovery', () => {
  const prompt = buildCustomAgentPrompt({
    rootDir: process.cwd(),
    agent: { id: 'pressure-bot' },
    target: { type: 'project', id: 'fixture' },
    workspacePath: '/tmp/pressure-bot',
    controlPanel: {},
    context: {
      allowRuntimeStateChanges: true,
      workspaceReadWrite: ['.autonomy/helper-state.json'],
    },
  });

  assert.match(prompt, /"allowRuntimeStateChanges": true/);
  assert.match(prompt, /Repository runtime state changes are allowed only when explicitly required for local recovery/);
  assert.doesNotMatch(prompt, /Do not commit, push, merge, or change repository runtime state/);
});

test('custom agent worker runs command lifecycle phases and records invocation state', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agent-worker-'));
  const invocationDir = path.join(rootDir, '.autonomy', 'runtime', 'custom-agents', 'strategy-agent-target-1', 'start');
  const workspacePath = path.join(rootDir, '.autonomy', 'workspace');
  const contextPath = path.join(invocationDir, 'context.json');
  const scriptsDir = path.join(rootDir, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.autonomy', 'runtime', 'state'), { recursive: true });
  fs.mkdirSync(invocationDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json'),
    JSON.stringify({
      workers: {},
      customAgents: {
        'strategy-agent:target-1': {
          agentId: 'strategy-agent',
          status: 'running',
          running: true,
          invocationId: 'inv-1',
        },
      },
      customAgentInvocations: {
        'inv-1': {
          invocationId: 'inv-1',
          agentId: 'strategy-agent',
          status: 'running',
        },
      },
    }, null, 2),
    'utf8',
  );

  const environmentScript = path.join(scriptsDir, 'environment.js');
  const promptScript = path.join(scriptsDir, 'prompt.js');
  const finalizeScript = path.join(scriptsDir, 'finalize.js');
  const codexScript = path.join(scriptsDir, 'codex.js');
  fs.writeFileSync(environmentScript, `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(${JSON.stringify(path.join(invocationDir, 'environment.input.json'))}, JSON.stringify(input, null, 2));
process.stdout.write(JSON.stringify({ cwd: '.autonomy/prepared-workspace', environmentReady: true }));
`, 'utf8');
  fs.writeFileSync(promptScript, `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(${JSON.stringify(path.join(invocationDir, 'prompt.input.json'))}, JSON.stringify(input, null, 2));
process.stdout.write(JSON.stringify({ prompt: 'do the custom agent work' }));
`, 'utf8');
  fs.writeFileSync(finalizeScript, `
const fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(${JSON.stringify(path.join(invocationDir, 'finalize.input.json'))}, JSON.stringify(input, null, 2));
process.stdout.write(JSON.stringify({ finalized: true, runStatus: input.run.status }));
`, 'utf8');
  fs.writeFileSync(codexScript, '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ session_id: "custom-session-1" }) + "\\n"); process.exit(0); });\n', 'utf8');
  fs.chmodSync(codexScript, 0o755);

  fs.writeFileSync(contextPath, JSON.stringify({
    schemaVersion: 1,
    invocationId: 'inv-1',
    runtimeKey: 'strategy-agent:target-1',
    rootDir,
    startedAt: '2026-01-01T00:00:00.000Z',
    kind: 'strategy-agents',
    agent: { id: 'strategy-agent' },
    target: { type: 'strategy', id: 'target-1' },
    workspacePath,
    paths: {
      invocationDir,
      contextPath,
    },
    controlPanel: {},
    auth: {},
    tools: {},
    context: {},
    conversation: {
      mode: 'scoped',
      key: 'strategy-agent:target-1',
      scope: ['agent.id', 'target.id'],
      persist: true,
    },
    lifecycle: {
      environment: { command: 'node', args: [environmentScript], cwd: rootDir },
      prompt: { command: 'node', args: [promptScript], cwd: rootDir },
      finalize: { command: 'node', args: [finalizeScript], cwd: rootDir },
    },
    decision: { shouldRun: true, reason: 'test' },
  }, null, 2), 'utf8');

  const previousCodexBin = process.env.AUTONOMY_CODEX_BIN;
  process.env.AUTONOMY_CODEX_BIN = codexScript;
  try {
    await main(['run', '--context', contextPath]);
  } finally {
    if (typeof previousCodexBin === 'string') {
      process.env.AUTONOMY_CODEX_BIN = previousCodexBin;
    } else {
      delete process.env.AUTONOMY_CODEX_BIN;
    }
  }

  const environmentInput = JSON.parse(fs.readFileSync(path.join(invocationDir, 'environment.input.json'), 'utf8'));
  const promptInput = JSON.parse(fs.readFileSync(path.join(invocationDir, 'prompt.input.json'), 'utf8'));
  const finalizeInput = JSON.parse(fs.readFileSync(path.join(invocationDir, 'finalize.input.json'), 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json'), 'utf8'));

  assert.equal(environmentInput.phase, 'environment');
  assert.equal(environmentInput.repoRoot, rootDir);
  assert.equal(promptInput.previous.environment.environmentReady, true);
  assert.equal(promptInput.workspace.cwd, path.join(rootDir, '.autonomy', 'prepared-workspace'));
  assert.equal(finalizeInput.run.status, 'completed');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].running, false);
  assert.equal(runtime.customAgents['strategy-agent:target-1'].conversationId, 'custom-session-1');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].conversationKey, 'strategy-agent:target-1');
  assert.equal(runtime.customAgents['strategy-agent:target-1'].conversations['strategy-agent:target-1'].conversationId, 'custom-session-1');
  assert.equal(runtime.customAgentInvocations['inv-1'].conversationKey, 'strategy-agent:target-1');
  assert.equal(runtime.customAgentInvocations['inv-1'].conversationId, 'custom-session-1');
  assert.equal(runtime.customAgentInvocations['inv-1'].status, 'completed');
  assert.equal(runtime.customAgentInvocations['inv-1'].lastResult.finalize.finalized, true);
  assert.equal(fs.existsSync(path.join(invocationDir, 'environment.command.json')), true);
});

test('custom agent worker resumes the previous Codex conversation', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agent-worker-resume-'));
  const invocationDir = path.join(rootDir, '.autonomy', 'runtime', 'custom-agents', 'feedback-bot-project', 'start');
  const workspacePath = path.join(rootDir, '.autonomy', 'workspace');
  const contextPath = path.join(invocationDir, 'context.json');
  const scriptsDir = path.join(rootDir, 'scripts');
  const argsPath = path.join(invocationDir, 'codex.args.json');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(path.join(rootDir, '.autonomy', 'runtime', 'state'), { recursive: true });
  fs.mkdirSync(invocationDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json'),
    JSON.stringify({
      workers: {},
      customAgents: {
        'feedback-bot:project': {
          agentId: 'feedback-bot',
          status: 'running',
          running: true,
          invocationId: 'inv-resume',
          conversationId: 'session-existing',
        },
      },
      customAgentInvocations: {
        'inv-resume': {
          invocationId: 'inv-resume',
          agentId: 'feedback-bot',
          status: 'running',
        },
      },
    }, null, 2),
    'utf8',
  );

  const codexScript = path.join(scriptsDir, 'codex.js');
  fs.writeFileSync(codexScript, `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2), null, 2));
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ session_id: 'session-existing' }) + '\\n');
});
`, 'utf8');
  fs.chmodSync(codexScript, 0o755);

  fs.writeFileSync(contextPath, JSON.stringify({
    schemaVersion: 1,
    invocationId: 'inv-resume',
    runtimeKey: 'feedback-bot:project',
    rootDir,
    startedAt: '2026-01-01T00:00:00.000Z',
    kind: 'feedback-bots',
    agent: { id: 'feedback-bot' },
    target: { type: 'project', id: 'project' },
    workspacePath,
    paths: {
      invocationDir,
      contextPath,
    },
    controlPanel: {},
    auth: {},
    tools: {},
    context: {},
    conversation: {
      mode: 'scoped',
      key: 'feedback-bot:project:task-123',
      scope: ['agent.id', 'target.id', 'decision.taskId'],
      resumeSessionId: 'session-existing',
      persist: true,
    },
    decision: { shouldRun: true, reason: 'test' },
  }, null, 2), 'utf8');

  const previousCodexBin = process.env.AUTONOMY_CODEX_BIN;
  process.env.AUTONOMY_CODEX_BIN = codexScript;
  try {
    await main(['run', '--context', contextPath]);
  } finally {
    if (typeof previousCodexBin === 'string') {
      process.env.AUTONOMY_CODEX_BIN = previousCodexBin;
    } else {
      delete process.env.AUTONOMY_CODEX_BIN;
    }
  }

  const args = JSON.parse(fs.readFileSync(argsPath, 'utf8'));
  const runtime = JSON.parse(fs.readFileSync(path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json'), 'utf8'));
  assert.equal(args.includes('resume'), true);
  assert.equal(args.includes('session-existing'), true);
  assert.equal(args.includes('--ephemeral'), false);
  assert.equal(runtime.customAgents['feedback-bot:project'].conversationId, 'session-existing');
  assert.equal(runtime.customAgents['feedback-bot:project'].conversations['feedback-bot:project:task-123'].conversationId, 'session-existing');
});
