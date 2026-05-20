#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';
import { runCodexExec } from '../../codex/cli.js';
import { acquireStateLock } from '../../lock/lock-main.js';
import { loadRuntime, writeRuntime } from '../orchestrator/orchestrator-state.js';
import { ensureDir, readJson, writeJson } from '../orchestrator/paths.js';

function parseCli(argv: string[]) {
  const options: Record<string, any> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (typeof next === 'undefined' || next.startsWith('--')) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return {
    command: positionals[0] || 'run',
    options,
  };
}

async function main(argv: string[] = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (command !== 'run') {
    throw new Error(`Unknown command "${command}". Use "run".`);
  }

  const contextPath = String(options.context || process.env.AUTONOMY_CUSTOM_AGENT_CONTEXT || '').trim();
  if (!contextPath) {
    throw new Error('Missing required option --context');
  }
  const runtimeContext: any = readJson(contextPath, {});
  runtimeContext.paths = {
    ...(runtimeContext.paths || {}),
    contextPath,
  };
  const rootDir = String(runtimeContext.rootDir || '').trim();
  const runtimeKey = String(runtimeContext.runtimeKey || '').trim();
  const workspacePath = String(runtimeContext.workspacePath || '').trim();
  if (!rootDir || !runtimeKey || !workspacePath) {
    throw new Error('Custom agent runtime context must include rootDir, runtimeKey, and workspacePath.');
  }
  ensureWorkspaceInsideRoot(rootDir, workspacePath);
  ensureDir(workspacePath);

  let result = null;
  let error = null;
  try {
    result = await runCustomAgent(runtimeContext);
  } catch (caughtError) {
    error = caughtError;
    throw caughtError;
  } finally {
    finalizeCustomAgentRuntime(rootDir, runtimeKey, result, error);
  }
}

async function runCustomAgent(runtimeContext) {
  if (process.env.AUTONOMY_CUSTOM_AGENT_STUB === '1') {
    return {
      ok: true,
      status: 'stubbed',
    };
  }

  const workspacePath = String(runtimeContext.workspacePath || '');
  const context = runtimeContext.context || {};
  const allowRuntimeStateChanges = context.allowRuntimeStateChanges === true;
  const auth = runtimeContext.auth || {};
  const controlPanel = runtimeContext.controlPanel || {};
  const tools = runtimeContext.tools || {};
  const env = {
    AUTONOMY_CUSTOM_AGENT_ID: String(runtimeContext.agent && runtimeContext.agent.id || ''),
    AUTONOMY_CUSTOM_AGENT_TARGET: JSON.stringify(runtimeContext.target || {}),
    AUTONOMY_CUSTOM_AGENT_WORKSPACE: workspacePath,
    AUTONOMY_CONTROL_PANEL_BASE_URL: String(controlPanel.baseUrl || ''),
    AUTONOMY_CONTROL_PANEL_AUTH_HEADER: String(controlPanel.authHeader || ''),
    AUTONOMY_CUSTOM_AGENT_TOOLS: JSON.stringify(buildPromptToolContext(tools)),
  };
  if (auth.envKey && auth.value) {
    env[String(auth.envKey)] = String(auth.value);
  }
  Object.values(tools || {}).forEach((tool: any) => {
    if (tool && tool.authEnv && tool.value) {
      env[String(tool.authEnv)] = String(tool.value);
    }
  });

  markCustomAgentInvocationPhase(runtimeContext, 'environment', {
    status: 'running',
  });
  const environmentResult = runLifecycleCommand(runtimeContext, 'environment', {
    workspacePath,
    env,
  }) || {};
  const preparedWorkspacePath = resolvePreparedWorkspacePath(runtimeContext.rootDir, workspacePath, environmentResult);
  ensureWorkspaceInsideRoot(runtimeContext.rootDir, preparedWorkspacePath);
  ensureDir(preparedWorkspacePath);

  markCustomAgentInvocationPhase(runtimeContext, 'prompt', {
    status: 'running',
    workspace: { cwd: preparedWorkspacePath },
  });
  const promptResult = runLifecycleCommand(runtimeContext, 'prompt', {
    workspacePath: preparedWorkspacePath,
    env,
    previous: {
      environment: environmentResult,
    },
  });
  const prompt = promptResult
    ? normalizePromptResult(runtimeContext.rootDir, promptResult)
    : buildCustomAgentPrompt({
        ...runtimeContext,
        workspacePath: preparedWorkspacePath,
        environment: environmentResult,
      });

  markCustomAgentInvocationPhase(runtimeContext, 'run', {
    status: 'running',
    workspace: { cwd: preparedWorkspacePath },
  });
  const result = await runCodexExec({
    cwd: preparedWorkspacePath,
    prompt,
    readOnly: false,
    sandboxMode: allowRuntimeStateChanges ? 'danger-full-access' : 'workspace-write',
    env,
    inheritHostEnv: true,
    configOverrides: buildCustomAgentNetworkConfigOverrides(runtimeContext, process.env),
  });
  const runResult = {
    ok: true,
    status: 'completed',
    conversationId: result.conversationId || '',
  };

  markCustomAgentInvocationPhase(runtimeContext, 'finalize', {
    status: 'running',
    workspace: { cwd: preparedWorkspacePath },
    run: runResult,
  });
  const finalizeResult = runLifecycleCommand(runtimeContext, 'finalize', {
    workspacePath: preparedWorkspacePath,
    env,
    previous: {
      environment: environmentResult,
      prompt: summarizePromptResult(promptResult),
    },
    run: runResult,
  });

  return {
    ok: true,
    status: 'completed',
    invocationId: String(runtimeContext.invocationId || ''),
    conversationId: runResult.conversationId,
    environment: environmentResult,
    finalize: finalizeResult || null,
  };
}

