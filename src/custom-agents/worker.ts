#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandConfig, JsonRecord, RuntimeState } from '../types.js';
import {
  acquireStateLock,
  ensureDir,
  extractError,
  isRecord,
  loadRuntime,
  readJson,
  resolveInsideRoot,
  writeJson,
  writeRuntime,
} from '../runtime.js';
import { runCodex } from './codex.js';
import {
  runBufferedCommand,
  terminateActiveCommands,
} from './command.js';

type WorkerOptions = {
  codexRunner?: typeof runCodex;
};

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (command !== 'run') {
    throw new Error(`Unknown command "${command}". Use "run".`);
  }
  const contextPath = String(
    options.context || process.env.AUTONOMY_CUSTOM_AGENT_CONTEXT || ''
  ).trim();
  if (!contextPath) {
    throw new Error('Missing required option --context');
  }
  const runtimeContext = readJson<JsonRecord>(contextPath, {});
  runtimeContext.paths = { ...(runtimeContext.paths || {}), contextPath };
  validateRuntimeContext(runtimeContext);
  const removeSignalHandlers = installWorkerSignalHandlers();

  let result: JsonRecord | null = null;
  let failure: unknown = null;
  try {
    result = await runCustomAgent(runtimeContext);
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    finalizeRuntime(runtimeContext, result, failure);
    removeSignalHandlers();
  }
}

async function runCustomAgent(runtimeContext: JsonRecord, options: WorkerOptions = {}) {
  if (process.env.AUTONOMY_CUSTOM_AGENT_STUB === '1') {
    return { ok: true, status: 'stubbed' };
  }
  validateRuntimeContext(runtimeContext);
  const rootDir = String(runtimeContext.rootDir);
  const workspacePath = String(runtimeContext.workspacePath);
  ensureDir(workspacePath);
  const context = isRecord(runtimeContext.context) ? runtimeContext.context : {};
  const agent = isRecord(runtimeContext.agent) ? runtimeContext.agent : {};
  const parallel = isRecord(runtimeContext.parallel) ? runtimeContext.parallel : {};
  const baseEnv: NodeJS.ProcessEnv = {
    AUTONOMY_CUSTOM_AGENT_ID: String(agent.id || ''),
    AUTONOMY_CUSTOM_AGENT_KIND: String(runtimeContext.kind || ''),
    AUTONOMY_CUSTOM_AGENT_RUNTIME_KEY: String(runtimeContext.runtimeKey || ''),
    AUTONOMY_CUSTOM_AGENT_BASE_RUNTIME_KEY: String(runtimeContext.baseRuntimeKey || runtimeContext.runtimeKey || ''),
    AUTONOMY_CUSTOM_AGENT_SLOT: String(parallel.slot || 1),
    AUTONOMY_CUSTOM_AGENT_PARALLELISM: String(parallel.total || 1),
    AUTONOMY_CUSTOM_AGENT_TARGET: JSON.stringify(runtimeContext.target || {}),
    AUTONOMY_CUSTOM_AGENT_WORKSPACE: workspacePath,
  };
  let environment: JsonRecord = {};
  let promptResult: JsonRecord | null = null;
  let preparedWorkspace = workspacePath;
  let failure: unknown = null;
  let run: JsonRecord = { status: 'failed' };

  try {
    markInvocationPhase(runtimeContext, 'environment');
    environment = await runLifecycleCommand(runtimeContext, 'environment', {
      workspacePath,
      env: baseEnv,
    }) || {};
    preparedWorkspace = resolvePreparedWorkspace(rootDir, workspacePath, environment);
    ensureDir(preparedWorkspace);

    markInvocationPhase(runtimeContext, 'prompt', {
      workspace: { cwd: preparedWorkspace },
    });
    promptResult = await runLifecycleCommand(runtimeContext, 'prompt', {
      workspacePath: preparedWorkspace,
      env: baseEnv,
      previous: { environment },
    });
    const prompt = promptResult
      ? normalizePromptResult(rootDir, promptResult)
      : buildFallbackPrompt(runtimeContext);

    markInvocationPhase(runtimeContext, 'run', {
      workspace: { cwd: preparedWorkspace },
    });
    const conversation = isRecord(runtimeContext.conversation)
      ? runtimeContext.conversation
      : {};
    const codexRunner = options.codexRunner || runCodex;
    const codexResult = await codexRunner({
      cwd: preparedWorkspace,
      prompt,
      sandboxMode: context.allowRuntimeStateChanges === true
        ? 'danger-full-access'
        : 'workspace-write',
      env: baseEnv,
      persistConversation: conversation.persist === true,
      resumeSessionId: String(conversation.resumeSessionId || ''),
    });
    run = {
      status: 'completed',
      conversationId: codexResult.conversationId || '',
    };
  } catch (error) {
    failure = error;
    run = { status: 'failed', error: extractError(error) };
  }

  let finalize: JsonRecord | null = null;
  try {
    markInvocationPhase(runtimeContext, 'finalize', {
      workspace: { cwd: preparedWorkspace },
      run,
    });
    finalize = await runLifecycleCommand(runtimeContext, 'finalize', {
      workspacePath: preparedWorkspace,
      env: baseEnv,
      previous: {
        environment,
        prompt: summarizePromptResult(promptResult),
      },
      run,
    });
  } catch (finalizeError) {
    if (!failure) throw finalizeError;
    throw new Error(
      `${extractError(failure)}; finalize command also failed: ${extractError(finalizeError)}`,
      { cause: failure }
    );
  }
  if (failure) throw failure;
  return {
    ok: true,
    status: 'completed',
    invocationId: String(runtimeContext.invocationId),
    conversationId: run.conversationId,
    environment,
    finalize,
  };
}

