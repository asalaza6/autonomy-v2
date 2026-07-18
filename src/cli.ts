import type { ChildProcess } from 'node:child_process';
import type { CliOptions } from './types.js';
import {
  loadAutonomyEnv,
  loadRuntime,
  resolveRootDir,
  signalProcessGroup,
} from './runtime.js';
import {
  listConfiguredCustomAgents,
  runSchedulerTick,
} from './custom-agents/scheduler.js';

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (!command || command === 'help' || options.help === true) {
    printHelp();
    return null;
  }
  const rootDir = resolveRootDir(String(options.root || ''));
  loadAutonomyEnv(rootDir);
  const configPath = String(options.config || '');

  if (command === 'custom-agent:list') {
    const agents = listConfiguredCustomAgents(rootDir, { configPath });
    const result = { runtimeKeys: agents.map((agent) => agent.runtimeKey), agents };
    print(options, result, () => {
      if (agents.length === 0) {
        console.log('No custom agents configured.');
      } else {
        agents.forEach((agent) => console.log(agent.runtimeKey));
      }
    });
    return result;
  }

  if (command === 'custom-agent:run') {
    const runtimeKey = requiredOption(options, 'runtime-key');
    const configured = listConfiguredCustomAgents(rootDir, { configPath });
    if (!configured.some((agent) => agent.runtimeKey === runtimeKey)) {
      throw new Error(
        `Unknown custom-agent runtime key "${runtimeKey}". Available: ${configured.map((agent) => agent.runtimeKey).join(', ') || 'none'}.`
      );
    }
    const tick = await runSchedulerTick(rootDir, {
      configPath,
      runtimeKey,
      maxStarts: 1,
      force: true,
      ignoreEnabled: true,
      detached: false,
      streamOutput: true,
    });
    const launch = tick.launched[0];
    if (!launch) {
      const status = latestPoolStatus(loadRuntime(rootDir), runtimeKey);
      const result = {
        runtimeKey,
        started: false,
        reason: status?.lastDecisionReason || 'custom agent did not request a run',
        status,
      };
      print(options, result, () => {
        console.log(`Custom agent ${runtimeKey} did not start: ${result.reason}`);
      });
      return result;
    }
    const exit = await waitForExit(launch.child);
    const runtime = loadRuntime(rootDir);
    const status = runtime.customAgents[launch.start.runtimeKey] || null;
    const invocation = runtime.customAgentInvocations[launch.start.invocationId] || null;
    const result = {
      runtimeKey,
      slotRuntimeKey: launch.start.runtimeKey,
      parallelSlot: launch.start.parallelSlot,
      started: true,
      invocationId: launch.start.invocationId,
      status,
      invocation,
      exit,
    };
    if (exit.code !== 0) {
      throw new Error(
        `Custom agent ${runtimeKey} exited ${exit.code ?? '-'}${exit.signal ? ` (${exit.signal})` : ''}.`
      );
    }
    print(options, result, () => console.log(`Ran custom agent ${runtimeKey}`));
    return result;
  }

  throw new Error(`Unknown command "${command}". Run "autonomy-v2 help".`);
}

function latestPoolStatus(runtime: ReturnType<typeof loadRuntime>, runtimeKey: string) {
  return Object.values(runtime.customAgents)
    .filter((status) => (status.baseRuntimeKey || status.runtimeKey) === runtimeKey)
    .sort((left, right) => (
      Date.parse(right.lastPollAt || '') - Date.parse(left.lastPollAt || '')
    ))[0] || null;
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
  return { command: positionals[0] || '', options };
}

function requiredOption(options: CliOptions, name: string) {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required option --${name}`);
  }
  return value.trim();
}

function print(options: CliOptions, value: unknown, fallback: () => void) {
  if (options.json === true) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    fallback();
  }
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    let killTimer: NodeJS.Timeout | null = null;
    const handlers = new Map<NodeJS.Signals, () => void>();
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      handlers.forEach((handler, signal) => process.off(signal, handler));
    };
    signals.forEach((signal) => {
      const handler = () => {
        if (killTimer) {
          signalProcessGroup(child.pid, 'SIGKILL');
          return;
        }
        signalProcessGroup(child.pid, signal);
        killTimer = setTimeout(() => signalProcessGroup(child.pid, 'SIGKILL'), 1_000);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    });
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, signal) => {
      cleanup();
      resolve({ code, signal });
    });
  });
}

function printHelp() {
  console.log(`Autonomy custom-agent CLI

Usage:
  autonomy-v2 custom-agent:list [--root <path>] [--config <path>] [--json]
  autonomy-v2 custom-agent:run --runtime-key <key> [--root <path>] [--config <path>] [--json]

The consumer repository owns agent decisions, prompts, tools, Git operations,
API calls, verification, and deployment through its lifecycle commands.`);
}

export { main, parseCli, printHelp };
