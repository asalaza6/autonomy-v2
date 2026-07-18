import { runBufferedCommand } from './command.js';

const CONVERSATION_BUFFER_LIMIT = 64 * 1024;

type SandboxMode = 'workspace-write' | 'danger-full-access';

type CodexOptions = {
  cwd: string;
  prompt: string;
  sandboxMode: SandboxMode;
  env?: NodeJS.ProcessEnv;
  resumeSessionId?: string;
  persistConversation?: boolean;
};

async function runCodex(options: CodexOptions) {
  const binary = process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const args = buildCodexArgs(options);
  const stream = process.env.AUTONOMY_STREAM_WORKER_OUTPUT === '1'
    || process.env.AUTONOMY_STREAM_CODEX_OUTPUT === '1';
  if (stream) {
    console.log(`[codex] ${JSON.stringify({ cwd: options.cwd, command: [binary, ...args] })}`);
  }

  const timeoutMs = codexTimeoutMs();
  let conversationId = '';
  let stdoutLineBuffer = '';
  const result = await runBufferedCommand({
    binary,
    args,
    cwd: options.cwd,
    input: options.prompt,
    env: { ...process.env, ...(options.env || {}) },
    stream,
    timeoutMs,
    onStdout: (chunk) => {
      if (conversationId) return;
      const captured = captureConversationFromChunk(stdoutLineBuffer, chunk);
      stdoutLineBuffer = captured.buffer;
      conversationId = captured.conversationId;
    },
  });
  if (result.timedOut) {
    throw new Error(`Codex exceeded wall-clock timeout of ${timeoutMs}ms`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Codex exited ${result.status ?? '-'}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr || result.stdout || 'no output'}`
    );
  }
  return {
    conversationId: conversationId
      || extractConversationId(stdoutLineBuffer)
      || extractConversationId(result.stdout),
  };
}

function buildCodexArgs(options: CodexOptions) {
  const args = [
    '--ask-for-approval',
    'never',
    'exec',
    '--sandbox',
    options.sandboxMode,
    '--skip-git-repo-check',
  ];
  const model = String(process.env.AUTONOMY_CODEX_MODEL || '').trim();
  const profile = String(process.env.AUTONOMY_CODEX_PROFILE || '').trim();
  if (model) args.push('-m', model);
  if (profile) args.push('-p', profile);
  const resumeSessionId = String(options.resumeSessionId || '').trim();
  const persist = options.persistConversation === true || Boolean(resumeSessionId);
  args.push('--cd', options.cwd);
  if (!persist) args.push('--ephemeral');
  args.push('--color', 'never');
  if (persist) args.push('--json');
  if (resumeSessionId) {
    args.push('resume', resumeSessionId, '-');
  } else {
    args.push('-');
  }
  return args;
}

function captureConversationFromChunk(buffer: string, chunk: unknown) {
  const lines = `${buffer}${String(chunk || '')}`.split(/\r?\n/);
  const remainder = lines.pop() || '';
  for (const line of lines) {
    const conversationId = extractConversationId(line);
    if (conversationId) {
      return { buffer: remainder.slice(-CONVERSATION_BUFFER_LIMIT), conversationId };
    }
  }
  return { buffer: remainder.slice(-CONVERSATION_BUFFER_LIMIT), conversationId: '' };
}

function extractConversationId(output: string) {
  for (const line of String(output || '').split(/\r?\n/)) {
    try {
      const id = findConversationId(JSON.parse(line));
      if (id) return id;
    } catch {
      // Fresh/ephemeral runs do not emit JSONL.
    }
  }
  return '';
}

function findConversationId(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId']) {
    if (typeof record[key] === 'string' && record[key]) return String(record[key]);
  }
  for (const nested of Object.values(record)) {
    const id = findConversationId(nested);
    if (id) return id;
  }
  return '';
}

function codexTimeoutMs() {
  const value = Number(process.env.AUTONOMY_CODEX_EXEC_TIMEOUT_MS || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export { buildCodexArgs, runCodex };
export type { CodexOptions };
