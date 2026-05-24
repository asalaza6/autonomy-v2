#!/usr/bin/env node

import { spawn, type ChildProcess } from 'child_process';
import crypto from 'crypto';
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
  serve              Start the polling scheduler and companion control bridge
  tick               Run a single scheduler tick

Options:
  --help, -h         Show this help
  --json              Print JSON output for tick command
  --inline            Run workers inline for tick command
  --control-plane-url <url>
                     Control-plane server URL for scheduler heartbeats and bridge jobs
  --no-control-bridge
                     Do not start the companion control bridge alongside serve
  --no-control-plane Legacy alias for --no-control-bridge
  --control-bridge-repo-map <map>
                     Repo roots for the companion bridge, same format as autonomy-v2-control bridge --repo-map
  --control-bridge-poll-ms <ms>
                     Bridge poll interval in milliseconds (default: AUTONOMY_CONTROL_PLANE_BRIDGE_POLL_MS or 2000)
  --poll-ms <ms>     Poll interval in milliseconds (serve only, default: 2000)
  --sync-ms <ms>     Sync interval in milliseconds (serve only, default: 30000)
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
  let controlPlaneUrl = String(
    options['control-plane-url'] ||
    process.env.AUTONOMY_CONTROL_PLANE_SERVER_URL ||
    ''
  ).trim();

  if (command === 'tick') {
    let result;
    try {
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
  const companionControlBridge = buildCompanionControlBridgeLaunch(rootDir, options, controlPlaneUrl);
  if (!controlPlaneUrl && companionControlBridge.enabled) {
    controlPlaneUrl = companionControlBridge.serverUrl;
  }

  const releaseServerLock = acquireServerLock(rootDir);
  let released = false;
  let shuttingDown = false;
  let tickCount = 0;
  let consecutiveTickFailures = 0;
  const attachedWorkers = new Map();
  let controlBridgeChild: ChildProcess | null = null;
  const cleanup = () => {
    if (released) {
      return;
    }
    released = true;
    if (controlBridgeChild && !controlBridgeChild.killed) {
      try {
        controlBridgeChild.kill('SIGTERM');
      } catch (_) {
        // Best effort shutdown for the companion control-bridge child.
      }
    }
    controlBridgeChild = null;
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
      controlBridge: controlBridgeChild ? 'stopping' : '',
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
  const serverInstanceId = buildServerInstanceId();
  console.log(formatServerEventLine('server:start', {
    root: rootDir,
    pollMs,
    syncMs,
    serverInstanceId,
  }));
  console.log(formatServerEventLine('server:lock-acquired', { root: rootDir }));
  if (companionControlBridge.enabled) {
    controlBridgeChild = startCompanionControlBridge(rootDir, companionControlBridge);
  }
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
        serverInstanceId,
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

function buildServerInstanceId() {
  return `srv-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function buildCompanionControlBridgeLaunch(rootDir: string, options: CliOptions, controlPlaneUrl = '') {
  const enabled = shouldStartCompanionControlBridge(options, process.env);
  const serverUrl = String(
    controlPlaneUrl ||
    process.env.AUTONOMY_CONTROL_PLANE_SERVER_URL ||
    'http://127.0.0.1:3333'
  ).trim();
  const pollMs = Number(
    options['control-bridge-poll-ms'] ||
    process.env.AUTONOMY_CONTROL_PLANE_BRIDGE_POLL_MS ||
    '2000'
  );
  if (enabled && (!Number.isFinite(pollMs) || pollMs <= 0)) {
    throw new Error('--control-bridge-poll-ms must be a positive number.');
  }
  const repoMap = String(
    options['control-bridge-repo-map'] ||
    process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP ||
    ''
  ).trim();
  const controlMainPath = fileURLToPath(new URL('../control-plane/control-plane-main.js', import.meta.url));
  const args = [
    controlMainPath,
    'bridge',
    '--root',
    rootDir,
    '--server-url',
    serverUrl,
    '--poll-ms',
    String(pollMs),
  ];
  if (repoMap) {
    args.push('--repo-map', repoMap);
  }
  return {
    enabled,
    command: process.execPath,
    args,
    serverUrl,
    pollMs,
    repoMap,
  };
}

function shouldStartCompanionControlBridge(options: CliOptions, env: NodeJS.ProcessEnv = process.env) {
  if (
    options['no-control-bridge'] === true ||
    options['no-control-plane'] === true ||
    options['control-bridge'] === false ||
    options['control-plane'] === false
  ) {
    return false;
  }
  const setting = String(
    env.AUTONOMY_SERVER_CONTROL_BRIDGE ||
    env.AUTONOMY_START_CONTROL_BRIDGE ||
    env.AUTONOMY_SERVER_CONTROL_PLANE ||
    env.AUTONOMY_START_CONTROL_PLANE ||
    ''
  ).trim().toLowerCase();
  if (['0', 'false', 'no', 'off', 'disabled'].includes(setting)) {
    return false;
  }
  return true;
}

function startCompanionControlBridge(rootDir: string, launch: ReturnType<typeof buildCompanionControlBridgeLaunch>) {
  console.log(formatServerEventLine('control-bridge:start', {
    root: rootDir,
    serverUrl: launch.serverUrl,
    repoMap: launch.repoMap,
  }));
  const child = spawn(launch.command, launch.args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      AUTONOMY_CONTROL_BRIDGE_COMPANION: '1',
    },
  });
  child.on('error', (error) => {
    console.error(formatServerEventLine('control-bridge:error', {
      message: error.message,
    }));
  });
  child.on('exit', (code, signal) => {
    console.log(formatServerEventLine('control-bridge:exit', {
      code: typeof code === 'number' ? code : '',
      signal: signal || '',
    }));
  });
  return child;
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

export {
  buildCompanionControlBridgeLaunch,
  main,
  shouldStartCompanionControlBridge,
};
