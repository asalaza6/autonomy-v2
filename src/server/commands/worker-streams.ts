import fs from 'fs';
import path from 'path';
import type { AnyRecord } from '../../types.js';
import type { TraceContext } from '../server-types.js';
import { appendTraceLine, ensureDir, formatServerEventLine, getAgentTraceLogPath, maybeOpenAgentTraceTerminal } from './trace.js';

function attachWorkerOutput(attachedWorkers: Map<string, any>, entry: AnyRecord, options: AnyRecord = {}) {
  if (!entry || !entry.child || !entry.pid) {
    return;
  }
  const key = `${entry.agentId}:${entry.pid}`;
  if (attachedWorkers.has(key)) {
    return;
  }
  attachedWorkers.set(key, entry.child);
  const traceLogPath = getAgentTraceLogPath(options.rootDir, entry.agentId);
  ensureDir(path.dirname(traceLogPath));
  if (!fs.existsSync(traceLogPath)) {
    fs.writeFileSync(traceLogPath, '', 'utf8');
  }
  const conversationFields = buildWorkerAttachConversationFields(entry);
  console.log(formatServerEventLine('worker:attach', {
    agentId: entry.agentId,
    pid: entry.pid,
    reason: entry.reason || '',
    ...conversationFields,
    trace: traceLogPath,
  }));
  appendTraceLine(traceLogPath, formatServerEventLine('worker:attach', {
    agentId: entry.agentId,
    pid: entry.pid,
    reason: entry.reason || '',
    ...conversationFields,
  }), options);

  if (options.sameTerminalTrace !== true && options.autoOpenTraceWindows === true) {
    maybeOpenAgentTraceTerminal(entry.agentId, traceLogPath, options);
  }

  const contextState: TraceContext = {};
  const stdoutState = { buffer: '' };
  const stderrState = { buffer: '' };
  const pendingBufferMaxBytes = Number(options.traceLineMaxBytes || 0);
  const writeTraceLine = (line) => {
    appendTraceLine(traceLogPath, line, options);
    if (options.sameTerminalTrace === true) {
      console.log(line);
    }
  };

  if (entry.child.stdout) {
    entry.child.stdout.setEncoding('utf8');
    entry.child.stdout.on('data', (chunk) => {
      stdoutState.buffer = writePrefixedChunks(
        entry.agentId,
        entry.pid,
        'stdout',
        stdoutState.buffer,
        chunk,
        contextState,
        writeTraceLine,
        () => new Date().toISOString(),
        pendingBufferMaxBytes
      );
    });
  }
  if (entry.child.stderr) {
    entry.child.stderr.setEncoding('utf8');
    entry.child.stderr.on('data', (chunk) => {
      stderrState.buffer = writePrefixedChunks(
        entry.agentId,
        entry.pid,
        'stderr',
        stderrState.buffer,
        chunk,
        contextState,
        writeTraceLine,
        () => new Date().toISOString(),
        pendingBufferMaxBytes
      );
    });
  }

  entry.child.on('exit', (code, signal) => {
    flushPrefixedChunks(entry.agentId, entry.pid, 'stdout', stdoutState, contextState, writeTraceLine);
    flushPrefixedChunks(entry.agentId, entry.pid, 'stderr', stderrState, contextState, writeTraceLine);
    attachedWorkers.delete(key);
    const exitLine = formatServerEventLine('worker:exit', {
      agentId: entry.agentId,
      pid: entry.pid,
      code: code == null ? '-' : code,
      signal: signal || '-',
      error: shouldIncludeWorkerExitError(code, contextState) ? contextState.errorSummary : null,
    });
    console.log(exitLine);
    appendTraceLine(traceLogPath, exitLine, options);
  });
}

function buildWorkerAttachConversationFields(entry: AnyRecord) {
  const conversation = entry && entry.conversation && typeof entry.conversation === 'object'
    ? entry.conversation
    : {};
  const conversationId = normalizeConversationId(
    entry && (
      entry.conversationId
      || entry.resumeSessionId
    )
  ) || normalizeConversationId(
    conversation.resumeSessionId
      || conversation.conversationId
  );
  return {
    conversationId: conversationId || 'new',
    conversationKey: normalizeConversationId(conversation.key),
  };
}