async function runLifecycleCommand(
  runtimeContext: JsonRecord,
  phase: string,
  options: JsonRecord
) {
  const lifecycle = isRecord(runtimeContext.lifecycle) ? runtimeContext.lifecycle : {};
  const command = lifecycle[phase] as CommandConfig | null;
  if (!command) {
    return null;
  }
  const envelope = buildLifecycleEnvelope(runtimeContext, phase, options);
  const agent = isRecord(runtimeContext.agent) ? runtimeContext.agent : {};
  const parallel = isRecord(runtimeContext.parallel) ? runtimeContext.parallel : {};
  const result = await runBufferedCommand({
    binary: command.command,
    args: command.args || [],
    cwd: command.cwd || runtimeContext.rootDir,
    env: {
      ...process.env,
      ...(options.env || {}),
      ...(command.env || {}),
      AUTONOMY_CUSTOM_AGENT_ID: String(agent.id || ''),
      AUTONOMY_CUSTOM_AGENT_KIND: String(runtimeContext.kind || ''),
      AUTONOMY_CUSTOM_AGENT_RUNTIME_KEY: String(runtimeContext.runtimeKey || ''),
      AUTONOMY_CUSTOM_AGENT_BASE_RUNTIME_KEY: String(
        runtimeContext.baseRuntimeKey || runtimeContext.runtimeKey || ''
      ),
      AUTONOMY_CUSTOM_AGENT_SLOT: String(parallel.slot || 1),
      AUTONOMY_CUSTOM_AGENT_PARALLELISM: String(parallel.total || 1),
      AUTONOMY_CUSTOM_AGENT_PHASE: phase,
      AUTONOMY_CUSTOM_AGENT_INVOCATION_ID: String(runtimeContext.invocationId || ''),
      AUTONOMY_CUSTOM_AGENT_CONTEXT: String(runtimeContext.paths?.contextPath || ''),
    },
    input: `${JSON.stringify(envelope)}\n`,
    shell: command.shell === true,
    timeoutMs: Number(command.timeoutMs || 30_000),
    captureFullStdout: true,
  });
  writeLifecycleArtifact(runtimeContext, phase, {
    command: command.command,
    args: command.args || [],
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
    signal: result.signal || null,
  });
  if (result.timedOut) {
    throw new Error(`${phase} command exceeded timeout of ${command.timeoutMs}ms`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${phase} command exited ${result.status}: ${commandOutput(result.stderr, result.stdout)}`
    );
  }
  const stdout = String(result.stdout || '').trim();
  if (!stdout) {
    return {};
  }
  try {
    const value = JSON.parse(stdout);
    if (isRecord(value)) return value;
  } catch (error) {
    throw new Error(`${phase} command must print JSON: ${extractError(error)}`);
  }
  throw new Error(`${phase} command JSON must be an object`);
}

function installWorkerSignalHandlers() {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = new Map<NodeJS.Signals, () => void>();
  let shutdownTimer: NodeJS.Timeout | null = null;
  signals.forEach((signal) => {
    const handler = () => {
      if (shutdownTimer) {
        terminateActiveCommands('SIGKILL');
        process.exit(signalExitCode(signal));
      }
      terminateActiveCommands('SIGTERM');
      shutdownTimer = setTimeout(() => {
        terminateActiveCommands('SIGKILL');
        process.exit(signalExitCode(signal));
      }, 500);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  });
  return () => {
    handlers.forEach((handler, signal) => process.off(signal, handler));
  };
}

function signalExitCode(signal: NodeJS.Signals) {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 129;
}

function buildLifecycleEnvelope(
  runtimeContext: JsonRecord,
  phase: string,
  options: JsonRecord
) {
  const agent = isRecord(runtimeContext.agent) ? runtimeContext.agent : {};
  return {
    invocationId: String(runtimeContext.invocationId || ''),
    runtimeKey: String(runtimeContext.runtimeKey || ''),
    baseRuntimeKey: String(runtimeContext.baseRuntimeKey || runtimeContext.runtimeKey || ''),
    parallel: isRecord(runtimeContext.parallel)
      ? runtimeContext.parallel
      : { slot: 1, total: 1 },
    agentId: String(agent.id || ''),
    agentType: String(runtimeContext.kind || ''),
    repoRoot: String(runtimeContext.rootDir || ''),
    phase,
    target: runtimeContext.target || {},
    workspace: { cwd: String(options.workspacePath || runtimeContext.workspacePath || '') },
    paths: runtimeContext.paths || {},
    decision: runtimeContext.decision || {},
    previous: options.previous || {},
    run: options.run || null,
  };
}

function buildFallbackPrompt(runtimeContext: JsonRecord) {
  const agent = isRecord(runtimeContext.agent) ? runtimeContext.agent : {};
  const context = isRecord(runtimeContext.context) ? runtimeContext.context : {};
  const promptIntro = String(runtimeContext.promptIntro || '').trim();
  const promptRole = String(runtimeContext.promptRole || '').trim();
  const identity = promptIntro || (promptRole ? `You are a ${promptRole}.` : 'Run the repo-defined custom agent.');
  const instructions = [
    String(agent.instructions || '').trim(),
    readOptionalFile(String(agent.promptPath || '')),
  ].filter(Boolean).join('\n\n');
  const files = Array.isArray(context.globalReadOnly)
    ? context.globalReadOnly.map((entry) => {
        const record = isRecord(entry) ? entry : {};
        return `### ${record.relativePath || record.path}\n${readOptionalFile(String(record.path || ''))}`;
      })
    : [];
  return [
    identity,
    instructions,
    'Runtime context:',
    JSON.stringify({
      agentId: agent.id,
      runtimeKey: runtimeContext.runtimeKey,
      baseRuntimeKey: runtimeContext.baseRuntimeKey || runtimeContext.runtimeKey,
      parallel: runtimeContext.parallel || { slot: 1, total: 1 },
      kind: runtimeContext.kind,
      target: runtimeContext.target,
      workspacePath: runtimeContext.workspacePath,
      decision: runtimeContext.decision,
    }, null, 2),
    ...files,
  ].filter(Boolean).join('\n\n');
}

