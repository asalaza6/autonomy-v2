#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { resolveRootDir } from '../orchestrator/paths.js';
import { runSchedulerTick } from '../orchestrator/scheduler.js';
import { loadAutonomyEnv } from '../../env/env-main.js';
import { acquireServerLock } from '../../lock/lock-main.js';
import type { CliOptions } from '../server-types.js';
import { logTickResult } from './tick-log.js';
import { formatServerEventLine, buildTraceOptions } from './trace.js';
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
  serve              Start the polling scheduler
  tick               Run a single scheduler tick

Options:
  --help, -h         Show this help
  --json              Print JSON output for tick command
  --inline            Run workers inline for tick command
  --control-plane-url <url>
                     Optional control-plane server to report scheduler heartbeats to
  --poll-ms <ms>     Poll interval in milliseconds (serve only, default: 2000)
  --sync-ms <ms>     Sync interval in milliseconds (serve only, default: 30000)
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
  const controlPlaneUrl = String(
    options['control-plane-url'] ||
    process.env.AUTONOMY_CONTROL_PLANE_SERVER_URL ||
    ''
  ).trim();

  if (command === 'tick') {
    let result;
    const shouldSuppressInlineWorkerStreamOutput = options.json === true && options.inline === true;
    const originalStreamWorkerOutput = process.env.AUTONOMY_STREAM_WORKER_OUTPUT;
    try {
      if (shouldSuppressInlineWorkerStreamOutput) {
        delete process.env.AUTONOMY_STREAM_WORKER_OUTPUT;
      }
      result = runSchedulerTick(rootDir, { inline: options.inline === true });
      if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Tick complete. Started ${result.started.length} worker(s).`);
        result.started.forEach((entry) => {
          console.log(`${entry.agentId} | ${entry.mode} | ${entry.reason}`);
        });
      }
    } finally {
      if (shouldSuppressInlineWorkerStreamOutput) {
        if (typeof originalStreamWorkerOutput === 'string') {
          process.env.AUTONOMY_STREAM_WORKER_OUTPUT = originalStreamWorkerOutput;
        } else {
          delete process.env.AUTONOMY_STREAM_WORKER_OUTPUT;
        }
      }
      await reportControlPlaneHeartbeat(controlPlaneUrl, 'scheduler tick complete');
    }
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

  process.on('SIGINT', () => { shutdown(0); });
  process.on('SIGTERM', () => { shutdown(0); });
  process.on('SIGHUP', () => { shutdown(0); });
  process.on('exit', cleanup);

  let lastSyncAt = 0;
  let tickRunning = false;
  let rerunRequested = false;
  console.log(formatServerEventLine('server:start', {
    root: rootDir,
    pollMs,
    syncMs,
  }));
  console.log(formatServerEventLine('server:lock-acquired', { root: rootDir }));
  void reportControlPlaneHeartbeat(controlPlaneUrl, 'scheduler started');

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
    void reportControlPlaneHeartbeat(controlPlaneUrl, 'scheduler tick complete');
    tickRunning = false;
    if (rerunRequested) {
      rerunRequested = false;
      queueMicrotask(runTick);
    }
  };

  runTick();
  setInterval(runTick, pollMs);
}

async function reportControlPlaneHeartbeat(controlPlaneUrl: string, note: string) {
  const target = String(controlPlaneUrl || '').trim();
  if (!target) {
    return;
  }

  try {
    const response = await fetch(new URL('/api/heartbeats/server', target), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        note,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text() || response.statusText);
    }
  } catch (error) {
    console.error(formatServerEventLine('server:heartbeat-failed', {
      message: error instanceof Error ? error.message : String(error),
      controlPlaneUrl: target,
    }));
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

export { main };
