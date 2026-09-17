import test from 'node:test';
import { syncPrdSpecsFromIntegrationBranch } from '../../src/sync/syncer.js';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  addPrdWithTasks,
  CLI_BIN,
  createFixtureRepo,
  fileExistsInGitRevision,
  findTaskInQueue,
  git,
  initAutonomyRepo,
  readGitJson,
  runNode,
  SERVER_BIN,
} from './package-smoke.helpers.js';

test('packaged autonomy-v2 runs init, prd:add, and imports tracked task specs against an external workspace root', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-package-'));

  fs.mkdirSync(path.join(repoDir, 'src', 'apps', 'aquarium'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'apps', 'aquarium', 'README.md'),
    'aquarium fixture\n',
    'utf8'
  );

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'autonomy-package-test@example.com']);
  git(repoDir, ['config', 'user.name', 'Autonomy Package Test']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  git(repoDir, ['branch', 'dev']);

  runNode(CLI_BIN, ['init', '--root', repoDir]);

  assert.ok(fs.existsSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json')));
  assert.ok(fs.existsSync(path.join(repoDir, '.autonomy', 'runtime', 'state', 'runtime.json')));

  const agentsConfig = JSON.parse(fs.readFileSync(
    path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json'),
    'utf8'
  ));
  assert.equal(agentsConfig.schemaVersion, 1);
  assert.deepEqual(
    agentsConfig.agents.map((agent) => agent.id),
    ['pm-agent', 'architecture-agent', 'reviewer']
  );
  assert.deepEqual(agentsConfig.mergeActors, ['reviewer']);
  const sprintConfig = JSON.parse(fs.readFileSync(
    path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'sprint.json'),
    'utf8'
  ));
  assert.equal(sprintConfig.sprintId, 'multi-agent-mvp');
  assert.equal(sprintConfig.name, 'Multi-Agent PR System MVP');
  assert.equal(sprintConfig.maxParallelImplementationAgents, 1);
  assert.equal(sprintConfig.requireReviewApproval, true);
  assert.equal(sprintConfig.requireScopeValidation, true);
  assert.equal(sprintConfig.defaultTaskBaseBranch, 'dev');

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-package-001',
    '--title',
    'Package smoke PRD',
    '--task-spec',
    JSON.stringify({
      id: 'prd-package-001-architecture-agent-1',
      title: 'Architecture package smoke task',
      agentId: 'architecture-agent',
      description: 'Create one architecture task through packaged PM planning.',
      acceptance: ['Only repository source files are queued for this package smoke task.'],
      sprintId: 'multi-agent-mvp',
    }),
  ]);

  const committedPrdSpec = git(repoDir, ['show', 'dev:prompts/autonomous/v2/specs/prds/prd-package-001.json']);
  assert.match(committedPrdSpec, /"id": "prd-package-001"/);

  const tickResult = { sync: syncPrdSpecsFromIntegrationBranch(repoDir, 'dev') };

  assert.equal(tickResult.sync.imported.length, 1);
  const trackedQueue = readGitJson(
    repoDir,
    'dev:prompts/autonomous/v2/queues/architecture-agent.json'
  );
  assert.equal(findTaskInQueue(trackedQueue, 'prd-package-001-architecture-agent-1').prdId, 'prd-package-001');
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prd-state/prd-package-001.json'),
    false
  );
});

test('packaged autonomy-v2 never dispatches the retired roster even when enabled', () => {
  const repoDir = createFixtureRepo('autonomy-v2-legacy-roster-off-');
  initAutonomyRepo(repoDir);

  const controlPlanePath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'control-plane.json');
  const controlPlaneConfig = JSON.parse(fs.readFileSync(controlPlanePath, 'utf8'));
  fs.writeFileSync(
    controlPlanePath,
    `${JSON.stringify({ ...controlPlaneConfig, legacyRosterEnabled: true }, null, 2)}\n`,
    'utf8',
  );

  addPrdWithTasks(repoDir, 'prd-legacy-off-001', 'Legacy roster disabled PRD', [
    {
      id: 'prd-legacy-off-001-architecture-agent-1',
      title: 'Should not dispatch through legacy roster',
      agentId: 'architecture-agent',
      description: 'This task should remain untouched by the old scheduler path.',
      acceptance: ['Legacy roster dispatch is disabled.'],
      sprintId: 'multi-agent-mvp',
    },
  ]);

  const tickResult = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--json']));

  assert.deepEqual(tickResult.sync.imported, []);
  assert.deepEqual(tickResult.dueAgents, []);
  assert.deepEqual(tickResult.started, []);
});