function runLifecycleCommand(runtimeContext, phase: string, options: any = {}) {
  const commandConfig = runtimeContext.lifecycle && runtimeContext.lifecycle[phase];
  if (!commandConfig) {
    return null;
  }
  const workspacePath = String(options.workspacePath || runtimeContext.workspacePath || '');
  const envelope = buildLifecycleEnvelope(runtimeContext, phase, {
    workspacePath,
    previous: options.previous || {},
    run: options.run || null,
  });
  const result = spawnSync(commandConfig.command, commandConfig.args || [], {
    cwd: commandConfig.cwd || runtimeContext.rootDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env || {}),
      ...(commandConfig.env || {}),
      AUTONOMY_CUSTOM_AGENT_PHASE: phase,
      AUTONOMY_CUSTOM_AGENT_INVOCATION_ID: String(runtimeContext.invocationId || ''),
      AUTONOMY_CUSTOM_AGENT_CONTEXT: String(runtimeContext.paths && runtimeContext.paths.contextPath || process.env.AUTONOMY_CUSTOM_AGENT_CONTEXT || ''),
    },
    input: `${JSON.stringify(envelope)}\n`,
    shell: commandConfig.shell === true,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: Number(commandConfig.timeoutMs || 30_000),
  });
  writeLifecycleCommandArtifacts(runtimeContext, phase, {
    command: commandConfig.displayCommand || commandConfig.command,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    signal: result.signal || null,
  });
  if (result.error) {
    throw new Error(`${phase} command failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${phase} command exited ${result.status}: ${collectCommandOutput(result.stderr, result.stdout, result.signal) || 'no output'}`);
  }
  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    return {};
  }
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new Error(`${phase} command must print JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${phase} command JSON must be an object`);
}

function buildLifecycleEnvelope(runtimeContext, phase: string, options: any = {}) {
  return {
    invocationId: String(runtimeContext.invocationId || ''),
    agentId: String(runtimeContext.agent && runtimeContext.agent.id || ''),
    agentType: String(runtimeContext.kind || runtimeContext.agent && runtimeContext.agent.type || ''),
    repoRoot: String(runtimeContext.rootDir || ''),
    phase,
    target: runtimeContext.target || {},
    workspace: {
      cwd: String(options.workspacePath || runtimeContext.workspacePath || ''),
    },
    paths: {
      invocationDir: String(runtimeContext.paths && runtimeContext.paths.invocationDir || ''),
      contextPath: String(runtimeContext.paths && runtimeContext.paths.contextPath || process.env.AUTONOMY_CUSTOM_AGENT_CONTEXT || ''),
    },
    decision: runtimeContext.decision || {},
    previous: options.previous || {},
    run: options.run || null,
  };
}

function resolvePreparedWorkspacePath(rootDir: string, fallbackWorkspacePath: string, environmentResult) {
  const raw = String(
    environmentResult && (
      environmentResult.cwd
      || environmentResult.workspacePath
      || environmentResult.workspace && environmentResult.workspace.cwd
    ) || fallbackWorkspacePath
  ).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
}

function normalizePromptResult(rootDir: string, promptResult) {
  const prompt = String(promptResult && promptResult.prompt || '').trim();
  if (prompt) {
    return prompt;
  }
  const promptPath = String(promptResult && promptResult.promptPath || '').trim();
  if (promptPath) {
    const resolvedPath = path.isAbsolute(promptPath) ? promptPath : path.resolve(rootDir, promptPath);
    return fs.readFileSync(resolvedPath, 'utf8');
  }
  throw new Error('prompt command must return prompt or promptPath');
}