function resolvePreparedWorkspace(
  rootDir: string,
  fallback: string,
  environment: JsonRecord
) {
  const workspace = isRecord(environment.workspace) ? environment.workspace : {};
  const value = String(environment.cwd || environment.workspacePath || workspace.cwd || fallback);
  return resolveInsideRoot(rootDir, value, 'custom-agent prepared workspace');
}

function normalizePromptResult(rootDir: string, result: JsonRecord) {
  const prompt = String(result.prompt || '').trim();
  if (prompt) return prompt;
  const promptPath = String(result.promptPath || '').trim();
  if (promptPath) {
    return fs.readFileSync(resolveInsideRoot(rootDir, promptPath, 'promptPath'), 'utf8');
  }
  throw new Error('prompt command must return prompt or promptPath');
}

function summarizePromptResult(result: JsonRecord | null) {
  if (!result) return null;
  return {
    prompt: typeof result.prompt === 'string' ? { length: result.prompt.length } : undefined,
    promptPath: result.promptPath || undefined,
  };
}

function markInvocationPhase(
  runtimeContext: JsonRecord,
  phase: string,
  patch: JsonRecord = {}
) {
  mutateRuntime(runtimeContext, (runtime, status, invocation) => {
    const now = new Date().toISOString();
    if (status) status.phase = phase;
    if (invocation) {
      Object.assign(invocation, patch, { phase, updatedAt: now });
    }
  });
}

