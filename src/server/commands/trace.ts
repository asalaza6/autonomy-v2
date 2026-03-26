import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AnyRecord, CliOptions } from '../../types.js';

const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];

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
  maybeOpenAgentTraceTerminal,
};
