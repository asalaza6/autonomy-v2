import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { getAgentDefinition, listAgentDefinitions, } from '../../src/agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES, listAgentRoleIds, } from '../../src/agents/role-catalog.js';
import { validateImplementationChecks } from '../../src/autonomy-v2/scaffold/index.js';
import { validateAutonomyConfig } from '../../src/config/index.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const REPO_ROOT = fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))
  ? PROJECT_ROOT
  : path.join(PROJECT_ROOT, '..');
const ROLE_CATALOG_PATH = path.join(SRC_ROOT, 'agents', 'role-catalog.js');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

test('role catalog is the only runtime source file containing raw role keywords', () => {
  const runtimeFiles = listJsFiles(SRC_ROOT).filter((filePath) => filePath !== ROLE_CATALOG_PATH);
  const offenders = runtimeFiles.filter((filePath) => {
    const source = fs.readFileSync(filePath, 'utf8');
    return /\b(pm|implementation|review)\b/.test(source);
  });
  assert.deepEqual(offenders, []);
});

test('public entrypoints are folder index files and src root has no top-level files', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  assert.equal(packageJson.main, './dist/src/autonomy-v2/index.js');
  assert.equal(packageJson.exports['.'], './dist/src/autonomy-v2/index.js');
  assert.equal(packageJson.exports['./server'], './dist/src/server/index.js');
  assert.equal(packageJson.exports['./worker'], undefined);
  assert.equal(packageJson.bin['autonomy-v2-worker'], undefined);

  const rootFiles = fs.readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(
    rootFiles,
    fs.existsSync(path.join(SRC_ROOT, 'types.ts'))
      ? ['globals.d.ts', 'types.ts']
      : ['types.js']
  );

  const rootDirs = fs.readdirSync(SRC_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(rootDirs, [
    'agents',
    'autonomy-v2',
    'codex',
    'config',
    'env',
    'github',
    'lock',
    'server',
    'sync',
  ]);
});

test('agent registry exposes one definition for each role', () => {
  assert.deepEqual(listAgentRoleIds(), [AGENT_ROLES.PM, AGENT_ROLES.IMPLEMENTATION, AGENT_ROLES.REVIEW]);
  assert.equal(listAgentDefinitions().length, 3);
  assert.equal(getAgentDefinition(AGENT_ROLES.PM).requiresRunner(), false);
  assert.equal(getAgentDefinition(AGENT_ROLES.IMPLEMENTATION).usesTrackedQueue(), true);
  assert.equal(getAgentDefinition(AGENT_ROLES.REVIEW).usesTrackedQueue(), true);
});

test('agent definitions build queue state by role', () => {
  const implementationQueue = getAgentDefinition(AGENT_ROLES.IMPLEMENTATION).buildQueueState({
    id: 'builder',
    role: AGENT_ROLES.IMPLEMENTATION,
  }, []);
  const reviewQueue = getAgentDefinition(AGENT_ROLES.REVIEW).buildQueueState({
    id: 'gate',
    role: AGENT_ROLES.REVIEW,
  }, []);

  assert.equal(implementationQueue.schemaVersion, 1);
  assert.equal(reviewQueue.schemaVersion, undefined);
  assert.equal(implementationQueue.role, AGENT_ROLES.IMPLEMENTATION);
  assert.equal(reviewQueue.role, AGENT_ROLES.REVIEW);
});

test('config validation still enforces role-specific constraints through definitions', () => {
  const config = {
    agents: [
      {
        id: 'pm-agent',
        role: AGENT_ROLES.PM,
        taskQueue: 'prompts/autonomous/v2/queues/pm-agent.json',
        systemPrompt: 'prompts/autonomous/v2/agents/pm-agent/system.md',
        gitIdentity: { name: 'pm', email: 'pm@example.com' },
      },
      {
        id: 'builder',
        role: AGENT_ROLES.IMPLEMENTATION,
        taskQueue: 'prompts/autonomous/v2/queues/builder.json',
        systemPrompt: 'prompts/autonomous/v2/agents/builder/system.md',
        gitIdentity: { name: 'builder', email: 'builder@example.com' },
      },
      {
        id: 'gate',
        role: AGENT_ROLES.REVIEW,
        taskQueue: 'prompts/autonomous/v2/queues/gate.json',
        systemPrompt: 'prompts/autonomous/v2/agents/gate/system.md',
        gitIdentity: { name: 'gate', email: 'gate@example.com' },
      },
    ],
  };

  const validated = validateAutonomyConfig(config, 'agents.json');
  assert.equal(validated.agents[0].taskQueue, 'prompts/autonomous/v2/queues/pm-agent.json');
  assert.equal(validated.agents[2].taskQueue, 'prompts/autonomous/v2/queues/gate.json');
});

test('agent definitions own role-specific scaffold prompts', () => {
  const config = {
    agents: [],
    integrationBranch: 'dev',
    productionBranch: 'main',
    projectName: 'example-repo',
  };

  const pmPrompt = getAgentDefinition(AGENT_ROLES.PM).buildSystemPrompt({
    id: 'pm-agent',
    role: AGENT_ROLES.PM,
  }, config);
  const implementationPrompt = getAgentDefinition(AGENT_ROLES.IMPLEMENTATION).buildSystemPrompt({
    id: 'builder',
    role: AGENT_ROLES.IMPLEMENTATION,
    checks: ['npm test'],
    include: ['src/**'],
  }, config);
  const reviewPrompt = getAgentDefinition(AGENT_ROLES.REVIEW).buildSystemPrompt({
    id: 'gate',
    role: AGENT_ROLES.REVIEW,
  }, config);

  assert.match(pmPrompt, /PRD inbox/);
  assert.match(implementationPrompt, /Required Checks/);
  assert.match(reviewPrompt, /Review Priorities/);
});

test('implementation scaffold validation is definition-backed', () => {
  assert.throws(() => validateImplementationChecks({
    agents: [
      {
        id: 'builder',
        role: AGENT_ROLES.IMPLEMENTATION,
        checks: [],
      },
    ],
  }, 'agents.json'));
});

function listJsFiles(rootDir) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      return listJsFiles(entryPath);
    }
    return entry.name.endsWith('.js') ? [entryPath] : [];
  });
}
