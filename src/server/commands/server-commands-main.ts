#!/usr/bin/env node

import crypto from 'crypto';
import { fileURLToPath } from 'url';
import type { CliOptions } from '../../types.js';
import { loadAutonomyEnv } from '../../env/env-main.js';
import { acquireServerLock } from '../../lock/lock-main.js';
import { resolveRootDir } from '../orchestrator/paths.js';
import { runSchedulerTick } from '../orchestrator/scheduler.js';
import { logTickResult } from './tick-log.js';
import { buildTraceOptions, formatServerEventLine } from './trace.js';
import { attachWorkerOutput } from './worker-streams.js';

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

function printServerHelp(): void {
  console.log(`
Autonomy v2 Server CLI

Usage:
  autonomy-v2-server <command> [options]

Commands:
  serve              Start the custom-agent polling scheduler
  tick               Run a single scheduler tick

Options:
  --help, -h         Show this help
  --json              Print JSON output for tick command
  --poll-ms <ms>     Poll interval in milliseconds (serve only, default: 2000)
  --trace-log-max-bytes <bytes>
                     Max bytes to keep per worker stream log (default: 5242880)
  --trace-log-trim-bytes <bytes>
                     Bytes retained after a stream log crosses the max (default: 2097152)
  --trace-line-max-bytes <bytes>
                     Max bytes retained from a single stream log line (default: 65536)
`);
}

async function main(argv: string[] = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  const rootDir = resolveRootDir(String(options.root || ''));
  if (options.help === true || command === 'help' || command === '-h' || command === '--help') {
    printServerHelp();
    return;
  }
  loadAutonomyEnv(rootDir);
  if (command === 'tick') {
    const result = runSchedulerTick(rootDir);
    if (options.json === true) console.log(JSON.stringify(result, null, 2));
    else console.log(`Tick complete. Started ${result.customAgentStarted.length} custom agent(s).`);
    return;
  }

  if (command !== 'serve') {
    throw new Error(`Unknown command "${command}". Use "serve" or "tick".`);
  }

  const pollMs = Number(options['poll-ms'] || '2000');
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error('--poll-ms must be a positive number.');
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

  process.on('SIGINT', () => { shutdown(0); });
  process.on('SIGTERM', () => { shutdown(0); });
  process.on('SIGHUP', () => { shutdown(0); });
  process.on('exit', cleanup);

  let tickRunning = false;
  let rerunRequested = false;
  const serverInstanceId = buildServerInstanceId();
  console.log(formatServerEventLine('server:start', {
    root: rootDir,
    pollMs,
    serverInstanceId,
  }));
  console.log(formatServerEventLine('server:lock-acquired', { root: rootDir }));
  const runTick = () => {
    if (tickRunning) {
      rerunRequested = true;
      console.log(formatServerEventLine('tick:skip-overlap', {
        nextId: tickCount + 1,
      }));
      return;
    }
    tickRunning = true;
    const tickId = tickCount + 1;
    try {
      const result = runSchedulerTick(rootDir, {
        streamWorkerOutput: true,
        serverInstanceId,
        onWorkerSpawn(entry) {
          attachWorkerOutput(attachedWorkers, entry, traceOptions);
        },
      });
      tickCount = tickId;
      consecutiveTickFailures = 0;
      logTickResult(result);
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
    tickRunning = false;
    if (rerunRequested) {
      rerunRequested = false;
      queueMicrotask(runTick);
    }
  };

  runTick();
  setInterval(runTick, pollMs);
}

function buildServerInstanceId() {
  return `srv-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

export {
main
};