test('packaged autonomy-v2 queues PRD additions when one is already active', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-queue-add-'));

  fs.mkdirSync(path.join(repoDir, 'src', 'apps', 'ocean'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'apps', 'ocean', 'index.js'), 'export const value = 1;\n', 'utf8');

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'autonomy-queue-add@example.com']);
  git(repoDir, ['config', 'user.name', 'Autonomy Queue Add']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  git(repoDir, ['branch', 'dev']);

  runNode(CLI_BIN, ['init', '--root', repoDir]);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-queue-001',
    '--title',
    'First PRD',
    '--task-spec',
    JSON.stringify({
      id: 'prd-queue-001-architecture-agent-1',
      title: 'First architecture task',
      agentId: 'architecture-agent',
      description: 'Queue add fixture',
      acceptance: ['Only repository source files are queued for this queue fixture task.'],
      sprintId: 'multi-agent-mvp',
    }),
  ]);

  const tickResult = { sync: syncPrdSpecsFromIntegrationBranch(repoDir, 'dev') };
  assert.equal(tickResult.sync.imported.length, 1);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-queue-002',
    '--title',
    'Second PRD',
    '--specification',
    'Queued while first PRD remains active',
  ]);

  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-002.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-002.json'),
    false
  );
});

test('packaged autonomy-v2 queues PRD additions when spec already exists in integration specs', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-queue-existing-spec-'));

  fs.mkdirSync(path.join(repoDir, 'src', 'apps', 'bay'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'apps', 'bay', 'index.js'), 'export const value = 3;\n', 'utf8');

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'autonomy-queue-existing-spec@example.com']);
  git(repoDir, ['config', 'user.name', 'Autonomy Queue Existing Spec']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  git(repoDir, ['branch', 'dev']);

  runNode(CLI_BIN, ['init', '--root', repoDir]);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-queue-existing-001',
    '--title',
    'Primary PRD in specs',
    '--task-spec',
    JSON.stringify({
      id: 'prd-queue-existing-001-architecture-agent-1',
      title: 'Primary architecture task',
      agentId: 'architecture-agent',
      description: 'Existing spec fixture',
      acceptance: ['Only repository source files are queued for this queue fixture task.'],
      sprintId: 'multi-agent-mvp',
    }),
  ]);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-queue-existing-002',
    '--title',
    'Secondary PRD in queue',
    '--specification',
    'Should queue even without ticking first PRD',
  ]);

  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-existing-002.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-existing-002.json'),
    false
  );
});

test('init preserves consumer prompts, queues and custom lifecycle config on force', () => {
  const repoDir = createFixtureRepo('autonomy-init-custom-');
  initAutonomyRepo(repoDir);
  const base = path.join(repoDir, 'prompts/autonomous/v2');
  assert.equal(fs.existsSync(path.join(base, 'agents')), false);
  assert.equal(fs.existsSync(path.join(base, 'queues')), false);
  const files = {
    'agents/consumer/system.md': '# Consumer prompt',
    'queues/consumer.json': '{"tasks":[{"id":"keep"}]}',
    'config/custom-agents.json': '{"enabled":false,"agents":[]}',
  };
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(base, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  runNode(CLI_BIN, ['init', '--root', repoDir, '--force']);
  for (const [relative, content] of Object.entries(files)) {
    assert.equal(fs.readFileSync(path.join(base, relative), 'utf8'), content);
  }
});
