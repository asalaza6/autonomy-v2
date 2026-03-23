const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { shouldForceApproveAfterRepeatedReviews } = require('./src/autonomy-v2-default-runner');

const PROJECT_ROOT = path.join(__dirname);
const CLI_BIN = path.join(PROJECT_ROOT, 'bin', 'autonomy-v2');
const SERVER_BIN = path.join(PROJECT_ROOT, 'bin', 'autonomy-v2-server');

test('packaged autonomy-v2 runs init, prd:add, and PM planning against an external workspace root', () => {
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
  assert.ok(fs.existsSync(path.join(repoDir, 'scripts', 'autonomy-v2-default-runner.js')));
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
  assert.deepEqual(
    agentsConfig.agents.find((agent) => agent.id === 'architecture-agent').runnerCommand,
    ['node', 'scripts/autonomy-v2-default-runner.js']
  );
  assert.deepEqual(
    agentsConfig.agents.find((agent) => agent.id === 'reviewer').runnerCommand,
    ['node', 'scripts/autonomy-v2-default-runner.js']
  );

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
      allowedPaths: ['src/**/*'],
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
  const runtimePrds = JSON.parse(fs.readFileSync(
    path.join(repoDir, '.autonomy', 'runtime', 'state', 'prds.json'),
    'utf8'
  ));
  assert.equal(runtimePrds.prds[0].id, 'prd-package-001');
  assert.equal(runtimePrds.prds[0].status, 'planned');
  assert.deepEqual(runtimePrds.prds[0].plannedTaskIds, ['prd-package-001-architecture-agent-1']);
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
      allowedPaths: ['src/**/*'],
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
      allowedPaths: ['src/**/*'],
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

  const paths = getAutonomyPathsForTest(repoDir);
  fs.writeFileSync(paths.prdsState, `${JSON.stringify({ prds: [] }, null, 2)}\n`, 'utf8');

  const secondTick = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
  assert.equal(secondTick.sync.imported.includes('prd-queue-promo-002'), true);

  const runtimePrds = JSON.parse(fs.readFileSync(paths.prdsState, 'utf8'));
  assert.equal(runtimePrds.prds.length, 2);
  assert.equal(
    runtimePrds.prds.some((prd) => prd.id === 'prd-queue-promo-002'),
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
    runnerCommand: ['node', 'scripts/autonomy-v2-default-runner.js'],
    systemPrompt: 'prompts/autonomous/v2/agents/billing-agent/system.md',
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
  const billingQueuePath = path.join(repoDir, '.autonomy', 'runtime', 'state', 'queues', 'billing-agent.json');

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
  assert.ok(!fs.existsSync(path.join(repoDir, '.autonomy', 'runtime', 'state', 'queues', 'billing-agent.json')));
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

test('reviewer auto-approves on 3rd+ clean review cycle', () => {
  const cleanCheckResults = [
    { command: 'npm run typecheck', status: 'passed' },
    { command: 'npm run test', status: 'passed' },
  ];
  const failedCheckResults = [
    { command: 'npm run test', status: 'failed' },
  ];
  const prWithThreeReviews = {
    reviews: [
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
    shouldForceApproveAfterRepeatedReviews(prWithThreeReviews, cleanCheckResults, inScopeResult),
    true
  );
  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithTwoReviews, cleanCheckResults, inScopeResult),
    false
  );
  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithThreeReviews, failedCheckResults, inScopeResult),
    false
  );
  assert.equal(
    shouldForceApproveAfterRepeatedReviews(prWithThreeReviews, cleanCheckResults, outOfScopeResult),
    false
  );
});

function runNode(scriptPath, args, options = {}) {
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
  const repoAutonomyDir = path.join(rootDir, 'prompts', 'autonomous', 'v2');
  const runtimeAutonomyDir = path.join(rootDir, '.autonomy', 'runtime');
  const stateDir = path.join(runtimeAutonomyDir, 'state');
  return {
    prdsState: path.join(stateDir, 'prds.json'),
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
