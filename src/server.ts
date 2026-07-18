#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { CliOptions, StartedCustomAgent } from './types.js';
import {
  acquireServerLock,
  extractError,
  loadAutonomyEnv,
  resolveRootDir,
  signalProcessGroup,
} from './runtime.js';
import { runSchedulerTick } from './custom-agents/scheduler.js';
import { terminateActiveCommands } from './custom-agents/command.js';

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (options.help === true || command === 'help') {
    printHelp();
    return null;
  }
  const rootDir = resolveRootDir(String(options.root || ''));
  loadAutonomyEnv(rootDir);
  const configPath = String(options.config || '');

  if (command === 'tick') {
    const result = await runSchedulerTick(rootDir, {
      configPath,
      detached: true,
      streamOutput: false,
    });
    const output = publicTickResult(result);
    if (options.json === true) {
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log(`Tick complete. Started ${output.started.length} custom agent(s).`);
    }
    return output;
  }
  if (command !== 'serve') {
    throw new Error(`Unknown command "${command}". Use "serve" or "tick".`);
  }

  const pollMs = positiveNumber(options['poll-ms'], 2_000, '--poll-ms');
  const releaseServerLock = acquireServerLock(rootDir);
  const children = new Map<number, ChildProcess>();
  const serverInstanceId = `srv-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let released = false;
  let shutdownStarted = false;
  let consecutiveFailures = 0;

  const releaseLock = () => {
    if (released) return;
    released = true;
    releaseServerLock();
  };
  const signalChildren = (signal: NodeJS.Signals) => {
    terminateActiveCommands(signal);
    children.forEach((child) => {
      try {
        signalProcessGroup(child.pid, signal);
      } catch {
        // Best-effort child shutdown.
      }
    });
  };
  const cleanup = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    signalChildren('SIGKILL');
    children.clear();
    releaseLock();
  };
  const shutdown = (code: number) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    stopped = true;
    if (timer) clearTimeout(timer);
    console.log(eventLine('server:shutdown', { code }));
    signalChildren('SIGTERM');
    setTimeout(() => {
      cleanup();
      process.exit(code);
    }, 2_000);
  };
  process.once('SIGINT', () => shutdown(0));
  process.once('SIGTERM', () => shutdown(0));
  process.once('SIGHUP', () => shutdown(0));
  process.once('exit', cleanup);

  const onSpawn = (start: StartedCustomAgent, child: ChildProcess) => {
    if (!child.pid) return;
    children.set(child.pid, child);
    if (shutdownStarted) {
      try {
        signalProcessGroup(child.pid, 'SIGTERM');
      } catch {
        // Cleanup will retry with SIGKILL.
      }
    }
    console.log(eventLine('custom-agent:start', {
      runtimeKey: start.runtimeKey,
      invocationId: start.invocationId,
      pid: child.pid,
    }));
    child.once('close', (code, signal) => {
      if (!shutdownStarted) children.delete(child.pid as number);
      console.log(eventLine('custom-agent:exit', {
        runtimeKey: start.runtimeKey,
        pid: child.pid,
        code: code ?? '-',
        signal: signal || '-',
      }));
    });
  };
  const scheduleNext = () => {
    if (!stopped) timer = setTimeout(() => void runTick(), pollMs);
  };
  const runTick = async () => {
    try {
      await runSchedulerTick(rootDir, {
        configPath,
        detached: false,
        streamOutput: true,
        serverInstanceId,
        onSpawn,
        shouldStop: () => stopped,
      });
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      console.error(eventLine('tick:error', {
        failures: consecutiveFailures,
        message: extractError(error),
      }));
      if (consecutiveFailures >= 3) {
        shutdown(1);
        return;
      }
    }
    scheduleNext();
  };

  console.log(eventLine('server:start', { root: rootDir, pollMs, serverInstanceId }));
  void runTick();
  return { rootDir, pollMs, serverInstanceId };
}

function publicTickResult(result: Awaited<ReturnType<typeof runSchedulerTick>>) {
  return {
    rootDir: result.rootDir,
    started: result.started,
    runtime: result.runtime,
  };
}

function parseCli(argv: string[]) {
  const options: CliOptions = {};
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      options[token.slice(2)] = next;
      index += 1;
    } else {
      options[token.slice(2)] = true;
    }
  }
  return { command: positionals[0] || 'serve', options };
}

function positiveNumber(value: unknown, fallback: number, label: string) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return number;
}

function eventLine(event: string, fields: Record<string, unknown>) {
  const values = Object.entries(fields)
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return [`[${new Date().toISOString()}]`, event, ...values].join(' | ');
}

function printHelp() {
  console.log(`Autonomy custom-agent server

Usage:
  autonomy-v2-server serve [--root <path>] [--config <path>] [--poll-ms <ms>]
  autonomy-v2-server tick [--root <path>] [--config <path>] [--json]

The server only polls and launches repository-defined custom agents.`);
}

export { main, parseCli, printHelp, publicTickResult };
