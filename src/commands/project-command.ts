import fs from 'node:fs';
import path from 'node:path';
import type { CliOptions, RuntimeState } from '../types.js';
import {
  ensureDir,
  getRuntimePath,
  loadRuntime,
  resolveInsideRoot,
  writeRuntime,
} from '../runtime.js';
import {
  DEFAULT_CONFIG_PATH,
  loadCustomAgentConfig,
} from '../custom-agents/config.js';
import {
  listConfiguredCustomAgents,
  runSchedulerTick,
} from '../custom-agents/scheduler.js';
import { getServerStatus } from './server-command.js';

const GITIGNORE_ENTRIES = [
  '.autonomy/',
  '.env.autonomy',
  '.env.autonomy.local',
];

function runInit(rootDir: string, options: CliOptions = {}) {
  const created: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
  const updated: string[] = [];
  const configPath = resolveConfigPath(rootDir, options);
  const runtimePath = getRuntimePath(rootDir);
  const envPath = path.join(rootDir, '.env.autonomy');
  const gitignorePath = path.join(rootDir, '.gitignore');

  if (!fs.existsSync(configPath)) {
    ensureDir(path.dirname(configPath));
    fs.writeFileSync(configPath, `${JSON.stringify(defaultConfig(), null, 2)}\n`, 'utf8');
    created.push(relative(rootDir, configPath));
  } else {
    skipped.push(relative(rootDir, configPath));
  }
  const config = loadCustomAgentConfig(rootDir, relative(rootDir, configPath));

  if (!fs.existsSync(runtimePath)) {
    writeRuntime(rootDir, emptyRuntime());
    created.push(relative(rootDir, runtimePath));
  } else {
    loadRuntime(rootDir);
    skipped.push(relative(rootDir, runtimePath));
  }

  const envResult = ensureInitializedEnv(envPath);
  if (envResult === 'created') created.push(relative(rootDir, envPath));
  if (envResult === 'updated') updated.push(relative(rootDir, envPath));
  if (envResult === 'skipped') skipped.push(relative(rootDir, envPath));

  const ignoreResult = mergeGitignore(gitignorePath);
  if (ignoreResult === 'created') created.push(relative(rootDir, gitignorePath));
  if (ignoreResult === 'updated') updated.push(relative(rootDir, gitignorePath));
  if (ignoreResult === 'skipped') skipped.push(relative(rootDir, gitignorePath));

  return {
    rootDir,
    created,
    skipped,
    removed,
    updated,
    configPath,
    runtimePath,
    agentCount: config?.agents.length || 0,
    refreshed: options.force === true,
  };
}

function runRefresh(rootDir: string, options: CliOptions = {}) {
  return runInit(rootDir, { ...options, force: true });
}

async function runStatus(rootDir: string, options: CliOptions = {}) {
  const configPath = resolveConfigPath(rootDir, options);
  const configExists = fs.existsSync(configPath);
  let synced = false;
  if (options.sync === true && configExists) {
    await runSchedulerTick(rootDir, {
      configPath: relative(rootDir, configPath),
      maxStarts: 0,
      detached: true,
      streamOutput: false,
    });
    synced = true;
  }
  const config = configExists
    ? loadCustomAgentConfig(rootDir, relative(rootDir, configPath))
    : null;
  const runtime = loadRuntime(rootDir);
  const agents = config
    ? listConfiguredCustomAgents(rootDir, {
      configPath: relative(rootDir, configPath),
      runtime,
    })
    : [];
  const invocationValues = Object.values(runtime.customAgentInvocations);
  return {
    rootDir,
    initialized: configExists,
    synced,
    config: {
      path: configPath,
      exists: configExists,
      enabled: config?.enabled ?? false,
      agentCount: agents.length,
    },
    server: getServerStatus(rootDir),
    agents,
    runtime: {
      path: getRuntimePath(rootDir),
      runningAgents: agents.filter((agent) => agent.running).length,
      invocationCounts: {
        running: invocationValues.filter((entry) => entry.status === 'running').length,
        completed: invocationValues.filter((entry) => entry.status === 'completed').length,
        failed: invocationValues.filter((entry) => entry.status === 'failed').length,
      },
    },
  };
}

function resolveConfigPath(rootDir: string, options: CliOptions) {
  const configured = stringOption(options, 'config')
    || String(process.env.AUTONOMY_CUSTOM_AGENTS_CONFIG || '').trim()
    || DEFAULT_CONFIG_PATH;
  return resolveInsideRoot(rootDir, configured, 'custom-agent config');
}

function defaultConfig() {
  return {
    schemaVersion: 1,
    enabled: true,
    kind: 'project-agents',
    promptRole: 'project maintenance agent',
    agents: [],
  };
}

function emptyRuntime(): RuntimeState {
  return {
    schemaVersion: 1,
    customAgents: {},
    customAgentInvocations: {},
  };
}

function ensureInitializedEnv(envPath: string) {
  ensureDir(path.dirname(envPath));
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, 'AUTONOMY_INITIALIZED=1\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    return 'created';
  }
  const content = fs.readFileSync(envPath, 'utf8');
  const hasInitialized = content
    .split(/\r?\n/)
    .some((line) => /^\s*AUTONOMY_INITIALIZED\s*=/.test(line));
  fs.chmodSync(envPath, 0o600);
  if (hasInitialized) return 'skipped';
  const separator = content && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(envPath, `${separator}AUTONOMY_INITIALIZED=1\n`, 'utf8');
  return 'updated';
}

function mergeGitignore(gitignorePath: string) {
  const exists = fs.existsSync(gitignorePath);
  const content = exists ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const existing = new Set(
    content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  );
  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return 'skipped';
  const separator = content
    ? content.endsWith('\n') ? '' : '\n'
    : '';
  fs.writeFileSync(gitignorePath, `${content}${separator}${missing.join('\n')}\n`, 'utf8');
  return exists ? 'updated' : 'created';
}

function relative(rootDir: string, filePath: string) {
  return path.relative(rootDir, filePath) || '.';
}

function stringOption(options: CliOptions, name: string) {
  const value = options[name];
  return typeof value === 'string' ? value.trim() : '';
}

export {
  runInit,
  runRefresh,
  runStatus,
};
