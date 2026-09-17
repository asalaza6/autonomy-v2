import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('packaged preset lifecycle: stale-prd', () => {
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-lifecycle-stale-prd-'));

try {
  writeJson('prompts/autonomous/v2/specs/prds/archived/prd-archived.json', {
    id: 'prd-archived',
    title: 'Archived PRD',
  });
  writeJson('prompts/autonomous/v2/specs/prds/queue/prd-next.json', {
    id: 'prd-next',
    title: 'Next PRD',
  });
  writeJson('.autonomy/runtime/custom-lifecycle/queues/shadow-architecture-agent.json', {
    agentId: 'shadow-architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-stale-arch',
        title: 'Stale architecture task',
        prdId: 'prd-archived',
        status: 'in_progress',
        baseBranch: 'dev',
        sprintId: 'custom-lifecycle-2026-05-24',
        worktreePath: path.join(fixtureRoot, '.autonomy', 'worktrees', 'shadow-architecture-agent', 'custom-lifecycle-2026-05-24-task-stale-arch'),
      },
    ],
  });
  writeJson('.autonomy/runtime/custom-lifecycle/queues/shadow-reviewer-agent.json', {
    agentId: 'shadow-reviewer-agent',
    role: 'review',
    tasks: [
      {
        id: 'review-pr-task-stale-arch',
        prId: 'pr-task-stale-arch',
        sourceTaskId: 'task-stale-arch',
        status: 'queued',
      },
    ],
  });
  writeJson('.autonomy/runtime/custom-lifecycle/state/prs.json', {
    pullRequests: [
      {
        id: 'pr-task-stale-arch',
        taskId: 'task-stale-arch',
        prdId: 'prd-archived',
        status: 'open',
      },
    ],
  });
  writeJson('.autonomy/runtime/custom-lifecycle/prd-state/prd-archived.json', {
    prdId: 'prd-archived',
    status: 'planned',
    activePath: 'prompts/autonomous/v2/specs/prds/prd-archived.json',
  });
  fs.mkdirSync(path.join(fixtureRoot, '.autonomy', 'worktrees', 'shadow-architecture-agent', 'custom-lifecycle-2026-05-24-task-stale-arch'), { recursive: true });
  fs.mkdirSync(path.join(fixtureRoot, '.autonomy', 'worktrees', 'shadow-reviewer-agent', 'review-pr-task-stale-arch'), { recursive: true });

  const architectureDecision = runJson('agents/architecture/should-run.mjs', { repoRoot: fixtureRoot });
  assert.equal(architectureDecision.shouldRun, false);
  assert.match(architectureDecision.reason, /archived stale PRD tasks/);
  assert.equal(readJson('.autonomy/runtime/custom-lifecycle/queues/shadow-architecture-agent.json').tasks[0].status, 'archived');

  resetArchitectureTask('in_progress');
  const prepareResult = runJson('agents/architecture/prepare-env.mjs', {
    repoRoot: fixtureRoot,
    target: { id: 'task-stale-arch' },
  });
  assert.equal(prepareResult.skipped, true);
  assert.match(prepareResult.reason, /stale PRD task/);
  assert.equal(readJson('.autonomy/runtime/custom-lifecycle/queues/shadow-architecture-agent.json').tasks[0].status, 'archived');

  const reviewerDecision = runJson('agents/reviewer/should-run.mjs', { repoRoot: fixtureRoot });
  assert.equal(reviewerDecision.shouldRun, true);
  assert.equal(reviewerDecision.target.type, 'cleanup');
  assert.match(reviewerDecision.reason, /cleanup stale review worktrees/);
  assert.equal(readJson('.autonomy/runtime/custom-lifecycle/queues/shadow-reviewer-agent.json').tasks[0].status, 'archived');

  const reviewerPrepare = runJson('agents/reviewer/prepare-env.mjs', {
    repoRoot: fixtureRoot,
    target: reviewerDecision.target,
  });
  assert.equal(reviewerPrepare.skipped, true);
  assert.match(reviewerPrepare.reason, /stale PRD review task/);

  const reviewerFinalize = runJson('agents/reviewer/finalize.mjs', {
    repoRoot: fixtureRoot,
    target: reviewerDecision.target,
  });
  assert.equal(reviewerFinalize.status, 'stale-prd-review-skipped');
  assert.equal(reviewerFinalize.worktreeCleanup.status, 'removed');
  assert.equal(fs.existsSync(path.join(fixtureRoot, '.autonomy', 'worktrees', 'shadow-architecture-agent', 'custom-lifecycle-2026-05-24-task-stale-arch')), false);
  assert.equal(fs.existsSync(path.join(fixtureRoot, '.autonomy', 'worktrees', 'shadow-reviewer-agent', 'review-pr-task-stale-arch')), false);

  resetArchitectureTask('in_progress');
  const pmDecision = runJson('agents/pm/should-run.mjs', { repoRoot: fixtureRoot });
  assert.equal(pmDecision.shouldRun, true);
  assert.equal(pmDecision.target.type, 'queued-prd');
  assert.equal(pmDecision.target.id, 'prd-next');
  assert.equal(readJson('.autonomy/runtime/custom-lifecycle/prd-state/prd-archived.json').status, 'archived');

  console.log('custom lifecycle stale PRD regression passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function resetArchitectureTask(status) {
  const queue = readJson('.autonomy/runtime/custom-lifecycle/queues/shadow-architecture-agent.json');
  queue.tasks[0] = {
    ...queue.tasks[0],
    status,
    staleReason: undefined,
    stalePrdState: undefined,
    archivedAt: undefined,
  };
  writeJson('.autonomy/runtime/custom-lifecycle/queues/shadow-architecture-agent.json', queue);
}

function runJson(scriptPath, input) {
  const result = spawnSync('node', [path.join(repoRoot, 'presets', scriptPath.replace(/^agents\//, ''))], {
    cwd: repoRoot,
    input: `${JSON.stringify(input)}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function writeJson(relativePath, value) {
  const filePath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), 'utf8'));
}

});