function normalizeConversationId(value) {
  return String(value || '').trim();
}

function writePrefixedChunks(
  agentId,
  pid,
  streamName,
  pendingBuffer,
  chunk,
  contextState = {},
  writeLine = console.log,
  timestampFactory = () => new Date().toISOString(),
  pendingBufferMaxBytes = 0
) {
  const joined = `${pendingBuffer}${String(chunk || '')}`;
  const lines = joined.split(/\r?\n/);
  const remainder = lines.pop() || '';
  let activeTracePrefixKey = null;
  lines.forEach((line) => {
    if (line.length === 0) {
      return;
    }
    updateWorkerContext(contextState, line);
    const classifiedStream = classifyWorkerStreamLine(streamName, line, contextState);
    if (classifiedStream === 'trace') {
      const nextTracePrefixKey = formatWorkerStreamPrefixKey(
        agentId,
        pid,
        classifiedStream,
        contextState
      );
      if (activeTracePrefixKey !== nextTracePrefixKey) {
        writeLine(formatWorkerStreamPrefix(
          agentId,
          pid,
          classifiedStream,
          contextState,
          timestampFactory()
        ));
        activeTracePrefixKey = nextTracePrefixKey;
      }
      writeLine(line);
      return;
    }
    activeTracePrefixKey = null;
    const timestamp = timestampFactory();
    writeLine(formatWorkerStreamLine(
      agentId,
      pid,
      classifiedStream,
      line,
      contextState,
      timestamp
    ));
  });
  return flushOversizedPendingBuffer(
    agentId,
    pid,
    streamName,
    remainder,
    contextState,
    writeLine,
    timestampFactory,
    pendingBufferMaxBytes
  );
}

function flushOversizedPendingBuffer(
  agentId,
  pid,
  streamName,
  pendingBuffer,
  contextState = {},
  writeLine = console.log,
  timestampFactory = () => new Date().toISOString(),
  pendingBufferMaxBytes = 0
) {
  const maxBytes = Number(pendingBufferMaxBytes || 0);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return pendingBuffer;
  }
  const text = String(pendingBuffer || '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }

  updateWorkerContext(contextState, text);
  const classifiedStream = classifyWorkerStreamLine(streamName, text, contextState);
  const timestamp = timestampFactory();
  if (classifiedStream === 'trace') {
    writeLine(formatWorkerStreamPrefix(
      agentId,
      pid,
      classifiedStream,
      contextState,
      timestamp
    ));
    writeLine(text);
  } else {
    writeLine(formatWorkerStreamLine(
      agentId,
      pid,
      classifiedStream,
      text,
      contextState,
      timestamp
    ));
  }
  return '';
}

function flushPrefixedChunks(
  agentId,
  pid,
  streamName,
  state,
  contextState = {},
  writeLine = console.log,
  timestampFactory = () => new Date().toISOString()
) {
  if (!state || !state.buffer) {
    return;
  }
  const line = String(state.buffer).trim();
  if (line) {
    updateWorkerContext(contextState, line);
    const classifiedStream = classifyWorkerStreamLine(streamName, line, contextState);
    const timestamp = timestampFactory();
    if (classifiedStream === 'trace') {
      writeLine(formatWorkerStreamPrefix(
        agentId,
        pid,
        classifiedStream,
        contextState,
        timestamp
      ));
      writeLine(line);
    } else {
      writeLine(formatWorkerStreamLine(
        agentId,
        pid,
        classifiedStream,
        line,
        contextState,
        timestamp
      ));
    }
  }
  state.buffer = '';
}

function classifyWorkerStreamLine(streamName: string, line: string, contextState: TraceContext = {}) {
  if (streamName !== 'stderr') {
    return streamName;
  }

  const text = String(line || '');
  if (looksLikeWorkerErrorLine(text)) {
    delete contextState.stderrMode;
    return 'stderr';
  }
  if (looksLikeCommandTraceLine(text)) {
    contextState.stderrMode = 'trace';
    return 'trace';
  }
  if (contextState.stderrMode === 'trace') {
    return 'trace';
  }
  return streamName;
}

function looksLikeCommandTraceLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return false;
  }
  if (text === 'exec') {
    return true;
  }
  if (/^\/(?:bin|usr\/bin|opt\/homebrew\/bin)\//.test(text)) {
    return true;
  }
  if (/^(sed|rg|git|npm|node|pnpm|bash|zsh)\b/.test(text) && /\bsucceeded in \d+ms:?$/i.test(text)) {
    return true;
  }
  if (/^\[codex\] (invoke|prompt:begin|prompt:end)/.test(text)) {
    return true;
  }
  return false;
}

function looksLikeWorkerErrorLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return false;
  }
  if (/^\[codex\] error\b/.test(text)) {
    return true;
  }
  return /^(ERROR:|Error:|TypeError:|ReferenceError:|SyntaxError:|RangeError:|URIError:|EvalError:|AggregateError:|Unhandled\b|npm ERR!|node:internal\b|\bat\s+\S)/.test(text);
}

function updateWorkerContext(contextState: TraceContext, line: string) {
  updateWorkerErrorSummary(contextState, line);
  return contextState;
}

function updateWorkerErrorSummary(contextState: TraceContext, line: string) {
  const nextError = extractWorkerErrorSummaryFromLine(line);
  if (!nextError) {
    return contextState;
  }
  const currentPriority = Number(contextState.errorPriority || 0);
  if (nextError.priority >= currentPriority) {
    contextState.errorSummary = nextError.summary;
    contextState.errorPriority = nextError.priority;
  }
  return contextState;
}

function extractWorkerErrorSummaryFromLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return null;
  }

  const workerMatch = text.match(/^\[worker\] [^ ]+ error (\{.*\})$/);
  if (workerMatch) {
    try {
      const payload = JSON.parse(workerMatch[1]) as AnyRecord;
      if (payload && payload.message) {
        return { summary: String(payload.message).trim(), priority: 4 };
      }
    } catch (_) {
      return null;
    }
  }

  const runnerMatch = text.match(/^\[runner\] [^ ]+:error (\{.*\})$/);
  if (runnerMatch) {
    try {
      const payload = JSON.parse(runnerMatch[1]) as AnyRecord;
      if (payload && payload.summary) {
        return { summary: String(payload.summary).trim(), priority: 3 };
      }
    } catch (_) {
      return null;
    }
  }

  if (/^ERROR:\s+Command failed:/.test(text)) {
    return { summary: text.replace(/^ERROR:\s*/, ''), priority: 1 };
  }
  if (/^ERROR:\s+/.test(text)) {
    return { summary: text.replace(/^ERROR:\s*/, ''), priority: 2 };
  }
  if (/^(Error:|TypeError:|ReferenceError:|SyntaxError:)/.test(text)) {
    return { summary: text, priority: 2 };
  }
  return null;
}

function shouldIncludeWorkerExitError(code: number | null, contextState: TraceContext = {}) {
  return code != null && Number(code) !== 0 && Boolean(contextState.errorSummary);
}

function formatWorkerStreamLine(agentId, pid, streamName, line, contextState = {}, timestamp = new Date().toISOString()) {
  return `${formatWorkerStreamPrefix(agentId, pid, streamName, contextState, timestamp)} | ${line}`;
}

function formatWorkerStreamPrefix(agentId, pid, streamName, contextState = {}, timestamp = new Date().toISOString()) {
  return `[${timestamp}] ${formatWorkerStreamPrefixKey(agentId, pid, streamName, contextState)}`;
}

function formatWorkerStreamPrefixKey(agentId: string, pid: number, streamName: string, contextState: TraceContext = {}) {
  const contextSegment = contextState && contextState.label && contextState.value
    ? ` | ${contextState.label}=${contextState.value}`
    : '';
  return `${agentId} | pid=${pid}${contextSegment} | ${streamName}`;
}

export { attachWorkerOutput, writePrefixedChunks };
