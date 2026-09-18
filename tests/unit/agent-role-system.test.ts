import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

import { AGENT_ROLES, } from '../../src/agents/role-catalog.js';
import { validateAutonomyConfig } from '../../src/config/config-main.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const REPO_ROOT = fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))
  ? PROJECT_ROOT
  : path.join(PROJECT_ROOT, '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

test('public entrypoints stay explicit and src root has no extra top-level files', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  assert.equal(packageJson.main, './dist/src/autonomy-v2/index.js');
  assert.equal(packageJson.exports['.'], './dist/src/autonomy-v2/index.js');
  assert.equal(packageJson.exports['./server'], './dist/src/server/server-main.js');
  assert.equal(packageJson.exports['./control'], undefined);
  assert.equal(packageJson.bin['autonomy-v2-control'], undefined);
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
    'frontend',
    'github',
    'lock',
    'server',
    'sync',
  ]);
});

test('config validation still enforces role-specific constraints for stored queue metadata', () => {
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
