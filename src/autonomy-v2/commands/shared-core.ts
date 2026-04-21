import fs from 'fs';
import path from 'path';
import { DEFAULT_SYNC_STATE } from '../../sync/sync-constants.js';
import type { AnyRecord, AutonomyConfig } from '../autonomy-types.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_PACKAGE_ROOT = path.join(__dirname, '..', '..', '..');
const SOURCE_PACKAGE_ROOT = path.join(DIST_PACKAGE_ROOT, '..');
const PACKAGE_ROOT = fs.existsSync(path.join(DIST_PACKAGE_ROOT, 'templates'))
  ? DIST_PACKAGE_ROOT
  : SOURCE_PACKAGE_ROOT;
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, 'templates', 'prompts', 'autonomous', 'v2');
const DEFAULT_AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const DEFAULT_RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const DEFAULT_AUTONOMY_ENV = [
  'AUTONOMY_INITIALIZED=1',
  'GITHUB_TOKEN=',
  '',
].join('\n');
const DEFAULT_GITIGNORE = [
  '# System-generated default ignore file for autonomy-v2.',
  '# Keep this file aligned with repository bootstrap defaults.',
  '',
  '# Node / tooling artifacts',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.DS_Store',
  '',
  '# Env files',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.publish',
  '.env.publish.local',
  '',
  '# Autonomy runtime state',
  '.autonomy/',
  '.tooling/',
  '',
  '# Autonomy local environment placeholder',
  '.env.autonomy',
  '',
  '# Generated export graph artifacts',
  'docs/export-graph.*',
  '',
].join('\n');
const GENERATED_TEMPLATE_FILES = {
  'state/prs.json': () => `${JSON.stringify({ pullRequests: [] }, null, 2)}\n`,
  'state/branch-locks.json': () => `${JSON.stringify({ locks: [] }, null, 2)}\n`,
  'state/spec-sync.json': () => `${JSON.stringify(DEFAULT_SYNC_STATE, null, 2)}\n`,
  'state/runtime.json': () => `${JSON.stringify({ workers: {} }, null, 2)}\n`,
  '.env.autonomy': () => DEFAULT_AUTONOMY_ENV,
  '.gitignore': () => DEFAULT_GITIGNORE,
};
const BASE_TEMPLATE_FILES = [
  '.env.autonomy',
  '.gitignore',
  'README.md',
  'project-context.md',
  'config/agents.json',
  'config/control-plane.json',
  'config/sprint.json',
  'state/prs.json',
  'state/branch-locks.json',
  'state/spec-sync.json',
  'state/runtime.json',
  'specs/README.md',
  'specs/prd-state/README.md',
  'specs/prds/archived/README.md',
];

function getAutonomyPaths(rootDir) {
  const repoAutonomyDir = path.join(rootDir, ...DEFAULT_AUTONOMY_SEGMENTS);
  const runtimeAutonomyDir = path.join(rootDir, ...DEFAULT_RUNTIME_SEGMENTS);
  const configDir = path.join(repoAutonomyDir, 'config');
  const stateDir = path.join(runtimeAutonomyDir, 'state');
  return {
    repoAutonomyDir,
    runtimeAutonomyDir,
    configDir,
    stateDir,
    queuesDir: path.join(stateDir, 'queues'),
    agentsConfig: path.join(configDir, 'agents.json'),
    sprintConfig: path.join(configDir, 'sprint.json'),
    prsState: path.join(stateDir, 'prs.json'),
    branchLocksState: path.join(stateDir, 'branch-locks.json'),
    specSyncState: path.join(stateDir, 'spec-sync.json'),
    runtimeState: path.join(stateDir, 'runtime.json'),
  };
}

function readJson<T = any>(filePath: string, fallbackValue?: T): T {
  if (!fs.existsSync(filePath)) {
    if (arguments.length >= 2) {
      return JSON.parse(JSON.stringify(fallbackValue)) as T;
    }
    throw new Error(`Missing JSON file: ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getAgentLogPath(rootDir, agentId) {
  return path.join(rootDir, ...DEFAULT_RUNTIME_SEGMENTS, 'agents', agentId, 'log.md');
}

function appendAgentLog(rootDir: string, config: AutonomyConfig, agentId: string, event: string, payload: AnyRecord = {}) {
  getAgent(config, agentId);
  const logPath = getAgentLogPath(rootDir, agentId);
  ensureDir(path.dirname(logPath));
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${agentId} Log\n`, 'utf8');
  }

  const lines = [
    '',
    `## ${new Date().toISOString()} ${event}`,
  ];

  if (payload.summary) {
    lines.push(payload.summary);
  }

  appendLogSection(lines, 'Input', payload.input);
  appendLogSection(lines, 'Output', payload.output);
  fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
}

