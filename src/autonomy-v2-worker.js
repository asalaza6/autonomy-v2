#!/usr/bin/env node

const {
  extractExecError,
  getPaths,
  loadRuntime,
  resolveRootDir,
  runWorkerOnce,
  writeJson,
} = require('./autonomy-v2-orchestrator');
const { loadAutonomyEnv } = require('./autonomy-v2-env');
const { acquireStateLock } = require('./autonomy-v2-lock');

function parseCli(argv) {
  const options = {};
  const positionals = [];

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

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  if (command !== 'run') {
    throw new Error(`Unknown command "${command}". Use "run".`);
  }

  const rootDir = resolveRootDir(options.root);
  loadAutonomyEnv(rootDir);
  if (!options.agent) {
    throw new Error('Missing required option --agent');
  }

  let result = null;
  let error = null;
  try {
    logWorkerEvent(options.agent, 'start', { rootDir });
    result = runWorkerOnce(rootDir, options.agent);
    logWorkerEvent(options.agent, 'result', summarizeWorkerResult(result));
    if (options.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(JSON.stringify(result));
  } catch (caughtError) {
    error = caughtError;
    logWorkerEvent(options.agent, 'error', { message: extractExecError(caughtError) });
    throw caughtError;
  } finally {
    finalizeWorkerRuntime(rootDir, options.agent, result, error);
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

function logWorkerEvent(agentId, event, payload = {}) {
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

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  finalizeWorkerRuntime,
  logWorkerEvent,
  main,
  parseCli,
  summarizeWorkerResult,
};
