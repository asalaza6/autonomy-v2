import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AnyRecord, CliOptions } from '../../types.js';

const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const DEFAULT_TRACE_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TRACE_LOG_TRIM_BYTES = 2 * 1024 * 1024;
const DEFAULT_TRACE_LINE_MAX_BYTES = 64 * 1024;

function buildTraceOptions(rootDir: string, options: CliOptions = {}) {
  return {
    rootDir,
    sameTerminalTrace: options['same-terminal-trace'] === true,
    autoOpenTraceWindows: options['same-terminal-trace'] !== true && options['no-trace-window'] !== true,
    traceTerminal: normalizeTraceTerminal(options['trace-terminal']),
    traceLogMaxBytes: readPositiveInteger(
      options['trace-log-max-bytes'],
      process.env.AUTONOMY_TRACE_LOG_MAX_BYTES,
      DEFAULT_TRACE_LOG_MAX_BYTES
    ),
    traceLogTrimBytes: readPositiveInteger(
      options['trace-log-trim-bytes'],
      process.env.AUTONOMY_TRACE_LOG_TRIM_BYTES,
      DEFAULT_TRACE_LOG_TRIM_BYTES
    ),
    traceLineMaxBytes: readPositiveInteger(
      options['trace-line-max-bytes'],
      process.env.AUTONOMY_TRACE_LINE_MAX_BYTES,
      DEFAULT_TRACE_LINE_MAX_BYTES
    ),
    openedTraceAgents: new Set(),
  };
}

function normalizeTraceTerminal(value) {
  const normalized = String(value || 'terminal').trim().toLowerCase();
  if (normalized === 'iterm' || normalized === 'iterm2') {
    return 'iterm';
  }
  return 'terminal';
}

function getAgentTraceLogPath(rootDir, agentId) {
  return path.join(rootDir || process.cwd(), ...RUNTIME_SEGMENTS, 'agents', agentId, 'stream.log');
}

function appendTraceLine(filePath, line, options: AnyRecord = {}) {
  const maxLineBytes = normalizePositiveInteger(options.traceLineMaxBytes, DEFAULT_TRACE_LINE_MAX_BYTES);
  fs.appendFileSync(filePath, `${truncateTraceLine(line, maxLineBytes)}\n`, 'utf8');
  trimTraceLogIfNeeded(filePath, options);
}

function trimTraceLogIfNeeded(filePath, options: AnyRecord = {}) {
  const maxBytes = normalizePositiveInteger(options.traceLogMaxBytes, DEFAULT_TRACE_LOG_MAX_BYTES);
  if (maxBytes <= 0) {
    return false;
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return false;
  }

  const trimBytes = Math.min(
    normalizePositiveInteger(options.traceLogTrimBytes, DEFAULT_TRACE_LOG_TRIM_BYTES),
    maxBytes
  );
  let keepBytes = Math.max(0, Math.min(trimBytes, stat.size));
  let marker = formatServerEventLine('trace:trimmed', {
    previousBytes: stat.size,
    maxBytes,
    retainedBytes: keepBytes,
  });
  const markerBytes = Buffer.byteLength(`${marker}\n`, 'utf8');
  keepBytes = Math.max(0, Math.min(keepBytes, maxBytes - markerBytes));
  marker = formatServerEventLine('trace:trimmed', {
    previousBytes: stat.size,
    maxBytes,
    retainedBytes: keepBytes,
  });
  const retained = readLastBytes(filePath, keepBytes);
  fs.writeFileSync(filePath, `${marker}\n${dropPartialFirstLine(retained)}`, 'utf8');
  return true;
}

function readLastBytes(filePath, byteCount) {
  if (byteCount <= 0) {
    return '';
  }
  const stat = fs.statSync(filePath);
  const buffer = Buffer.alloc(Math.min(byteCount, stat.size));
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf8').replace(/^\uFFFD/, '');
}

function dropPartialFirstLine(value) {
  const text = String(value || '');
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex < 0 || newlineIndex === text.length - 1) {
    return text;
  }
  return text.slice(newlineIndex + 1);
}

function truncateTraceLine(line, maxLineBytes) {
  const text = String(line || '');
  if (maxLineBytes <= 0) {
    return text;
  }

  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength <= maxLineBytes) {
    return text;
  }

  const suffix = ` ... [truncated ${byteLength - maxLineBytes} bytes]`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  if (suffixBytes >= maxLineBytes) {
    return Buffer.from(suffix, 'utf8')
      .subarray(0, maxLineBytes)
      .toString('utf8')
      .replace(/\uFFFD$/, '');
  }
  const prefixBytes = Math.max(0, maxLineBytes - suffixBytes);
  const prefix = Buffer.from(text, 'utf8')
    .subarray(0, prefixBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${prefix}${suffix}`;
}

function readPositiveInteger(primary, fallback, defaultValue) {
  const primaryValue = normalizePositiveInteger(primary, 0);
  if (primaryValue > 0) {
    return primaryValue;
  }
  const fallbackValue = normalizePositiveInteger(fallback, 0);
  return fallbackValue > 0 ? fallbackValue : defaultValue;
}

function normalizePositiveInteger(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function maybeOpenAgentTraceTerminal(agentId: string, traceLogPath: string, options: AnyRecord = {}) {
  const openedTraceAgents = options.openedTraceAgents || new Set();
  if (openedTraceAgents.has(agentId)) {
    return false;
  }
  if (process.platform !== 'darwin') {
    return false;
  }
  const command = buildAgentTraceCommand(agentId, traceLogPath);
  openTraceTerminal(command, options.traceTerminal);
  openedTraceAgents.add(agentId);
  console.log(formatServerEventLine('worker:trace-window', {
    agentId,
    terminal: options.traceTerminal,
    trace: traceLogPath,
  }));
  return true;
}

function buildAgentTraceCommand(agentId, traceLogPath) {
  return [
    `printf '\\033]0;%s\\007' ${shellQuote(`${agentId} trace`)}`,
    'clear',
    `echo ${shellQuote(`Agent trace: ${agentId}`)}`,
    `echo ${shellQuote(`Trace file: ${traceLogPath}`)}`,
    `tail -n 200 -f ${shellQuote(traceLogPath)}`,
  ].join('; ');
}

function openTraceTerminal(command, terminal = 'terminal') {
  if (terminal === 'iterm') {
    execFileSync('osascript', ['-e', buildItermOpenScript(command)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return;
  }
  execFileSync('osascript', ['-e', buildTerminalOpenScript(command)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildTerminalOpenScript(command) {
  return [
    'tell application "Terminal"',
    'activate',
    `do script ${toAppleScriptString(command)}`,
    'end tell',
  ].join('\n');
}

function buildItermOpenScript(command) {
  return [
    'tell application "iTerm"',
    'activate',
    'create window with default profile',
    `tell current session of current window to write text ${toAppleScriptString(command)}`,
    'end tell',
  ].join('\n');
}

function toAppleScriptString(value) {
  return `"${String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')}"`;
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;
}

function formatServerEventLine(event, fields = {}, timestamp = new Date().toISOString()) {
  const parts = [`[${timestamp}]`, event];
  Object.entries(fields).forEach(([key, value]) => {
    if (value === '' || value == null) {
      return;
    }
    parts.push(`${key}=${value}`);
  });
  return parts.join(' | ');
}

export {
appendTraceLine,
buildTraceOptions,
ensureDir,
formatServerEventLine,
getAgentTraceLogPath,
maybeOpenAgentTraceTerminal
};