function appendLogSection(lines, heading, value) {
  if (typeof value === 'undefined') {
    return;
  }

  lines.push(`### ${heading}`);
  if (typeof value === 'string') {
    lines.push('```text');
    lines.push(value);
    lines.push('```');
    return;
  }

  lines.push('```json');
  lines.push(JSON.stringify(value, null, 2));
  lines.push('```');
}

function getAgentPersona(agent) {
  return agent.personaName || agent.id;
}

function buildPersonaTag(agent) {
  return `[${getAgentPersona(agent)}]`;
}

function ensurePrefixed(value, prefix) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return prefix;
  }
  return trimmed.startsWith(`${prefix} `) ? trimmed : `${prefix} ${trimmed}`;
}

function buildPersonaPrTitle(agent, title) {
  return ensurePrefixed(title, buildPersonaTag(agent));
}

function buildPersonaPrBody(agent, task, sprint, body) {
  const trimmedBody = String(body || '').trim();
  const metadata = [
    '<!-- autonomy-persona -->',
    `Agent: ${getAgentPersona(agent)}`,
    `Task: ${task.id}`,
    `Scope: ${(agent.include || []).join(', ') || 'repo-scoped'}`,
    `Run: ${task.sprintId || sprint.sprintId || 'shared'}`,
  ].join('\n');

  if (!trimmedBody) {
    return metadata;
  }

  return `${trimmedBody}\n\n${metadata}`;
}

function buildSignedReviewSummary(agent, summary) {
  const trimmed = String(summary || '').trim();
  const signature = `${agent.commentSignature || getAgentPersona(agent)}:`;
  if (!trimmed) {
    return signature;
  }
  return trimmed.startsWith(signature) ? trimmed : `${signature}\n\n${trimmed}`;
}

function buildMergeCommitTitle(actor, pr) {
  return `${buildPersonaTag(actor)} merge ${pr.title}`;
}

function buildPullRequestLabels(agent, baseBranch) {
  const labels = new Set();
  labels.add(`agent:${slugify(getAgentPersona(agent)).replace(/-agent$/, '')}`);
  labels.add(`target:${slugify(baseBranch)}`);
  for (const label of agent.prLabels || []) {
    if (label) {
      labels.add(label);
    }
  }
  return Array.from(labels);
}

function getAgent(config, agentId) {
  const agent = (config.agents || []).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent "${agentId}".`);
  }
  return agent;
}

function getPr(prState, prId) {
  const pr = prState.pullRequests.find((candidate) => candidate.id === prId);
  if (!pr) {
    throw new Error(`Unknown PR "${prId}".`);
  }
  return pr;
}

function getStringOption(options, key, fallbackValue = '') {
  if (!Object.prototype.hasOwnProperty.call(options, key)) {
    return fallbackValue;
  }
  const value = options[key];
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (value[index] !== true) {
        return String(value[index]);
      }
    }
    return fallbackValue;
  }
  if (value === true) {
    return fallbackValue;
  }
  return String(value);
}

function requireOption(options, key) {
  const value = getStringOption(options, key, '');
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function getListOption(options, key) {
  if (!Object.prototype.hasOwnProperty.call(options, key)) {
    return [];
  }

  const raw = Array.isArray(options[key]) ? options[key] : [options[key]];
  return raw
    .filter((value) => value !== true)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function printOutput(options, payload, printer) {
  if (options.json === true) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printer();
}

function countBy(items, key) {
  return items.reduce((accumulator, item) => {
    const value = item[key] || 'unknown';
    accumulator[value] = (accumulator[value] || 0) + 1;
    return accumulator;
  }, {});
}

function formatCountSummary(counts) {
  return Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function normalizeLaneKey(record) {
  if (!record) {
    return '';
  }
  if (record.laneKey) {
    return String(record.laneKey);
  }
  if (record.prdId && record.agentId) {
    return `${record.prdId}:${record.agentId}`;
  }
  return '';
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function ensureInitialized(rootDir) {
  const paths = getAutonomyPaths(rootDir);
  if (!fs.existsSync(paths.agentsConfig)) {
    throw new Error(`Autonomy v2 is not initialized under ${paths.repoAutonomyDir}. Run "autonomy-v2 init".`);
  }
}
export {
  BASE_TEMPLATE_FILES,
  DEFAULT_AUTONOMY_SEGMENTS,
  DEFAULT_RUNTIME_SEGMENTS,
  GENERATED_TEMPLATE_FILES,
  TEMPLATE_ROOT,
  appendAgentLog,
  buildMergeCommitTitle,
  buildPersonaPrBody,
  buildPersonaPrTitle,
  buildPullRequestLabels,
  buildSignedReviewSummary,
  countBy,
  ensureDir,
  ensureInitialized,
  formatCountSummary,
  getAgent,
  getAgentLogPath,
  getAutonomyPaths,
  getListOption,
  getPr,
  getStringOption,
  normalizeLaneKey,
  printOutput,
  readJson,
  requireOption,
  slugify,
  writeJson,
};
