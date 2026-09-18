import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  buildSpawnExitMessage,
  ensureTrailingNewline,
  extractExecError,
  extractSpawnSyncError,
  logCodexFailure,
} from './codex-shared.js';

const DEFAULT_CAPTURE_LIMIT = 64 * 1024;
const DEFAULT_SYNC_PROCESS_BUFFER_LIMIT = 16 * 1024 * 1024;
const DEFAULT_CODEX_EXEC_TIMEOUT_MS = 0;
const SAFE_CODEX_ENV_KEYS = [
  'HOME',
  'PATH',
  'PWD',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
] as const;

type CodexRuntimeOptions = {
  env?: NodeJS.ProcessEnv;
  inheritHostEnv?: boolean;
  configOverrides?: string[];
};

type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

async function runCodexStructured({
  cwd,
  prompt,
  schema,
  readOnly,
  resumeSessionId = '',
  captureConversationId = false,
  env,
  inheritHostEnv = true,
  configOverrides = [],
  sandboxMode,
}: {
  cwd: string;
  prompt: string;
  schema: unknown;
  readOnly: boolean;
  resumeSessionId?: string;
  captureConversationId?: boolean;
  env?: NodeJS.ProcessEnv;
  inheritHostEnv?: boolean;
  configOverrides?: string[];
  sandboxMode?: CodexSandboxMode;
}) {
  const codexBin = process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-codex-'));
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'output.json');
  const streamOutput = shouldStreamCodexOutput();

  try {
    fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    const args = buildCodexArgs({ cwd, schemaPath, outputPath, readOnly, resumeSessionId, captureConversationId, configOverrides, sandboxMode });
    logCodexInvocation({ cwd, prompt, args, readOnly, streamOutput });
    const result = await runCodexCommand({
      binary: codexBin,
      args,
      cwd,
      input: prompt,
      streamOutput,
      ...buildCodexRuntimeOptions({ env, inheritHostEnv, configOverrides }),
    });
    const output = readCodexOutput(outputPath, streamOutput);
    const conversationId = result.conversationId || extractCodexConversationId(result.stdout);
    return captureConversationId === true || resumeSessionId
      ? { ...output, conversationId }
      : output;
  } catch (error) {
    logCodexFailure(error, streamOutput);
    throw new Error(`Codex CLI failed: ${extractExecError(error)}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runCodexExec({
  cwd,
  prompt,
  readOnly,
  resumeSessionId = '',
  captureConversationId = false,
  env,
  inheritHostEnv = true,
  configOverrides = [],
  sandboxMode,
}: {
  cwd: string;
  prompt: string;
  readOnly: boolean;
  resumeSessionId?: string;
  captureConversationId?: boolean;
  env?: NodeJS.ProcessEnv;
  inheritHostEnv?: boolean;
  configOverrides?: string[];
  sandboxMode?: CodexSandboxMode;
}) {
  const codexBin = process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const streamOutput = shouldStreamCodexOutput();
  try {
    const args = buildCodexExecArgs({ cwd, readOnly, resumeSessionId, captureConversationId, configOverrides, sandboxMode });
    logCodexInvocation({ cwd, prompt, args, readOnly, streamOutput });
    const result = await runCodexCommand({
      binary: codexBin,
      args,
      cwd,
      input: prompt,
      streamOutput,
      timeoutMs: resolveCodexExecTimeoutMs(),
      ...buildCodexRuntimeOptions({ env, inheritHostEnv, configOverrides }),
    });
    return {
      conversationId: result.conversationId || extractCodexConversationId(result.stdout),
    };
  } catch (error) {
    logCodexFailure(error, streamOutput);
    throw new Error(`Codex CLI failed: ${extractExecError(error)}`);
  }
}

function runCodexExecSync({
  cwd,
  prompt,
  readOnly,
  resumeSessionId = '',
  captureConversationId = false,
  env,
  inheritHostEnv = true,
  configOverrides = [],
  sandboxMode,
}: {
  cwd: string;
  prompt: string;
  readOnly: boolean;
  resumeSessionId?: string;
  captureConversationId?: boolean;
  env?: NodeJS.ProcessEnv;
  inheritHostEnv?: boolean;
  configOverrides?: string[];
  sandboxMode?: CodexSandboxMode;
}) {
  const codexBin = process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const streamOutput = shouldStreamCodexOutput();
  try {
    const args = buildCodexExecArgs({ cwd, readOnly, resumeSessionId, captureConversationId, configOverrides, sandboxMode });
    logCodexInvocation({ cwd, prompt, args, readOnly, streamOutput });
    const result = runCodexCommandSync({
      binary: codexBin,
      args,
      cwd,
      input: prompt,
      streamOutput,
      ...buildCodexRuntimeOptions({ env, inheritHostEnv, configOverrides }),
    });
    return {
      conversationId: extractCodexConversationId(result.stdout),
    };
  } catch (error) {
    logCodexFailure(error, streamOutput);
    throw new Error(`Codex CLI failed: ${extractExecError(error)}`);
  }
}

function resolveSandboxMode(readOnly, sandboxMode: CodexSandboxMode | undefined) {
  if (sandboxMode) {
    return sandboxMode;
  }
  return readOnly ? 'read-only' : 'danger-full-access';
}

function buildCodexArgs({ cwd, schemaPath, outputPath, readOnly, resumeSessionId = '', captureConversationId = false, configOverrides = [], sandboxMode = undefined }) {
  const args = ['--ask-for-approval', 'never', 'exec'];
  args.push('--sandbox', resolveSandboxMode(readOnly, sandboxMode));

  const model = String(process.env.AUTONOMY_CODEX_MODEL || '').trim();
  if (model) {
    args.push('-m', model);
  }

  const profile = String(process.env.AUTONOMY_CODEX_PROFILE || '').trim();
  if (profile) {
    args.push('-p', profile);
  }
  configOverrides.forEach((override) => {
    if (String(override || '').trim()) {
      args.push('-c', override);
    }
  });

  const normalizedResumeSessionId = String(resumeSessionId || '').trim();
  const persistConversation = captureConversationId === true || Boolean(normalizedResumeSessionId);

  args.push(
    '--cd',
    cwd,
    ...(persistConversation ? [] : ['--ephemeral']),
    '--color',
    'never',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath
  );
  if (persistConversation) {
    args.push('--json');
  }
  if (normalizedResumeSessionId) {
    args.push('resume', normalizedResumeSessionId, '-');
  } else {
    args.push('-');
  }
  return args;
}

function buildCodexExecArgs({ cwd, readOnly, resumeSessionId = '', captureConversationId = false, configOverrides = [], sandboxMode = undefined }) {
  const args = ['--ask-for-approval', 'never', 'exec'];
  args.push('--sandbox', resolveSandboxMode(readOnly, sandboxMode));

  const model = String(process.env.AUTONOMY_CODEX_MODEL || '').trim();
  if (model) {
    args.push('-m', model);
  }

  const profile = String(process.env.AUTONOMY_CODEX_PROFILE || '').trim();
  if (profile) {
    args.push('-p', profile);
  }
  configOverrides.forEach((override) => {
    if (String(override || '').trim()) {
      args.push('-c', override);
    }
  });

  const normalizedResumeSessionId = String(resumeSessionId || '').trim();
  const persistConversation = captureConversationId === true || Boolean(normalizedResumeSessionId);

  args.push(
    '--cd',
    cwd,
    ...(persistConversation ? [] : ['--ephemeral']),
    '--color',
    'never'
  );
  if (persistConversation) {
    args.push('--json');
  }
  if (normalizedResumeSessionId) {
    args.push('resume', normalizedResumeSessionId, '-');
  } else {
    args.push('-');
  }
  return args;
}

function runCodexCommandSync({ binary, args, cwd, input, streamOutput, env }) {
  const result = spawnSync(binary, args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: DEFAULT_SYNC_PROCESS_BUFFER_LIMIT,
    killSignal: 'SIGKILL',
    env: env || process.env,
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(extractSpawnSyncError(result));
  }
  if (streamOutput) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runCodexCommand({ binary, args, cwd, input, streamOutput, timeoutMs = 0, env }) {
  return new Promise<{ stdout: string; stderr: string; conversationId: string }>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env || process.env,
    });
    let settled = false;
    let stdoutCapture = '';
    let stderrCapture = '';
    let stdoutLineBuffer = '';
    let conversationId = '';
    let killTimer = null;
    let forcedKillTimer = null;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      reject(error);
    };

    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      resolve({
        stdout: stdoutCapture,
        stderr: stderrCapture,
        conversationId,
      });
    };

    const clearTimers = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (forcedKillTimer) {
        clearTimeout(forcedKillTimer);
        forcedKillTimer = null;
      }
    };

    const appendCapture = (current, chunk) => {
      const next = `${current}${String(chunk || '')}`;
      if (next.length <= DEFAULT_CAPTURE_LIMIT) {
        return next;
      }
      return next.slice(next.length - DEFAULT_CAPTURE_LIMIT);
    };

    const onData = (streamName, chunk) => {
      if (streamName === 'stdout') {
        stdoutCapture = appendCapture(stdoutCapture, chunk);
        if (!conversationId) {
          const parsed = captureCodexConversationIdFromChunk(stdoutLineBuffer, chunk);
          stdoutLineBuffer = parsed.buffer;
          conversationId = parsed.conversationId;
        }
        if (streamOutput) {
          process.stdout.write(chunk);
        }
      } else {
        stderrCapture = appendCapture(stderrCapture, chunk);
        if (streamOutput) {
          process.stderr.write(chunk);
        }
      }
    };

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        const error = new Error(`Codex exceeded wall-clock timeout of ${timeoutMs}ms`);
        error.stdout = stdoutCapture;
        error.stderr = stderrCapture;
        child.kill('SIGTERM');
        forcedKillTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 1000);
        fail(error);
      }, timeoutMs);
    }

    child.stdout.on('data', (chunk) => {
      onData('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      onData('stderr', chunk);
    });
    child.on('error', (error) => {
      error.stdout = stdoutCapture;
      error.stderr = stderrCapture;
      fail(error);
    });
    child.on('close', (code, signal) => {
      conversationId = conversationId || extractCodexConversationId(stdoutLineBuffer);
      if (code !== 0) {
        const error = new Error(buildSpawnExitMessage({ code, signal, stdout: stdoutCapture, stderr: stderrCapture }));
        error.stdout = stdoutCapture;
        error.stderr = stderrCapture;
        fail(error);
        return;
      }
      succeed();
    });

    child.stdin.end(input, 'utf8');
  });
}

function captureCodexConversationIdFromChunk(buffer, chunk) {
  const text = `${String(buffer || '')}${String(chunk || '')}`;
  const lines = text.split(/\r?\n/);
  const nextBuffer = lines.pop() || '';
  for (const line of lines) {
    const conversationId = extractCodexConversationId(line);
    if (conversationId) {
      return {
        buffer: nextBuffer,
        conversationId,
      };
    }
  }
  return {
    buffer: nextBuffer.length > DEFAULT_CAPTURE_LIMIT
      ? nextBuffer.slice(nextBuffer.length - DEFAULT_CAPTURE_LIMIT)
      : nextBuffer,
    conversationId: '',
  };
}

function extractCodexConversationId(stdout) {
  const lines = String(stdout || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed);
      const conversationId = findCodexConversationId(event);
      if (conversationId) {
        return conversationId;
      }
    } catch (_) {
      // Non-JSON output is ignored. Codex emits JSONL only when --json is honored.
    }
  }
  return '';
}

function buildCodexRuntimeOptions({
  env,
  inheritHostEnv = true,
  configOverrides = [],
}: CodexRuntimeOptions) {
  return {
    env: buildCodexProcessEnv(env, inheritHostEnv),
    configOverrides,
  };
}

function buildCodexProcessEnv(env?: NodeJS.ProcessEnv, inheritHostEnv = true) {
  if (inheritHostEnv) {
    return {
      ...process.env,
      ...(env || {}),
    };
  }

  const safeEnv: NodeJS.ProcessEnv = {};
  SAFE_CODEX_ENV_KEYS.forEach((key) => {
    const value = process.env[key];
    if (typeof value === 'string' && value) {
      safeEnv[key] = value;
    }
  });
  Object.entries(env || {}).forEach(([key, value]) => {
    if (typeof value === 'string') {
      safeEnv[key] = value;
    }
  });
  return safeEnv;
}

function findCodexConversationId(value) {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const directKeys = [
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId',
  ];
  for (const key of directKeys) {
    const directValue = normalizeConversationId(value[key]);
    if (directValue) {
      return directValue;
    }
  }

  const eventType = String(value.type || value.event || value.kind || '').toLowerCase();
  if (/(session|conversation|thread)/.test(eventType)) {
    const typedId = normalizeConversationId(value.id);
    if (typedId) {
      return typedId;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const nestedId = findCodexConversationId(nestedValue);
    if (nestedId) {
      return nestedId;
    }
  }
  return '';
}

function normalizeConversationId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readCodexOutput(outputPath, streamOutput) {
  if (!fs.existsSync(outputPath)) {
    throw new Error('Codex did not write an output payload.');
  }

  const raw = fs.readFileSync(outputPath, 'utf8').trim();
  if (!raw) {
    throw new Error('Codex output payload was empty.');
  }
  logCodexResult(raw, streamOutput);
  return JSON.parse(raw);
}

function resolveCodexExecTimeoutMs() {
  const raw = String(process.env.AUTONOMY_CODEX_EXEC_TIMEOUT_MS || '').trim();
  if (!raw) {
    return DEFAULT_CODEX_EXEC_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CODEX_EXEC_TIMEOUT_MS;
  }
  return parsed;
}

function shouldStreamCodexOutput() {
  return process.env.AUTONOMY_STREAM_WORKER_OUTPUT === '1'
    || process.env.AUTONOMY_STREAM_CODEX_OUTPUT === '1';
}

function logCodexInvocation({ cwd, prompt, args, readOnly, streamOutput }) {
  if (!streamOutput) {
    return;
  }
  console.log(`[codex] invoke ${JSON.stringify({
    cwd,
    readOnly,
    command: [process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex'].concat(args),
  })}`);
  console.log('[codex] prompt:begin');
  process.stdout.write(ensureTrailingNewline(prompt));
  console.log('[codex] prompt:end');
}

function logCodexResult(raw, streamOutput) {
  if (!streamOutput) {
    return;
  }
  console.log('[codex] result:begin');
  process.stdout.write(ensureTrailingNewline(raw));
  console.log('[codex] result:end');
}

export {
  runCodexExec,
  runCodexExecSync,
  runCodexStructured,
};
