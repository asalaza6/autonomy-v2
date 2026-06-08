import process from 'process';
import { acquireStateLock } from '../../lock/lock-main.js';
import {
  listConfiguredCustomAgents,
  markCustomAgentSpawned,
  pollCustomAgents,
  setCustomAgentEnabledOverride,
} from '../../server/orchestrator/custom-agents.js';
import { loadRuntime, writeRuntime } from '../../server/orchestrator/orchestrator-state.js';
import { main as runCustomAgentWorker } from '../../server/custom-agents/custom-agent-worker.js';
import { ensureInitialized, printOutput, requireOption } from './shared-core.js';

function run(rootDir, options = {}, command = 'custom-agent:run') {
  ensureInitialized(rootDir);
  if (command === 'custom-agent:list') {
    return handleCustomAgentList(rootDir, options);
  }
  if (command === 'custom-agent:toggle') {
    return handleCustomAgentToggle(rootDir, options);
  }
  return handleCustomAgentRun(rootDir, options);
}

function handleCustomAgentList(rootDir, options) {
  const runtime = loadRuntime(rootDir);
  const agents = listConfiguredCustomAgents(rootDir, runtime);
  const payload = {
    runtimeKeys: agents.map((agent) => agent.runtimeKey),
    agents,
  };
  printOutput(options, payload, () => {
    if (agents.length === 0) {
      console.log('No custom agents configured.');
      return;
    }
    agents.forEach((agent) => {
      console.log(agent.runtimeKey);
    });
  });
  return payload;
}

function handleCustomAgentToggle(rootDir, options) {
  const runtimeKey = requireOption(options, 'runtime-key');
  const enabled = resolveEnabledOption(options);
  const agent = setCustomAgentEnabledOverride(rootDir, runtimeKey, enabled);
  const payload = {
    runtimeKey,
    enabled,
    agent,
  };
  printOutput(options, payload, () => {
    console.log(`${enabled ? 'Enabled' : 'Disabled'} custom agent ${runtimeKey}`);
  });
  return payload;
}

async function handleCustomAgentRun(rootDir, options) {
  const runtimeKey = requireOption(options, 'runtime-key');
  const configuredAgent = findConfiguredCustomAgent(rootDir, runtimeKey);
  if (!configuredAgent) {
    throw new Error(`Unknown custom agent runtime key "${runtimeKey}".`);
  }

  const pollResult = pollSingleCustomAgent(rootDir, runtimeKey);
  const pendingStart = pollResult.pendingSpawnStarts[0] || null;
  if (!pendingStart) {
    const runtime = loadRuntime(rootDir);
    const latestAgent = findConfiguredCustomAgent(rootDir, runtimeKey, runtime);
    const payload = {
      runtimeKey,
      started: false,
      reason: latestAgent && (latestAgent.lastDecisionReason || latestAgent.detail) || 'custom agent did not request a run',
      agent: latestAgent || configuredAgent,
    };
    printOutput(options, payload, () => {
      console.log(`Custom agent ${runtimeKey} did not start: ${payload.reason}`);
    });
    return payload;
  }

  markInlineCustomAgentSpawned(rootDir, pendingStart);
  await runCustomAgentWorker(['run', '--context', pendingStart.runtimeContextPath]);
  const runtime = loadRuntime(rootDir);
  const status = runtime.customAgents && runtime.customAgents[runtimeKey] || null;
  const invocation = pendingStart.invocationId && runtime.customAgentInvocations
    ? runtime.customAgentInvocations[pendingStart.invocationId] || null
    : null;
  const payload = {
    runtimeKey,
    started: true,
    invocationId: pendingStart.invocationId,
    conversationKey: pendingStart.conversation && pendingStart.conversation.key || '',
    conversationId: status && (status.conversationId || status.lastConversationId) || '',
    status,
    invocation,
  };
  printOutput(options, payload, () => {
    console.log(`Ran custom agent ${runtimeKey}`);
    if (payload.conversationKey) {
      console.log(`Conversation key: ${payload.conversationKey}`);
    }
    console.log(`Conversation id: ${payload.conversationId || 'new'}`);
  });
  return payload;
}

function resolveEnabledOption(options) {
  if (options.enable === true) {
    return true;
  }
  if (options.disable === true) {
    return false;
  }
  const raw = String(options.enabled ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') {
    return true;
  }
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') {
    return false;
  }
  throw new Error('Provide --enable, --disable, or --enabled <true|false>.');
}

function findConfiguredCustomAgent(rootDir, runtimeKey, runtime = null) {
  return listConfiguredCustomAgents(rootDir, runtime).find((agent) => agent.runtimeKey === runtimeKey) || null;
}

function pollSingleCustomAgent(rootDir, runtimeKey) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    const result = pollCustomAgents(rootDir, runtime, {
      customAgentRuntimeKey: runtimeKey,
      forceCustomAgentPoll: true,
      ignoreCustomAgentEnabled: true,
    });
    writeRuntime(rootDir, runtime);
    return result;
  } finally {
    release();
  }
}

function markInlineCustomAgentSpawned(rootDir, entry) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    markCustomAgentSpawned(runtime, entry, process.pid);
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

export { run };