function summarizePromptResult(promptResult) {
  if (!promptResult) {
    return null;
  }
  return {
    prompt: typeof promptResult.prompt === 'string' ? { length: promptResult.prompt.length } : undefined,
    promptPath: promptResult.promptPath || undefined,
  };
}

function writeLifecycleCommandArtifacts(runtimeContext, phase: string, payload) {
  const invocationDir = String(runtimeContext.paths && runtimeContext.paths.invocationDir || '').trim();
  if (!invocationDir) {
    return;
  }
  ensureDir(invocationDir);
  writeJson(path.join(invocationDir, `${phase}.command.json`), payload);
}

function markCustomAgentInvocationPhase(runtimeContext, phase: string, patch: any = {}) {
  const rootDir = String(runtimeContext.rootDir || '');
  const runtimeKey = String(runtimeContext.runtimeKey || '');
  const invocationId = String(runtimeContext.invocationId || runtimeKey);
  if (!rootDir || !runtimeKey || !invocationId) {
    return;
  }
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    runtime.customAgentInvocations = runtime.customAgentInvocations || {};
    runtime.customAgentInvocations[invocationId] = {
      invocationId,
      agentId: String(runtimeContext.agent && runtimeContext.agent.id || runtimeKey),
      runtimeKey,
      status: 'running',
      startedAt: String(runtimeContext.startedAt || runtimeContext.spawn && runtimeContext.spawn.startedAt || ''),
      ...(runtime.customAgentInvocations[invocationId] || {}),
      phase,
      updatedAt: new Date().toISOString(),
      target: runtimeContext.target || {},
      paths: runtimeContext.paths || {},
      ...patch,
    };
    runtime.customAgents = runtime.customAgents || {};
    if (runtime.customAgents[runtimeKey]) {
      runtime.customAgents[runtimeKey].phase = phase;
    }
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function buildCustomAgentNetworkConfigOverrides(runtimeContext, env: NodeJS.ProcessEnv = process.env) {
  const controlPanel = runtimeContext.controlPanel || {};
  const allowedDomains = uniqueStrings([
    extractHostname(controlPanel.baseUrl),
    ...Object.values(runtimeContext.tools || {}).map((tool: any) => extractHostname(tool && tool.baseUrl)),
    extractHostname(env.AUTONOMY_CONTROL_PLANE_SERVER_URL),
  ]);

  if (allowedDomains.length === 0) {
    return [];
  }

  return [
    'sandbox_workspace_write.network_access=true',
    `experimental_network.allowed_domains=${JSON.stringify(allowedDomains)}`,
    'experimental_network.open_world_enabled=false',
  ];
}

function extractHostname(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function buildCustomAgentPrompt(runtimeContext) {
  const context = runtimeContext.context || {};
  const globalReadOnly = Array.isArray(context.globalReadOnly) ? context.globalReadOnly : [];
  const workspaceReadWrite = Array.isArray(context.workspaceReadWrite) ? context.workspaceReadWrite : [];
  const allowRuntimeStateChanges = context.allowRuntimeStateChanges === true;
  const agent = runtimeContext.agent || {};
  const instructionText = [
    String(agent.instructions || '').trim(),
    readOptionalPromptFile(runtimeContext.rootDir, agent.prompt || agent.systemPrompt),
  ].filter(Boolean).join('\n\n');
  const runtimeStateRule = allowRuntimeStateChanges
    ? '- Repository runtime state changes are allowed only when explicitly required for local recovery by the agent instructions. Keep changes minimal, inspect before mutating, do not discard user/source work, and record the action taken.'
    : '- Do not commit, push, merge, or change repository runtime state.';

  return [
    instructionText,
    buildCustomAgentPromptIntro(runtimeContext),
    '',
    'Runtime context:',
    JSON.stringify({
      agentId: agent.id,
      kind: runtimeContext.kind || '',
      target: runtimeContext.target || {},
      workspacePath: runtimeContext.workspacePath,
      controlPanel: runtimeContext.controlPanel || {},
      tools: buildPromptToolContext(runtimeContext.tools || {}),
      workspaceReadWrite,
      allowRuntimeStateChanges,
      decision: runtimeContext.decision || {},
    }, null, 2),
    '',
    'Hard rules:',
    '- Treat the global context files below as read-only context.',
    '- Write only inside the configured workspace path.',
    '- Do not modify files outside the configured workspace.',
    '- Use the configured control-panel base URL and auth header when reporting or fetching work.',
    '- Use configured tools only through their listed base URLs, auth headers, and auth environment variables.',
    runtimeStateRule,
    '- Do not commit, push, or merge unless the agent instructions explicitly allow that exact operation.',
    '',
    'Read-only context files:',
    ...globalReadOnly.map((entry) => formatReadOnlyContextFile(entry)),
    '',
    'Writable workspace file names:',
    JSON.stringify(workspaceReadWrite, null, 2),
    '',
    'Run the custom-agent task for the configured target. No structured response is required.',
  ].filter((entry) => String(entry || '').length > 0).join('\n');
}

function buildPromptToolContext(tools) {
  return Object.fromEntries(Object.entries(tools || {}).map(([name, toolValue]) => {
    const tool: any = toolValue || {};
    return [name, {
      baseUrl: String(tool.baseUrl || '').trim(),
      authHeader: String(tool.authHeader || '').trim(),
      authEnv: String(tool.authEnv || '').trim(),
    }];
  }));
}

function buildCustomAgentPromptIntro(runtimeContext) {
  const agent = runtimeContext.agent || {};
  const promptIntro = firstNonEmptyString(
    agent.promptIntro,
    runtimeContext.promptIntro,
  );
  if (promptIntro) {
    return promptIntro;
  }

  const promptRole = firstNonEmptyString(
    agent.promptRole,
    runtimeContext.promptRole,
  );
  if (promptRole) {
    return `You are ${withIndefiniteArticle(promptRole)}.`;
  }

  return 'You are a repo-defined custom Autonomy agent.';
}

function firstNonEmptyString(...values: unknown[]) {
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
}

function withIndefiniteArticle(value: string) {
  const normalized = value.replace(/[.]+$/g, '').trim();
  if (/^(a|an|the)\s+/i.test(normalized)) {
    return normalized;
  }
  return `${/^[aeiou]/i.test(normalized) ? 'an' : 'a'} ${normalized}`;
}

function formatReadOnlyContextFile(entry) {
  const filePath = String(entry && entry.path || '').trim();
  const label = String(entry && (entry.relativePath || entry.name) || filePath).trim();
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    content = `Unable to read context file: ${error instanceof Error ? error.message : String(error)}`;
  }
  return [
    `### ${label}`,
    '```',
    content,
    '```',
  ].join('\n');
}

function readOptionalPromptFile(rootDir: string, promptPath: unknown) {
  const normalized = String(promptPath || '').trim();
  if (!normalized) {
    return '';
  }
  const resolved = path.resolve(rootDir, normalized);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(resolved)) {
    return '';
  }
  return fs.readFileSync(resolved, 'utf8');
}

