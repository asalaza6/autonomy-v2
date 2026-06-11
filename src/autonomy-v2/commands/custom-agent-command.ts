import fs from 'fs';
import path from 'path';
import { acquireStateLock } from '../../lock/lock-main.js';
import {
  listConfiguredCustomAgents,
  markCustomAgentSpawnFailed,
  markCustomAgentSpawned,
  pollCustomAgents,
  setCustomAgentEnabledOverride,
  spawnCustomAgentProcess,
} from '../../server/orchestrator/custom-agents.js';
import { loadRuntime, writeRuntime } from '../../server/orchestrator/orchestrator-state.js';
import { buildTraceOptions } from '../../server/commands/trace.js';
import { attachWorkerOutput } from '../../server/commands/worker-streams.js';
import { ensureDir, ensureInitialized, printOutput, requireOption } from './shared-core.js';

const DEFAULT_RESET_WORKSPACE_FILES = ['context.md', 'notes.md', 'recent-summary.md'];
const RESET_FILE_STARTERS = {
  'context.md': [
    '# Custom Agent Context',
    '',
    'This workspace has been reset for a fresh custom-agent run.',
    '',
    '- Treat archived files as historical reference only.',
    '- Use current repository files, runtime inputs, and tool responses as the source of truth.',
    '- Record new verified context here as it is established.',
    '',
  ].join('\n'),
  'notes.md': [
    '# Notes',
    '',
    'Fresh reset. Add new verified notes from future custom-agent runs here.',
    '',
  ].join('\n'),
  'recent-summary.md': [
    '# Recent Summary',
    '',
    'Fresh reset. No recent workspace summary has been established yet.',
    '',
  ].join('\n'),
};

