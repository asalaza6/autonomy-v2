import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { validateAutonomyConfig } from '../../src/config/index.js';
import { shouldForceApproveAfterRepeatedReviews } from '../../src/autonomy-v2/runner/default-runner.js';
import type { AnyRecord } from '../../src/types.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CLI_BIN = path.join(PROJECT_ROOT, 'bin', 'autonomy-v2');
const SERVER_BIN = path.join(PROJECT_ROOT, 'bin', 'autonomy-v2-server');

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

  const tickResult = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));

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

  const tickResult = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
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

test('packaged autonomy-v2 promotes queued PRD from queue when no active PRD is imported', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-queue-promote-'));

  fs.mkdirSync(path.join(repoDir, 'src', 'apps', 'reef'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'apps', 'reef', 'index.js'), 'export const value = 2;\n', 'utf8');

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'autonomy-queue-promote@example.com']);
  git(repoDir, ['config', 'user.name', 'Autonomy Queue Promote']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  git(repoDir, ['branch', 'dev']);

  runNode(CLI_BIN, ['init', '--root', repoDir]);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-queue-promo-001',
    '--title',
    'Primary PRD',
    '--task-spec',
    JSON.stringify({
      id: 'prd-queue-promo-001-architecture-agent-1',
      title: 'Primary architecture task',
      agentId: 'architecture-agent',
      description: 'Primary fixture task',
      acceptance: ['Only repository source files are queued for this queue fixture task.'],
      sprintId: 'multi-agent-mvp',
    }),
  ]);

  const activeTickResult = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.equal(activeTickResult.sync.imported.length, 1);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-queue-promo-002',
    '--title',
    'Queued PRD',
    '--specification',
    'Should wait in queue until promoted',
  ]);

  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-002.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-002.json'),
    false
  );

  const controlWorktree = path.join(repoDir, '.autonomy', 'control', 'dev-sync');
  fs.rmSync(
    path.join(controlWorktree, 'prompts', 'autonomous', 'v2', 'specs', 'prds', 'prd-queue-promo-001.json'),
    { force: true }
  );
  fs.writeFileSync(
    path.join(controlWorktree, 'prompts', 'autonomous', 'v2', 'queues', 'reviewer.json'),
    `${JSON.stringify({ agentId: 'reviewer', role: 'review', tasks: [] }, null, 2)}\n`,
    'utf8'
  );
  git(controlWorktree, [
    'add',
    '--all',
    '--',
    'prompts/autonomous/v2/specs/prds/prd-queue-promo-001.json',
    'prompts/autonomous/v2/queues/reviewer.json',
  ]);
  git(controlWorktree, ['commit', '-m', 'archive active prd for promotion test']);

  const secondTick = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.equal(secondTick.started.some((entry) => entry.agentId === 'pm-agent'), true);
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prd-state/prd-queue-promo-002.json'),
    true
  );
});

test('packaged autonomy-v2 scaffolds custom agents and prunes removed agents on force', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-custom-agent-'));

  runNode(CLI_BIN, ['init', '--root', repoDir]);

  const agentsPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json');
  const agentsConfig = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
  agentsConfig.agents.push({
    id: 'billing-agent',
    personaName: 'billing-agent',
    role: 'implementation',
    systemPrompt: 'prompts/autonomous/v2/agents/billing-agent/system.md',
    taskQueue: 'prompts/autonomous/v2/queues/billing-agent.json',
    gitIdentity: {
      name: 'autonomy-billing[bot]',
      email: 'autonomy-billing[bot]@users.noreply.github.com',
    },
    prLabels: ['agent:billing'],
      include: ['src/**/*'],
    checks: ['npm run typecheck'],
  });
  fs.writeFileSync(agentsPath, `${JSON.stringify(agentsConfig, null, 2)}\n`, 'utf8');

  runNode(CLI_BIN, ['init', '--root', repoDir, '--force']);

  const billingSystemPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'agents', 'billing-agent', 'system.md');
  const billingHandoffPath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'agents', 'billing-agent', 'handoff.md');
  const billingLogPath = path.join(repoDir, '.autonomy', 'runtime', 'agents', 'billing-agent', 'log.md');
  const billingQueuePath = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'queues', 'billing-agent.json');

  assert.ok(fs.existsSync(billingSystemPath));
  assert.ok(fs.existsSync(billingHandoffPath));
  assert.ok(fs.existsSync(billingLogPath));
  assert.ok(fs.existsSync(billingQueuePath));

  const billingSystem = fs.readFileSync(billingSystemPath, 'utf8');
  assert.match(billingSystem, /billing agent implementation agent/i);
  assert.match(billingSystem, /src\/\*\*/);

  agentsConfig.agents = agentsConfig.agents.filter((agent) => agent.id !== 'billing-agent');
  fs.writeFileSync(agentsPath, `${JSON.stringify(agentsConfig, null, 2)}\n`, 'utf8');

  runNode(CLI_BIN, ['init', '--root', repoDir, '--force']);

  assert.ok(!fs.existsSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'agents', 'billing-agent', 'system.md')));
  assert.ok(!fs.existsSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'agents', 'billing-agent', 'handoff.md')));
  assert.ok(!fs.existsSync(path.join(repoDir, '.autonomy', 'runtime', 'agents', 'billing-agent', 'log.md')));
  assert.ok(!fs.existsSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'queues', 'billing-agent.json')));
});