function finalizeRuntime(
  runtimeContext: JsonRecord,
  result: JsonRecord | null,
  failure: unknown
) {
  mutateRuntime(runtimeContext, (runtime, status, invocation) => {
    const now = new Date().toISOString();
    const message = failure ? extractError(failure) : null;
    if (status) {
      status.status = 'idle';
      status.running = false;
      status.pid = null;
      status.phase = failure ? 'failed' : 'completed';
      status.finishedAt = now;
      status.lastError = message;
      status.lastResult = result;
      const conversationId = String(result?.conversationId || '');
      if (conversationId) {
        status.conversationId = conversationId;
        status.lastConversationId = conversationId;
      }
    }
    if (invocation) {
      invocation.status = failure ? 'failed' : 'completed';
      invocation.phase = failure ? 'failed' : 'completed';
      invocation.updatedAt = now;
      invocation.finishedAt = now;
      invocation.lastError = message;
      invocation.result = result;
    }
  });
}

function mutateRuntime(
  runtimeContext: JsonRecord,
  callback: (
    runtime: RuntimeState,
    status: RuntimeState['customAgents'][string] | null,
    invocation: RuntimeState['customAgentInvocations'][string] | null
  ) => void
) {
  const rootDir = String(runtimeContext.rootDir || '');
  const runtimeKey = String(runtimeContext.runtimeKey || '');
  const invocationId = String(runtimeContext.invocationId || '');
  if (!rootDir || !runtimeKey || !invocationId) return;
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    const status = runtime.customAgents[runtimeKey] || null;
    callback(
      runtime,
      status?.invocationId === invocationId && status.running ? status : null,
      runtime.customAgentInvocations[invocationId] || null
    );
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function writeLifecycleArtifact(runtimeContext: JsonRecord, phase: string, value: JsonRecord) {
  const invocationDir = String(runtimeContext.paths?.invocationDir || '');
  if (invocationDir) {
    ensureDir(invocationDir);
    writeJson(path.join(invocationDir, `${phase}.command.json`), value);
  }
}

function validateRuntimeContext(runtimeContext: JsonRecord) {
  const rootDir = String(runtimeContext.rootDir || '').trim();
  const runtimeKey = String(runtimeContext.runtimeKey || '').trim();
  const workspacePath = String(runtimeContext.workspacePath || '').trim();
  if (!rootDir || !runtimeKey || !workspacePath) {
    throw new Error('Custom-agent context requires rootDir, runtimeKey, and workspacePath.');
  }
  resolveInsideRoot(rootDir, workspacePath, 'custom-agent workspace');
}

function readOptionalFile(filePath: string) {
  if (!filePath) return '';
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    return `Unable to read ${filePath}: ${extractError(error)}`;
  }
}

function parseCli(argv: string[]) {
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const next = argv[index + 1];
      if (next && !next.startsWith('--')) {
        options[token.slice(2)] = next;
        index += 1;
      } else {
        options[token.slice(2)] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { command: positionals[0] || 'run', options };
}

function commandOutput(...values: unknown[]) {
  return values.map((value) => String(value || '').trim()).filter(Boolean).join('\n') || 'no output';
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${extractError(error)}`);
    process.exitCode = 1;
  });
}

export {
  buildFallbackPrompt,
  buildLifecycleEnvelope,
  finalizeRuntime,
  main,
  runCustomAgent,
  runLifecycleCommand,
};