function run(rootDir, options = {}, command = 'custom-agent:run') {
  ensureInitialized(rootDir);
  if (command === 'custom-agent:list') {
    return handleCustomAgentList(rootDir, options);
  }
  if (command === 'custom-agent:toggle') {
    return handleCustomAgentToggle(rootDir, options);
  }
  if (command === 'custom-agent:reset') {
    return handleCustomAgentReset(rootDir, options);
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

function handleCustomAgentReset(rootDir, options) {
  const runtimeKey = requireSingleRuntimeKey(options);
  const resetOptions = {
    archiveExisting: options['archive-existing'] === true,
    clearContext: options['clear-context'] === true,
    clearNotes: options['clear-notes'] === true,
    clearRecentSummary: options['clear-recent-summary'] === true,
  };
  if (!resetOptions.archiveExisting && !resetOptions.clearContext && !resetOptions.clearNotes && !resetOptions.clearRecentSummary) {
    throw new Error('Provide at least one of --archive-existing, --clear-context, --clear-notes, or --clear-recent-summary.');
  }

  const runtime = loadRuntime(rootDir);
  const agents = listConfiguredCustomAgents(rootDir, runtime);
  const agent = agents.find((entry) => entry.runtimeKey === runtimeKey) || null;
  if (!agent) {
    const available = agents.map((entry) => entry.runtimeKey);
    throw new Error(`Unknown custom agent runtime key "${runtimeKey}". Available runtime keys: ${available.join(', ') || 'none'}.`);
  }

  const workspace = String(agent.workspacePath || '').trim();
  if (!workspace) {
    throw new Error(`Custom agent ${runtimeKey} has no configured writable workspace.`);
  }

  ensureWorkspaceInsideRoot(rootDir, workspace);
  ensureDir(workspace);

  const writableFiles = resolveResetWritableFiles(agent);
  let archiveDirectory = null;
  const archivedFiles: string[] = [];
  const skippedMissingFiles: string[] = [];
  if (resetOptions.archiveExisting) {
    archiveDirectory = path.join(workspace, 'archive', `reset-${formatResetTimestamp()}`);
    ensureDir(archiveDirectory);
    writableFiles.forEach((relativeFile) => {
      const sourcePath = resolveWorkspaceFile(workspace, relativeFile);
      if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
        skippedMissingFiles.push(relativeFile);
        return;
      }
      const archivePath = resolveWorkspaceFile(archiveDirectory, relativeFile);
      ensureDir(path.dirname(archivePath));
      fs.copyFileSync(sourcePath, archivePath);
      archivedFiles.push(relativeFile);
    });
  }

  const rewrittenFiles: string[] = [];
  if (resetOptions.clearContext) {
    writeStarterFile(workspace, 'context.md');
    rewrittenFiles.push('context.md');
  }
  if (resetOptions.clearNotes) {
    writeStarterFile(workspace, 'notes.md');
    rewrittenFiles.push('notes.md');
  }
  if (resetOptions.clearRecentSummary) {
    writeStarterFile(workspace, 'recent-summary.md');
    rewrittenFiles.push('recent-summary.md');
  }

  const payload = {
    runtimeKey,
    workspace,
    archiveDirectory,
    archivedFiles,
    rewrittenFiles,
    skippedMissingFiles,
  };
  printOutput(options, payload, () => {
    console.log(`Reset custom agent ${runtimeKey}`);
    console.log(`Workspace: ${workspace}`);
    console.log(`Archived files: ${formatFileSummary(archivedFiles)}`);
    console.log(`Rewritten files: ${formatFileSummary(rewrittenFiles)}`);
    console.log(`Skipped missing files: ${formatFileSummary(skippedMissingFiles)}`);
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

  let child;
  try {
    child = spawnCustomAgentProcess(rootDir, pendingStart, {
      streamOutput: true,
    });
  } catch (error) {
    markFailedCustomAgentSpawn(rootDir, pendingStart, error);
    throw error;
  }
  const pid = child && typeof child === 'object' ? child.pid : null;
  markSpawnedCustomAgent(rootDir, pendingStart, pid);
  const attachedWorkers = new Map();
  attachWorkerOutput(attachedWorkers, {
    agentId: pendingStart.agentId,
    mode: 'custom-agent',
    reason: 'custom-agent',
    pid,
    child,
    conversation: pendingStart.conversation || null,
  }, buildTraceOptions(rootDir, options));
  const exit = await waitForChildExit(child);
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
    exit,
  };
  if (exit.code !== 0) {
    throw new Error(`Custom agent ${runtimeKey} exited ${exit.code == null ? '-' : exit.code}${exit.signal ? ` (${exit.signal})` : ''}.`);
  }
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

function requireSingleRuntimeKey(options) {
  const raw = options['runtime-key'];
  if (Array.isArray(raw)) {
    throw new Error('Provide exactly one --runtime-key. Multiple --runtime-key flags are not supported.');
  }
  if (typeof raw === 'undefined' || raw === true) {
    throw new Error('Missing required option --runtime-key');
  }
  const value = String(raw || '').trim();
  if (!value) {
    throw new Error('Missing required option --runtime-key');
  }
  if (value.includes(',')) {
    throw new Error('Provide exactly one --runtime-key. Comma-separated runtime keys are not supported.');
  }
  return value;
}

function resolveResetWritableFiles(agent) {
  const configuredFiles = Array.isArray(agent.workspaceReadWrite)
    ? agent.workspaceReadWrite.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const files = configuredFiles.length > 0 ? configuredFiles : DEFAULT_RESET_WORKSPACE_FILES;
  return Array.from(new Set<string>(files.map(normalizeWorkspaceRelativeFile)));
}

function normalizeWorkspaceRelativeFile(value) {
  const normalized = path.normalize(String(value || '').trim());
  if (!normalized || path.isAbsolute(normalized) || normalized.startsWith('..')) {
    throw new Error(`Custom agent writable file "${value}" must be relative to the workspace.`);
  }
  return normalized;
}

function ensureWorkspaceInsideRoot(rootDir, workspace) {
  const relative = path.relative(rootDir, workspace);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Custom agent workspace must resolve inside the repository root: ${workspace}`);
  }
}

function resolveWorkspaceFile(workspace, relativeFile) {
  const normalizedFile = normalizeWorkspaceRelativeFile(relativeFile);
  const resolvedPath = path.resolve(workspace, normalizedFile);
  const relative = path.relative(workspace, resolvedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Custom agent workspace file must resolve inside the workspace: ${relativeFile}`);
  }
  return resolvedPath;
}

function writeStarterFile(workspace, relativeFile) {
  const targetPath = resolveWorkspaceFile(workspace, relativeFile);
  ensureDir(path.dirname(targetPath));
  fs.writeFileSync(targetPath, RESET_FILE_STARTERS[relativeFile], 'utf8');
}

function formatResetTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function formatFileSummary(files) {
  return files.length > 0 ? files.join(', ') : 'none';
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

function markSpawnedCustomAgent(rootDir, entry, pid) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    markCustomAgentSpawned(runtime, entry, pid);
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function markFailedCustomAgentSpawn(rootDir, entry, error) {
  const release = acquireStateLock(rootDir);
  try {
    const runtime = loadRuntime(rootDir);
    markCustomAgentSpawnFailed(runtime, entry, error);
    writeRuntime(rootDir, runtime);
  } finally {
    release();
  }
}

function waitForChildExit(child) {
  return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    if (!child || typeof child !== 'object') {
      resolve({ code: null, signal: null });
      return;
    }
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

export { run };
