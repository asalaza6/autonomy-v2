#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { resolveRootDir, runSchedulerTick } from '../orchestrator/index.js';
import { loadAutonomyEnv } from '../../env/index.js';
import { acquireServerLock } from '../../lock/index.js';
import type { CliOptions } from '../../types.js';
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

  process.on('SIGINT', () => { shutdown(0); });
  process.on('SIGTERM', () => { shutdown(0); });
  process.on('SIGHUP', () => { shutdown(0); });
  process.on('exit', cleanup);

  let lastSyncAt = 0;
  console.log(formatServerEventLine('server:start', {
    root: rootDir,
    pollMs,
    syncMs,
  }));
  console.log(formatServerEventLine('server:lock-acquired', { root: rootDir }));

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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

export { main };
