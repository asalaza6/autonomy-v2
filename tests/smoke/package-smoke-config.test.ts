import test from 'node:test';
import { syncPrdSpecsFromIntegrationBranch } from '../../src/sync/syncer.js';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateAutonomyConfig } from '../../src/config/config-main.js';
import {
  CLI_BIN,
  createFixtureRepo,
  initAutonomyRepo,
  runNode,
  SERVER_BIN,
} from './package-smoke.helpers.js';

test('update installs the latest autonomy-v2 package as an optional dependency and refreshes initialized scaffold', () => {
  const repoDir = createFixtureRepo('autonomy-v2-update-command-');
  initAutonomyRepo(repoDir);

  const manifestPath = path.join(repoDir, 'package.json');
  const lockfilePath = path.join(repoDir, 'package-lock.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    name: 'autonomy-update-fixture',
    private: true,
    optionalDependencies: {
      '@asalaza6/autonomy-v2': '1.0.0',
    },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(lockfilePath, `${JSON.stringify({
    name: 'autonomy-update-fixture',
    lockfileVersion: 3,
    packages: {},
  }, null, 2)}\n`, 'utf8');

  fs.writeFileSync(path.join(repoDir, '.env.autonomy'), 'STALE_AUTONOMY_ENV=1\n', 'utf8');

  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-fake-npm-'));
  const fakeNpmPath = path.join(fakeBinDir, 'npm');
  const packageSourceRoot = path.resolve(path.dirname(CLI_BIN), '..', '..');
  fs.writeFileSync(fakeNpmPath, `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const packageName = '@asalaza6/autonomy-v2';
const installVersion = process.env.AUTONOMY_UPDATE_TEST_INSTALLED_VERSION || '9.9.9-test';
const packageSourceRoot = process.env.AUTONOMY_UPDATE_TEST_PACKAGE_SOURCE;
const cwd = process.cwd();
const args = process.argv.slice(2);
const saveOptional = args.includes('--save-optional');
const saveDev = args.includes('--save-dev') || args.includes('-D');

if (args[0] !== 'install') {
  throw new Error('fake npm only supports install');
}

const manifestPath = path.join(cwd, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (saveOptional) {
  manifest.optionalDependencies = manifest.optionalDependencies || {};
  manifest.optionalDependencies[packageName] = '^' + installVersion;
  if (manifest.devDependencies) {
    delete manifest.devDependencies[packageName];
    if (Object.keys(manifest.devDependencies).length === 0) {
      delete manifest.devDependencies;
    }
  }
  if (manifest.dependencies) {
    delete manifest.dependencies[packageName];
    if (Object.keys(manifest.dependencies).length === 0) {
      delete manifest.dependencies;
    }
  }
} else if (saveDev) {
  manifest.devDependencies = manifest.devDependencies || {};
  manifest.devDependencies[packageName] = '^' + installVersion;
} else {
  manifest.dependencies = manifest.dependencies || {};
  manifest.dependencies[packageName] = '^' + installVersion;
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\\n', 'utf8');

const lockfilePath = path.join(cwd, 'package-lock.json');
fs.writeFileSync(lockfilePath, JSON.stringify({
  name: manifest.name,
  lockfileVersion: 3,
  packages: {
    '': {
      dependencies: manifest.dependencies,
      devDependencies: manifest.devDependencies,
      optionalDependencies: manifest.optionalDependencies,
    },
    'node_modules/@asalaza6/autonomy-v2': {
      version: installVersion,
    },
  },
}, null, 2) + '\\n', 'utf8');

const targetRoot = path.join(cwd, 'node_modules', '@asalaza6', 'autonomy-v2');
fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });
for (const entry of ['dist', 'templates', 'README.md', 'package.json']) {
  const sourcePath = path.join(packageSourceRoot, entry);
  const targetPath = path.join(targetRoot, entry);
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true });
    continue;
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

const installedManifestPath = path.join(targetRoot, 'package.json');
const installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, 'utf8'));
installedManifest.version = installVersion;
fs.writeFileSync(installedManifestPath, JSON.stringify(installedManifest, null, 2) + '\\n', 'utf8');
`, 'utf8');
  fs.chmodSync(fakeNpmPath, 0o755);

  const output = JSON.parse(runNode(CLI_BIN, ['update', '--root', repoDir, '--json'], {
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH || ''}`,
      AUTONOMY_UPDATE_TEST_PACKAGE_SOURCE: packageSourceRoot,
      AUTONOMY_UPDATE_TEST_INSTALLED_VERSION: '9.9.9-test',
    },
  }));

  assert.equal(output.packageManager, 'npm');
  assert.equal(output.previousVersion, '1.0.0');
  assert.equal(output.declaredVersion, '^9.9.9-test');
  assert.equal(output.installedVersion, '9.9.9-test');
  assert.equal(output.refreshed, true);
  assert.equal(output.refresh.skipped, false);
  assert.equal(fs.readFileSync(path.join(repoDir, '.env.autonomy'), 'utf8'), 'STALE_AUTONOMY_ENV=1\n');
});

test('init preserves an existing .env.autonomy file', () => {
  const repoDir = createFixtureRepo('autonomy-v2-init-preserve-env-');
  const envPath = path.join(repoDir, '.env.autonomy');
  fs.writeFileSync(envPath, 'CUSTOM_AUTONOMY_ENV=1\n', 'utf8');

  runNode(CLI_BIN, ['init', '--root', repoDir]);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'CUSTOM_AUTONOMY_ENV=1\n');

  runNode(CLI_BIN, ['init', '--root', repoDir, '--force']);
  assert.equal(fs.readFileSync(envPath, 'utf8'), 'CUSTOM_AUTONOMY_ENV=1\n');
});

test('init creates and preserves project context', () => {
  const repoDir = createFixtureRepo('autonomy-v2-init-project-context-');
  const contextPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'project-context.md');

  runNode(CLI_BIN, ['init', '--root', repoDir]);
  assert.match(fs.readFileSync(contextPath, 'utf8'), /Project Context/);

  fs.writeFileSync(contextPath, '# Project Context\n\nCustom project map.\n', 'utf8');
  runNode(CLI_BIN, ['init', '--root', repoDir, '--force']);
  assert.equal(fs.readFileSync(contextPath, 'utf8'), '# Project Context\n\nCustom project map.\n');
});

test('init appends missing .gitignore entries without replacing existing content', () => {
  const repoDir = createFixtureRepo('autonomy-v2-init-merge-gitignore-');
  const gitignorePath = path.join(repoDir, '.gitignore');
  fs.writeFileSync(gitignorePath, 'custom-local-artifact\n.env\n', 'utf8');

  runNode(CLI_BIN, ['init', '--root', repoDir]);
  const initializedGitignore = fs.readFileSync(gitignorePath, 'utf8');
  assert.match(initializedGitignore, /^custom-local-artifact$/m);
  assert.match(initializedGitignore, /^\.env$/m);
  assert.match(initializedGitignore, /^\.env\.publish$/m);
  assert.match(initializedGitignore, /^\.env\.publish\.local$/m);
  assert.match(initializedGitignore, /^\.tooling\/$/m);
  assert.match(initializedGitignore, /^docs\/export-graph\.\*$/m);
  assert.equal((initializedGitignore.match(/^\.env$/gm) || []).length, 1);

  runNode(CLI_BIN, ['init', '--root', repoDir, '--force']);
  const forcedGitignore = fs.readFileSync(gitignorePath, 'utf8');
  assert.match(forcedGitignore, /^custom-local-artifact$/m);
  assert.equal((forcedGitignore.match(/^docs\/export-graph\.\*$/gm) || []).length, 1);
});

test('task:finish refuses to mutate dev for claimed implementation lanes', () => {
  const repoDir = createFixtureRepo('autonomy-v2-task-finish-guard-');
  initAutonomyRepo(repoDir);

  const task = {
    id: 'prd-task-finish-guard-001-architecture-agent-1',
    title: 'Guarded task',
    agentId: 'architecture-agent',
    description: 'Task claimed onto an implementation branch',
    acceptance: ['The task remains queued on dev after claim.'],
    sprintId: 'multi-agent-mvp',
  };
  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-task-finish-guard-001',
    '--title',
    'Task finish guard PRD',
    '--task-spec',
    JSON.stringify(task),
  ]);

  syncPrdSpecsFromIntegrationBranch(repoDir, 'dev');
  runNode(CLI_BIN, ['worktree:prepare', '--root', repoDir, '--task', task.id, '--create']);

  assert.throws(
    () => runNode(CLI_BIN, ['task:finish', '--root', repoDir, '--task', task.id]),
    /active on branch/
  );
});

test('packaged autonomy-v2 rejects invalid agent config values', () => {
  const repoDir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'autonomy-v2-validation-'));

  runNode(CLI_BIN, ['init', '--root', repoDir]);

  const agentsPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json');
  const agentsConfig = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));

  agentsConfig.agents[1].id = agentsConfig.agents[0].id;
  fs.writeFileSync(agentsPath, `${JSON.stringify(agentsConfig, null, 2)}\n`, 'utf8');
  assert.throws(
    () => runNode(CLI_BIN, ['status', '--root', repoDir]),
    /duplicate agent id/i
  );

  agentsConfig.agents[1].id = 'architecture-agent';
  agentsConfig.agents[0].id = 'pm-agent';
  agentsConfig.agents[0].role = 'bogus';
  fs.writeFileSync(agentsPath, `${JSON.stringify(agentsConfig, null, 2)}\n`, 'utf8');
  assert.throws(
    () => runNode(CLI_BIN, ['status', '--root', repoDir]),
    /unsupported role/i
  );

  delete agentsConfig.agents[0].id;
  agentsConfig.agents[0].role = 'pm';
  fs.writeFileSync(agentsPath, `${JSON.stringify(agentsConfig, null, 2)}\n`, 'utf8');
  assert.throws(
    () => runNode(CLI_BIN, ['status', '--root', repoDir]),
    /id is required/i
  );
});

test('packaged autonomy-v2 backfills missing pm taskQueue for older repos', () => {
  const repoDir = createFixtureRepo('autonomy-v2-pm-task-queue-');
  initAutonomyRepo(repoDir);

  const agentsPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json');
  const agentsConfig = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
  delete agentsConfig.agents.find((agent) => agent.id === 'pm-agent').taskQueue;
  fs.writeFileSync(agentsPath, `${JSON.stringify(agentsConfig, null, 2)}\n`, 'utf8');

  const statusOutput = JSON.parse(runNode(CLI_BIN, ['status', '--root', repoDir, '--json']));
  assert.ok(Array.isArray(statusOutput.agents));

  const tickResult = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.ok(Array.isArray(tickResult.dueAgents));
});

test('init restores missing pm taskQueue using the repo queue layout', () => {
  const repoDir = createFixtureRepo('autonomy-v2-init-migrate-task-queue-');
  initAutonomyRepo(repoDir);

  const agentsPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json');
  const agentsConfig = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
  delete agentsConfig.agents.find((agent) => agent.id === 'pm-agent').taskQueue;
  fs.writeFileSync(agentsPath, `${JSON.stringify(agentsConfig, null, 2)}\n`, 'utf8');

  runNode(CLI_BIN, ['init', '--root', repoDir]);

  const migratedConfig = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
  const pmAgent = migratedConfig.agents.find((agent) => agent.id === 'pm-agent');

  assert.equal(pmAgent.taskQueue, 'prompts/autonomous/v2/queues/pm-agent.json');
});

test('validateAutonomyConfig defaults missing taskQueue fields to the repo queue layout', () => {
  const config = {
    schemaVersion: 1,
    agents: [
      {
        id: 'pm-agent',
        personaName: 'pm-agent',
        role: 'pm',
        systemPrompt: 'prompts/autonomous/v2/agents/pm-agent/system.md',
        gitIdentity: {
          name: 'pm',
          email: 'pm@example.com',
        },
      },
      {
        id: 'architecture-agent',
        personaName: 'architecture-agent',
        role: 'implementation',
        taskQueue: 'prompts/autonomous/v2/queues/architecture-agent.json',
        systemPrompt: 'prompts/autonomous/v2/agents/architecture-agent/system.md',
        gitIdentity: {
          name: 'architecture',
          email: 'architecture@example.com',
        },
        checks: ['npm run typecheck'],
      },
      {
        id: 'reviewer',
        personaName: 'reviewer',
        role: 'review',
        taskQueue: 'prompts/autonomous/v2/queues/reviewer.json',
        systemPrompt: 'prompts/autonomous/v2/agents/reviewer/system.md',
        gitIdentity: {
          name: 'reviewer',
          email: 'reviewer@example.com',
        },
      },
    ],
  };

  const validated = validateAutonomyConfig(config, 'fixtures/agents.json');
  const pmAgent = validated.agents.find((agent) => agent.id === 'pm-agent');

  assert.equal(pmAgent.taskQueue, 'prompts/autonomous/v2/queues/pm-agent.json');
});

test('validateAutonomyConfig rejects runtime-managed reviewer queue paths', () => {
  const config = {
    schemaVersion: 1,
    agents: [
      {
        id: 'pm-agent',
        personaName: 'pm-agent',
        role: 'pm',
        taskQueue: 'prompts/autonomous/v2/queues/pm-agent.json',
        systemPrompt: 'prompts/autonomous/v2/agents/pm-agent/system.md',
        gitIdentity: {
          name: 'pm',
          email: 'pm@example.com',
        },
      },
      {
        id: 'architecture-agent',
        personaName: 'architecture-agent',
        role: 'implementation',
        taskQueue: 'prompts/autonomous/v2/queues/architecture-agent.json',
        systemPrompt: 'prompts/autonomous/v2/agents/architecture-agent/system.md',
        gitIdentity: {
          name: 'architecture',
          email: 'architecture@example.com',
        },
        checks: ['npm run typecheck'],
      },
      {
        id: 'reviewer',
        personaName: 'reviewer',
        role: 'review',
        taskQueue: 'prompts/autonomous/v2/state/queues/reviewer.json',
        systemPrompt: 'prompts/autonomous/v2/agents/reviewer/system.md',
        gitIdentity: {
          name: 'reviewer',
          email: 'reviewer@example.com',
        },
      },
    ],
  };

  assert.throws(
    () => validateAutonomyConfig(config, 'fixtures/agents.json'),
    /review agent "reviewer" cannot use runtime-managed taskQueue paths/
  );
});
