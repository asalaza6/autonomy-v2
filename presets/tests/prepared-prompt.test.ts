import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('preset prompts use the worker preparation envelope after PRD promotion and worktree creation', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-prompt-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  const prdRelativePath = 'prompts/autonomous/v2/specs/prds/promoted.json';
  fs.mkdirSync(path.dirname(path.join(repoRoot, prdRelativePath)), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, prdRelativePath), JSON.stringify({
    id: 'promoted', description: 'Preserve this specification after queue promotion.',
  }));
  const invoke = (agent, input) => {
    const result = spawnSync(process.execPath, [path.join(packageRoot, 'presets', agent, 'build-prompt.mjs')], {
      cwd: repoRoot, input: JSON.stringify({ repoRoot, ...input }), encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).prompt;
  };
  const pm = invoke('pm', {
    target: { id: 'promoted', path: 'prompts/autonomous/v2/specs/prds/queue/promoted.json' },
    previous: { environment: { prdRelativePath, promotion: { promoted: true } } },
  });
  assert.match(pm, /Preserve this specification after queue promotion/);
  assert.match(pm, /"promoted": true/);

  const worktreePath = path.join(repoRoot, '.autonomy/worktrees/review');
  const summaryPath = path.join(repoRoot, '.autonomy/runtime/review-summary.md');
  const reviewer = invoke('reviewer', {
    previous: { environment: { worktreePath, summaryPath, headFetchWarning: 'fetch warning' } },
  });
  assert.ok(reviewer.includes(`"reviewWorktree": ${JSON.stringify(worktreePath)}`));
  assert.ok(reviewer.includes(`"summaryPath": ${JSON.stringify(summaryPath)}`));
  assert.match(reviewer, /fetch warning/);
});
