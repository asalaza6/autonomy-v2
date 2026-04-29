import test from 'node:test';
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
  getAutonomyPathsForTest,
  git,
  initAutonomyRepo,
  readGitJson,
  runNode,
  runTick,
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
    'prd-queue-promo-200',
    '--title',
    'First queued PRD',
    '--specification',
    'Should be promoted before later queued specs',
  ]);

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-queue-promo-100',
    '--title',
    'Second queued PRD',
    '--specification',
    'Should stay queued after the earlier queued spec is promoted',
  ]);

  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-200.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-100.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-200.json'),
    false
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-100.json'),
    false
  );

  const blockedTick = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.equal(blockedTick.started.some((entry) => entry.agentId === 'pm-agent'), false);
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-200.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-100.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-200.json'),
    false
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-100.json'),
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
  const archivedFixtureCommit = git(controlWorktree, ['rev-parse', 'HEAD']);
  git(repoDir, ['update-ref', 'refs/heads/dev', archivedFixtureCommit]);

  const secondTick = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.equal(secondTick.sync.queuedPromotion.id, 'prd-queue-promo-200');
  assert.equal(secondTick.sync.queuedPromotion.title, 'First queued PRD');
  assert.equal(secondTick.started.some((entry) => entry.agentId === 'pm-agent'), true);
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-200.json'),
    false
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-200.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/queue/prd-queue-promo-100.json'),
    true
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prds/prd-queue-promo-100.json'),
    false
  );
  assert.equal(
    fileExistsInGitRevision(repoDir, 'dev:prompts/autonomous/v2/specs/prd-state/prd-queue-promo-200.json'),
    true
  );

  const thirdTick = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.equal(thirdTick.sync.queuedPromotion, null);
  assert.equal(
    thirdTick.started.filter((entry) => entry.agentId === 'pm-agent').length,
    0
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

test('structured verification blockers block approval until the follow-up records satisfied evidence', () => {
  const repoDir = createFixtureRepo('autonomy-v2-review-blocker-approval-');
  initAutonomyRepo(repoDir);

  const task = {
    id: 'prd-review-blocker-001-architecture-agent-1',
    title: 'Review blocker task',
    agentId: 'architecture-agent',
    description: 'Initial implementation task',
    acceptance: ['Implementation is completed before review feedback.'],
    sprintId: 'multi-agent-mvp',
  };
  addPrdWithTasks(repoDir, 'prd-review-blocker-001', 'Review blocker PRD', [task]);

  runTick(repoDir);

  const paths = getAutonomyPathsForTest(repoDir);
  const initialPrState = JSON.parse(fs.readFileSync(paths.prsState, 'utf8'));
  const pr = initialPrState.pullRequests[0];

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
    'Run `npm run typecheck` before approval.',
  ]);

  assert.throws(() => {
    runNode(CLI_BIN, [
      'review:record',
      '--root',
      repoDir,
      '--pr',
      pr.id,
      '--reviewer',
      'reviewer',
      '--decision',
      'approve',
      '--summary',
      'Looks good now.',
    ]);
  }, /structured reviewer blockers remain unresolved/i);

  const branchLocks = JSON.parse(fs.readFileSync(paths.branchLocksState, 'utf8'));
  const worktreePath = branchLocks.locks[0].worktreePath;
  const queuePath = path.join(worktreePath, 'prompts', 'autonomous', 'v2', 'queues', 'architecture-agent.json');
  const branchQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  const followupTaskId = `architecture-agent-followup-${pr.id}-1`;
  const followupTask = findTaskInQueue(branchQueue, followupTaskId);
  followupTask.status = 'done';
  followupTask.state = 'done';
  followupTask.completionMode = 'noop';
  followupTask.completedAt = '2026-04-21T00:40:00.000Z';
  followupTask.updatedAt = '2026-04-21T00:40:00.000Z';
  followupTask.reviewerBlockers[0].status.state = 'satisfied';
  followupTask.reviewerBlockers[0].status.satisfiedAt = '2026-04-21T00:40:00.000Z';
  followupTask.reviewerBlockers[0].status.satisfiedByTaskId = followupTaskId;
  followupTask.reviewerBlockers[0].status.evidence = [{
    kind: 'command_output',
    label: 'Record output for npm run typecheck',
    command: 'npm run typecheck',
    detail: 'Command passed: npm run typecheck (exit 0)',
  }];
  fs.writeFileSync(queuePath, `${JSON.stringify(branchQueue, null, 2)}\n`, 'utf8');

  runNode(CLI_BIN, [
    'pr:record',
    '--root',
    repoDir,
    '--task',
    followupTaskId,
    '--head-branch',
    pr.headBranch,
    '--completed-task',
    followupTaskId,
  ]);

  const refreshedPrState = JSON.parse(fs.readFileSync(paths.prsState, 'utf8'));
  const refreshedPr = refreshedPrState.pullRequests.find((candidate: any) => candidate.id === pr.id);
  assert.equal(refreshedPr.reviewerBlockers[0].status.state, 'satisfied');
  assert.equal(refreshedPr.reviewerBlockers[0].status.satisfiedByTaskId, followupTaskId);

  runNode(CLI_BIN, [
    'review:record',
    '--root',
    repoDir,
    '--pr',
    pr.id,
    '--reviewer',
    'reviewer',
    '--decision',
    'approve',
    '--summary',
    'Looks good now.',
  ]);

  const approvedPrState = JSON.parse(fs.readFileSync(paths.prsState, 'utf8'));
  const approvedPr = approvedPrState.pullRequests.find((candidate: any) => candidate.id === pr.id);
  assert.equal(approvedPr.status, 'approved');
});

