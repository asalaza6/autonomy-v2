#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { resolveRootDir, runSchedulerTick, } from '../orchestrator/index.js';
import { loadAutonomyEnv } from '../../env/index.js';
import { acquireServerLock } from '../../lock/index.js';
import { AGENT_ROLES, buildRoleEventName, getRoleLabel, } from '../../agents/role-catalog.js';
import type { AnyRecord, CliOptions, TraceContext } from '../../types.js';
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const MAX_CONSECUTIVE_TICK_FAILURES = 3;

function parseCli(argv: string[]): { command: string; options: CliOptions } {
  const options: CliOptions = {};
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
    command: positionals[0] || 'serve',
    options,
  };
}

async function main(argv: string[] = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  const rootDir = resolveRootDir(String(options.root || ''));
  loadAutonomyEnv(rootDir);

  if (command === 'tick') {
    const result = runSchedulerTick(rootDir, { inline: options.inline === true });
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Tick complete. Started ${result.started.length} worker(s).`);
    result.started.forEach((entry) => {
      console.log(`${entry.agentId} | ${entry.mode} | ${entry.reason}`);
    });
    return;
  }

  if (command !== 'serve') {
    throw new Error(`Unknown command "${command}". Use "serve" or "tick".`);
  }

  const pollMs = Number(options['poll-ms'] || '2000');
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('--poll-ms must be a positive number.');
  }
  const syncMs = Number(options['sync-ms'] || '30000');
  if (!Number.isFinite(syncMs) || syncMs <= 0) {
    throw new Error('--sync-ms must be a positive number.');
  }
  const traceOptions = buildTraceOptions(rootDir, options);

  const releaseServerLock = acquireServerLock(rootDir);
  let released = false;
  let shuttingDown = false;
  let tickCount = 0;
  let consecutiveTickFailures = 0;
  const attachedWorkers = new Map();
  const cleanup = () => {
    if (released) {
      return;
    }
    released = true;
    attachedWorkers.forEach((child) => {
      try {
        child.kill('SIGTERM');
      } catch (_) {
        // Best effort shutdown for attached worker children.
      }
    });
    attachedWorkers.clear();
    releaseServerLock();
  };

  const shutdown = (exitCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(formatServerEventLine('server:shutdown', {
      exitCode,
      attachedWorkers: attachedWorkers.size,
    }));
    cleanup();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => {
    shutdown(0);
  });
  process.on('SIGTERM', () => {
    shutdown(0);
  });
  process.on('SIGHUP', () => {
    shutdown(0);
  });
  process.on('exit', cleanup);

  let lastSyncAt = 0;
  console.log(formatServerEventLine('server:start', {
    root: rootDir,
    pollMs,
    syncMs,
  }));
  console.log(formatServerEventLine('server:lock-acquired', {
    root: rootDir,
  }));
  const runTick = () => {
    const tickId = tickCount + 1;
    try {
      const now = Date.now();
      const shouldSync = now - lastSyncAt >= syncMs;
      const result = runSchedulerTick(rootDir, {
        inline: false,
        skipSync: !shouldSync,
        streamWorkerOutput: true,
        onWorkerSpawn(entry) {
          attachWorkerOutput(attachedWorkers, entry, traceOptions);
        },
      });
      tickCount = tickId;
      consecutiveTickFailures = 0;
      logTickResult(result);
      if (shouldSync) {
        lastSyncAt = now;
      }
    } catch (error) {
      consecutiveTickFailures += 1;
      console.error(formatServerEventLine('tick:error', {
        id: tickId,
        consecutiveFailures: consecutiveTickFailures,
        message: error.message,
      }));
      if (consecutiveTickFailures >= MAX_CONSECUTIVE_TICK_FAILURES) {
        console.error(formatServerEventLine('server:stop', {
          reason: 'consecutive_tick_failures',
          failures: consecutiveTickFailures,
          message: error.message,
        }));
        shutdown(1);
      }
    }
  };
  runTick();
  setInterval(runTick, pollMs);
}

function logTickResult(result) {
  return logTickResultWithWriter(result, console.log, () => new Date().toISOString());
}

function logTickResultWithWriter(result, writeLine = console.log, timestampFactory = () => new Date().toISOString()) {
  if (!result) {
    return false;
  }
  let emitted = false;
  if (result.sync && (
    result.sync.fetchMessage ||
    result.sync.imported.length > 0 ||
    result.sync.updated.length > 0 ||
    result.sync.invalid.length > 0
  )) {
    const line = [
      `[${new Date().toISOString()}] synced ${result.sync.integrationBranch}`,
      `ref=${result.sync.fetchedRef || '-'}`,
      `imported=${result.sync.imported.length}`,
      `updated=${result.sync.updated.length}`,
      `invalid=${result.sync.invalid.length}`,
    ];
    if (result.sync.fetchMessage) {
      line.push(`fetch=${result.sync.fetchMessage}`);
    }
    writeLine(line.join(' | '));
    emitted = true;
  }
  if (Array.isArray(result.started) && result.started.length > 0) {
    result.started.forEach((entry) => {
      const pidText = entry.pid ? ` pid=${entry.pid}` : '';
      writeLine(`[${timestampFactory()}] started ${entry.agentId} | ${entry.mode} | ${entry.reason}${pidText}`);
    });
    emitted = true;
  }

  return emitted;
}

function formatTickSummaryLine(result, timestamp = new Date().toISOString()) {
  const summary = summarizeTickResult(result);
  const parts = [
    `[${timestamp}] tick`,
    `due=${summary.due}`,
    `started=${summary.started}`,
    `running=${summary.running}`,
    `idle=${summary.idle}`,
  ];
  if (summary.active.length > 0) {
    parts.push(`active=${summary.active.join(',')}`);
  }
  return parts.join(' | ');
}

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
  console.log(formatServerEventLine('worker:attach', {
    agentId: entry.agentId,
    pid: entry.pid,
    reason: entry.reason || '',
    trace: traceLogPath,
  }));
  appendTraceLine(traceLogPath, formatServerEventLine('worker:attach', {
    agentId: entry.agentId,
    pid: entry.pid,
    reason: entry.reason || '',
  }));

  if (options.sameTerminalTrace !== true && options.autoOpenTraceWindows === true) {
    maybeOpenAgentTraceTerminal(entry.agentId, traceLogPath, options);
  }

  const contextState: TraceContext = {};
  const stdoutState = { buffer: '' };
  const stderrState = { buffer: '' };
  const writeTraceLine = (line) => {
    appendTraceLine(traceLogPath, line);
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
        writeTraceLine
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
        writeTraceLine
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
    appendTraceLine(traceLogPath, exitLine);
  });
}

function buildTraceOptions(rootDir: string, options: CliOptions = {}) {
  return {
    rootDir,
    sameTerminalTrace: options['same-terminal-trace'] === true,
    autoOpenTraceWindows: options['same-terminal-trace'] !== true && options['no-trace-window'] !== true,
    traceTerminal: normalizeTraceTerminal(options['trace-terminal']),
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

function appendTraceLine(filePath, line) {
  fs.appendFileSync(filePath, `${line}\n`, 'utf8');
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

function summarizeTickResult(result: AnyRecord) {
  const dueAgents = Array.isArray(result && result.dueAgents) ? result.dueAgents : [];
  const started = Array.isArray(result && result.started) ? result.started : [];
  const workers = Object.values((result && result.runtime && result.runtime.workers) || {}) as AnyRecord[];
  const active = workers
    .filter((worker) => worker && worker.status === 'running')
    .map((worker) => worker.agentId);

  return {
    due: dueAgents.length,
    started: started.length,
    running: active.length,
    idle: workers.filter((worker) => worker && worker.status === 'idle').length,
    active,
  };
}

function buildTickEventPayload({ id, sync, durationMs, result }: { id: any; sync: any; durationMs: any; result: AnyRecord }) {
  const summary = summarizeTickResult(result);
  const payload: AnyRecord = {
    id,
    sync: sync ? 'yes' : 'no',
    durationMs,
    due: summary.due,
    started: summary.started,
    running: summary.running,
    idle: summary.idle,
  };
  if (summary.active.length > 0) {
    payload.active = summary.active.join(',');
  }
  return payload;
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

function writePrefixedChunks(
  agentId,
  pid,
  streamName,
  pendingBuffer,
  chunk,
  contextState = {},
  writeLine = console.log,
  timestampFactory = () => new Date().toISOString()
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
  return remainder;
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
  const nextContext = extractWorkerContextFromLine(line);
  if (!nextContext) {
    updateWorkerErrorSummary(contextState, line);
    return contextState;
  }
  contextState.label = nextContext.label;
  contextState.value = nextContext.value;
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
        return {
          summary: String(payload.message).trim(),
          priority: 4,
        };
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
        return {
          summary: String(payload.summary).trim(),
          priority: 3,
        };
      }
    } catch (_) {
      return null;
    }
  }

  if (/^ERROR:\s+Command failed:/.test(text)) {
    return {
      summary: text.replace(/^ERROR:\s*/, ''),
      priority: 1,
    };
  }

  if (/^ERROR:\s+/.test(text)) {
    return {
      summary: text.replace(/^ERROR:\s*/, ''),
      priority: 2,
    };
  }

  if (/^(Error:|TypeError:|ReferenceError:|SyntaxError:)/.test(text)) {
    return {
      summary: text,
      priority: 2,
    };
  }

  return null;
}

function shouldIncludeWorkerExitError(code: number | null, contextState: TraceContext = {}) {
  return code != null && Number(code) !== 0 && Boolean(contextState.errorSummary);
}

function extractWorkerContextFromLine(line: string) {
  const match = String(line || '').match(/^\[runner\] ([^ ]+) (\{.*\})$/);
  if (!match) {
    return null;
  }

  const [, eventName, rawPayload] = match;
  let payload: AnyRecord;
  try {
    payload = JSON.parse(rawPayload) as AnyRecord;
  } catch (_) {
    return null;
  }

  if (
    (eventName === buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'start')
      || eventName === buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'error'))
      && payload && payload.taskId
  ) {
    return {
      label: 'task',
      value: String(payload.taskId),
    };
  }
  if (
    (eventName === buildRoleEventName(AGENT_ROLES.REVIEW, 'start')
      || eventName === buildRoleEventName(AGENT_ROLES.REVIEW, 'error'))
      && payload && payload.reviewTaskId
  ) {
    return {
      label: getRoleLabel(AGENT_ROLES.REVIEW),
      value: String(payload.reviewTaskId),
    };
  }
  return null;
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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}


;
;
;
;
;
;
;
;
;
;
;
;
;
export { main };
;
;
;
;
;
