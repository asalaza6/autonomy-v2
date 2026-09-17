import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('packaged preset lifecycle: review-handoff-normalization', () => {
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-lifecycle-review-handoff-'));

try {
  writeJson('prompts/autonomous/v2/specs/prds/prd-active.json', {
    id: 'prd-active',
    title: 'Active PRD',
  });
  writeJson('.autonomy/runtime/custom-lifecycle/queues/shadow-architecture-agent.json', {
    agentId: 'shadow-architecture-agent',
    role: 'implementation',
    tasks: [
      {
        id: 'task-draft-handoff',
        title: 'Draft handoff',
        prdId: 'prd-active',
        sourcePrdId: 'prd-active',
        status: 'review-queued',
        remoteUrl: 'https://github.com/asalaza6/darwinexzero-frontend/pull/312',
      },
    ],
  });
  writeJson('.autonomy/runtime/custom-lifecycle/queues/shadow-reviewer-agent.json', {
    agentId: 'shadow-reviewer-agent',
    role: 'review',
    tasks: [
      {
        id: 'review-pr-task-draft-handoff',
        prId: 'pr-task-draft-handoff',
        sourceTaskId: 'task-draft-handoff',
        sourcePrdId: 'prd-active',
        remoteUrl: 'https://github.com/asalaza6/darwinexzero-frontend/pull/312',
        status: 'review-queued',
      },
    ],
  });
  writeJson('.autonomy/runtime/custom-lifecycle/state/prs.json', {
    pullRequests: [
      {
        id: 'pr-task-draft-handoff',
        taskId: 'task-draft-handoff',
        prdId: 'prd-active',
        remote: { url: 'https://github.com/asalaza6/darwinexzero-frontend/pull/312' },
        publicationState: { draft: true },
        status: 'review-queued',
      },
    ],
  });

  const architectureDecision = runJson('agents/architecture/should-run.mjs', { repoRoot: fixtureRoot });
  assert.equal(architectureDecision.shouldRun, false);
  assert.match(architectureDecision.reason, /waiting for reviewer task review-pr-task-draft-handoff/);

  const reviewerDecision = runJson('agents/reviewer/should-run.mjs', { repoRoot: fixtureRoot });
  assert.equal(reviewerDecision.shouldRun, true);
  assert.equal(reviewerDecision.target.id, 'review-pr-task-draft-handoff');
  assert.equal(reviewerDecision.target.task.status, 'review-queued');

  const architecturePrompt = fs.readFileSync(path.join(repoRoot, 'presets/architecture/build-prompt.mjs'), 'utf8');
  assert.doesNotMatch(architecturePrompt, /gh pr create|github_create_pull_request|draft:\s*true|--draft/);
  assert.match(architecturePrompt, /finalizer command owns commit, push, PR publication\/readiness/);

  console.log('custom lifecycle review handoff normalization passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
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

});