function ensureWorkspaceInsideRoot(rootDir: string, workspacePath: string) {
  const relative = path.relative(rootDir, workspacePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Custom agent workspace must resolve inside the repository root.');
  }
}

function finalizeCustomAgentRuntime(rootDir: string, runtimeKey: string, result, error) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    runtime.customAgents = runtime.customAgents || {};
    const invocationId = String(runtime.customAgents[runtimeKey] && runtime.customAgents[runtimeKey].invocationId || result && result.invocationId || '');
    if (invocationId) {
      runtime.customAgentInvocations = runtime.customAgentInvocations || {};
      runtime.customAgentInvocations[invocationId] = {
        invocationId,
        agentId: String(runtime.customAgents[runtimeKey] && runtime.customAgents[runtimeKey].agentId || runtimeKey),
        ...(runtime.customAgentInvocations[invocationId] || {}),
        status: error ? 'failed' : 'completed',
        phase: error ? ((runtime.customAgentInvocations[invocationId] && runtime.customAgentInvocations[invocationId].phase) || 'failed') : 'completed',
        finishedAt: new Date().toISOString(),
        lastResult: result || null,
        lastError: error ? extractError(error) : null,
      };
    }
    runtime.customAgents[runtimeKey] = {
      agentId: String(runtime.customAgents[runtimeKey] && runtime.customAgents[runtimeKey].agentId || runtimeKey),
      ...(runtime.customAgents[runtimeKey] || {}),
      status: 'idle',
      running: false,
      finishedAt: new Date().toISOString(),
      pid: null,
      lastResult: result || null,
      lastError: error ? extractError(error) : null,
    };
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function collectCommandOutput(...parts: unknown[]) {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n');
}

function extractError(error) {
  if (error && typeof error === 'object') {
    if (error.stderr) {
      return String(error.stderr);
    }
    if (error.stdout) {
      return String(error.stdout);
    }
    if (error.message) {
      return String(error.message);
    }
  }
  return String(error || 'custom agent failed');
}

export { buildCustomAgentNetworkConfigOverrides, buildCustomAgentPrompt, main };

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${extractError(error)}`);
    process.exit(1);
  });
}