test('implementation queue stays queued on dev while branch queue advances across ticks', () => {
  const repoDir = createFixtureRepo('autonomy-v2-branch-queue-');
  initAutonomyRepo(repoDir);

  const taskOne = {
    id: 'prd-branch-queue-001-architecture-agent-1',
    title: 'Lane task 1',
    agentId: 'architecture-agent',
    description: 'First lane task',
    acceptance: ['First task completed on the implementation branch.'],
    sprintId: 'multi-agent-mvp',
  };
  const taskTwo = {
    id: 'prd-branch-queue-001-architecture-agent-2',
    title: 'Lane task 2',
    agentId: 'architecture-agent',
    description: 'Second lane task',
    acceptance: ['Second task completed after branch-local promotion.'],
    sprintId: 'multi-agent-mvp',
  };

  addPrdWithTasks(repoDir, 'prd-branch-queue-001', 'Branch queue PRD', [taskOne, taskTwo]);

  const firstTick = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.equal(firstTick.started.length, 1);
  assert.equal(firstTick.started[0].result.taskId, taskOne.id);

  const queueRevision = 'prompts/autonomous/v2/queues/architecture-agent.json';
  const devQueueAfterFirstTick = readGitJson(repoDir, `dev:${queueRevision}`);
  assert.equal(devQueueAfterFirstTick.tasks.length, 2);
  assert.deepEqual(
    devQueueAfterFirstTick.tasks.map((task) => String(task.status || task.state)),
    ['queued', 'queued']
  );

  const branchName = firstTick.started[0].result.branch;
  const branchQueueAfterFirstTick = readGitJson(repoDir, `${branchName}:${queueRevision}`);
  assert.equal(findTaskInQueue(branchQueueAfterFirstTick, taskOne.id).status, 'done');
  assert.equal(findTaskInQueue(branchQueueAfterFirstTick, taskTwo.id).status, 'active');

  fs.rmSync(firstTick.started[0].result.worktreePath, { recursive: true, force: true });
  assert.equal(fs.existsSync(firstTick.started[0].result.worktreePath), false);

  const secondTick = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.equal(secondTick.started.length, 1);
  assert.equal(secondTick.started[0].result.taskId, taskTwo.id);
  assert.equal(fs.existsSync(secondTick.started[0].result.worktreePath), true);

  const devQueueAfterSecondTick = readGitJson(repoDir, `dev:${queueRevision}`);
  assert.deepEqual(
    devQueueAfterSecondTick.tasks.map((task) => String(task.status || task.state)),
    ['queued', 'queued']
  );

  const branchQueueAfterSecondTick = readGitJson(repoDir, `${branchName}:${queueRevision}`);
  assert.equal(findTaskInQueue(branchQueueAfterSecondTick, taskOne.id).status, 'done');
  assert.equal(findTaskInQueue(branchQueueAfterSecondTick, taskTwo.id).status, 'done');
});