test('reviewer merge archives completed PRDs on dev without leaving staged fragments behind', () => {
  const repoDir = createFixtureRepo('autonomy-v2-reviewer-merge-archive-');
  initAutonomyRepo(repoDir);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initialize autonomy']);

  const task = {
    id: 'helppage1-architecture-agent-1',
    title: 'Add help page',
    agentId: 'architecture-agent',
    description: 'Create a new help page in frontend',
    acceptance: ['Help page route exists and renders placeholder content.'],
    sprintId: 'multi-agent-mvp',
  };
  addPrdWithTasks(repoDir, 'helppage1', 'helppage1', [task]);

  runTick(repoDir);

  const paths = getAutonomyPathsForTest(repoDir);
  const prsState = JSON.parse(fs.readFileSync(paths.prsState, 'utf8'));
  assert.equal(prsState.pullRequests.length, 1);
  const pr = prsState.pullRequests[0];
  const branchLocks = JSON.parse(fs.readFileSync(paths.branchLocksState, 'utf8'));
  const implementationWorktreePath = branchLocks.locks[0].worktreePath;

  runNode(CLI_BIN, [
    'review:record',
    '--root',
    repoDir,
    '--pr',
    pr.id,
    '--reviewer',
    'reviewer',
    '--decision',
    'approve',
    '--summary',
    'Looks good to merge.',
  ]);

  runNode(CLI_BIN, [
    'merge',
    '--root',
    repoDir,
    '--pr',
    pr.id,
    '--actor',
    'reviewer',
    '--execute',
  ]);

  const archivedPrdPath = 'dev:prompts/autonomous/v2/specs/prds/archived/helppage1.json';
  const activePrdPath = 'dev:prompts/autonomous/v2/specs/prds/helppage1.json';
  const prdStatePath = 'dev:prompts/autonomous/v2/specs/prd-state/helppage1.json';
  assert.equal(fileExistsInGitRevision(repoDir, archivedPrdPath), true);
  assert.equal(fileExistsInGitRevision(repoDir, activePrdPath), false);
  assert.equal(fileExistsInGitRevision(repoDir, prdStatePath), false);

  const reviewerQueue = readGitJson(repoDir, 'dev:prompts/autonomous/v2/queues/reviewer.json');
  assert.equal(reviewerQueue.tasks.length, 1);
  assert.equal(reviewerQueue.tasks[0].prId, pr.id);
  assert.equal(reviewerQueue.tasks[0].status, 'merged');

  const postMergePrsState = JSON.parse(fs.readFileSync(paths.prsState, 'utf8'));
  assert.equal(postMergePrsState.pullRequests[0].status, 'merged');

  assert.equal(git(repoDir, ['status', '--short']), '');
  assert.equal(git(implementationWorktreePath, ['status', '--short']), '');
});
