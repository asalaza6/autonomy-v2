import { extractExecError } from '../orchestrator/git.js';
import { getPaths, resolveRootDir, writeJson } from '../orchestrator/paths.js';
import { runWorkerOnce } from '../orchestrator/workers.js';
import { loadRuntime } from '../orchestrator/state.js';
import { loadAutonomyEnv } from '../../env/index.js';
import { acquireStateLock } from '../../lock/index.js';
import type { AnyRecord, CliOptions } from '../types.js';

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
    command: positionals[0] || 'run',
    options,
  };
}

async function main(argv: string[] = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (command !== 'run') {
    throw new Error(`Unknown command "${command}". Use "run".`);
  }

  const rootDir = resolveRootDir(String(options.root || ''));
  loadAutonomyEnv(rootDir);
  if (!options.agent) {
    throw new Error('Missing required option --agent');
  }

  let result = null;
  let error = null;
  try {
    logWorkerEvent(String(options.agent), 'start', { rootDir });
    result = runWorkerOnce(rootDir, String(options.agent));
    logWorkerEvent(String(options.agent), 'result', summarizeWorkerResult(result));
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result));
  } catch (caughtError) {
    error = caughtError;
    logWorkerEvent(String(options.agent), 'error', { message: extractExecError(caughtError) });
    throw caughtError;
  } finally {
    finalizeWorkerRuntime(rootDir, String(options.agent), result, error);
  }
}

function finalizeWorkerRuntime(rootDir, agentId, result, error) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    runtime.workers[agentId] = {
      agentId,
      ...(runtime.workers[agentId] || {}),
      status: 'idle',
      finishedAt: new Date().toISOString(),
      pid: null,
      lastResult: result || null,
      lastError: error ? extractExecError(error) : null,
    };
    writeJson(getPaths(rootDir).runtimeState, runtime);
  } finally {
    release();
  }
}

function logWorkerEvent(agentId: string, event: string, payload: AnyRecord = {}) {
  if (process.env.AUTONOMY_STREAM_WORKER_OUTPUT !== '1') {
    return;
  }
  const suffix = payload && Object.keys(payload).length > 0
    ? ` ${JSON.stringify(payload)}`
    : '';
  console.log(`[worker] ${agentId} ${event}${suffix}`);
}

function summarizeWorkerResult(result) {
  if (!result || typeof result !== 'object') {
    return {};
  }
  return {
    ok: result.ok === true,
    status: result.status || '',
    taskId: result.taskId || '',
    prId: result.prId || '',
    branch: result.branch || '',
    reason: result.reason || '',
  };
}

export { main };