test('review follow-up is appended only to the implementation branch queue and recreates a missing worktree', () => {
  const repoDir = createFixtureRepo('autonomy-v2-review-followup-');
  initAutonomyRepo(repoDir);

  const task = {
    id: 'prd-review-followup-001-architecture-agent-1',
    title: 'Review follow-up task',
    agentId: 'architecture-agent',
    description: 'Initial implementation task',
    acceptance: ['Implementation is completed before review feedback.'],
    sprintId: 'multi-agent-mvp',
  };
  addPrdWithTasks(repoDir, 'prd-review-followup-001', 'Review follow-up PRD', [task]);

  runTick(repoDir);

  const paths = getAutonomyPathsForTest(repoDir);
  const prsState = JSON.parse(fs.readFileSync(paths.prsState, 'utf8'));
  assert.equal(prsState.pullRequests.length, 1);
  const pr = prsState.pullRequests[0];

  const branchLocks = JSON.parse(fs.readFileSync(paths.branchLocksState, 'utf8'));
  assert.equal(branchLocks.locks.length, 1);
  const worktreePath = branchLocks.locks[0].worktreePath;
  fs.rmSync(worktreePath, { recursive: true, force: true });
  assert.equal(fs.existsSync(worktreePath), false);

  runNode(CLI_BIN, [
    'review:record',
    '--root',
    repoDir,
    '--pr',
    pr.id,
    '--reviewer',
    'reviewer',
    '--decision',
    'changes-requested',
    '--summary',
    'Please address the review feedback.',
  ]);

  const queueRevision = 'prompts/autonomous/v2/queues/architecture-agent.json';
  const devQueue = readGitJson(repoDir, `dev:${queueRevision}`);
  assert.equal(devQueue.tasks.length, 1);
  assert.equal(findTaskInQueue(devQueue, task.id).status, 'queued');

  assert.equal(fs.existsSync(worktreePath), true);
  const branchQueue = readGitJson(repoDir, `${pr.headBranch}:${queueRevision}`);
  assert.equal(findTaskInQueue(branchQueue, task.id).status, 'done');
  const followupTaskId = `architecture-agent-followup-${pr.id}-1`;
  const followupTask = findTaskInQueue(branchQueue, followupTaskId);
  assert.ok(followupTask);
  assert.equal(followupTask.type, 'review_followup');
  assert.equal(followupTask.status, 'active');
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
  addPrdWithTasks(repoDir, 'prd-task-finish-guard-001', 'Task finish guard PRD', [task]);

  const tick = runTick(repoDir);
  assert.equal(tick.started.length, 1);

  assert.throws(
    () => runNode(CLI_BIN, ['task:finish', '--root', repoDir, '--task', task.id]),
    /active on branch/
  );

  const devQueue = readGitJson(repoDir, 'dev:prompts/autonomous/v2/queues/architecture-agent.json');
  assert.equal(findTaskInQueue(devQueue, task.id).status, 'queued');
});

test('packaged autonomy-v2 rejects invalid agent config values', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-validation-'));

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

test('reviewer auto-approves on 4th+ review cycle regardless of review reasons', () => {
  const cleanCheckResults = [
    { command: 'npm run typecheck', status: 'passed' },
    { command: 'npm run test', status: 'passed' },
  ];
  const failedCheckResults = [
    { command: 'npm run test', status: 'failed' },
  ];
  const prWithFourReviews = {
    reviews: [
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
    ],
  };
  const prWithThreeReviews = {
    reviews: [
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
    ],
  };
  const prWithFiveReviews = {
    reviews: [
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
      { decision: 'changes-requested' },
    ],
  };
  const prWithTwoReviews = {
    reviews: [{ decision: 'changes-requested' }, { decision: 'changes-requested' }],
  };
  const inScopeResult = { ok: true, violations: [] };
  const outOfScopeResult = { ok: false, violations: [{ file: 'src/forbidden.ts', reason: 'outside scope' }] };

  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithFourReviews, cleanCheckResults, inScopeResult),
    true
  );
  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithThreeReviews, cleanCheckResults, inScopeResult),
    false
  );
  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithTwoReviews, cleanCheckResults, inScopeResult),
    false
  );
  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithFiveReviews, cleanCheckResults, inScopeResult),
    true
  );
  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithFourReviews, failedCheckResults, inScopeResult),
    true
  );
  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithFourReviews, cleanCheckResults, outOfScopeResult),
    true
  );
});

function createFixtureRepo(prefix) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(repoDir, 'src', 'apps', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), 'export const value = 1;\n', 'utf8');
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(repoDir, ['config', 'user.name', 'Autonomy Test']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  git(repoDir, ['branch', 'dev']);
  return repoDir;
}

function initAutonomyRepo(repoDir) {
  runNode(CLI_BIN, ['init', '--root', repoDir]);
}

function addPrdWithTasks(repoDir, prdId, title, taskSpecs) {
  const args = ['prd:add', '--root', repoDir, '--id', prdId, '--title', title];
  taskSpecs.forEach((taskSpec) => {
    args.push('--task-spec', JSON.stringify(taskSpec));
  });
  runNode(CLI_BIN, args);
}

function runTick(repoDir) {
  return JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
}

function readGitJson(cwd, revisionPath) {
  return JSON.parse(git(cwd, ['show', revisionPath]));
}

function findTaskInQueue(queueState, taskId) {
  return (queueState.tasks || []).find((task) => task.id === taskId) || null;
}

function runNode(scriptPath, args, options: AnyRecord = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fileExistsInGitRevision(cwd, revisionPath) {
  try {
    git(cwd, ['show', revisionPath]);
    return true;
  } catch (_) {
    return false;
  }
}

function getAutonomyPathsForTest(rootDir) {
  const runtimeAutonomyDir = path.join(rootDir, '.autonomy', 'runtime');
  const stateDir = path.join(runtimeAutonomyDir, 'state');
  return {
    prsState: path.join(stateDir, 'prs.json'),
    branchLocksState: path.join(stateDir, 'branch-locks.json'),
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
