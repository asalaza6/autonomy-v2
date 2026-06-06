import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { run } from '../../src/autonomy-v2/commands/health-command.js';

test('health score command prints local repo health as json', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-health-command-'));
  const originalLog = console.log;
  const lines: string[] = [];
  try {
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'small.txt'), 'one\n');
    fs.writeFileSync(path.join(repoRoot, 'src', 'large.txt'), Array.from({ length: 12 }, (_, index) => `line ${index}`).join('\n'));
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };

    run(repoRoot, {
      json: true,
      'max-lines': '10',
      threshold: '80',
      top: '10',
    }, 'health:score');

    const payload = JSON.parse(lines.join('\n'));
    assert.equal(payload.status, 'completed');
    assert.equal(payload.mode, 'file-size-only');
    assert.equal(payload.summary.oversizedFileCount, 1);
    assert.equal(payload.topLargeFiles[0].file, path.join('src', 'large.txt'));
  } finally {
    console.log = originalLog;
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('health command prints usage help', () => {
  const originalLog = console.log;
  const lines: string[] = [];
  try {
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(' '));
    };

    run(process.cwd(), {
      help: true,
    }, 'health:score');

    const output = lines.join('\n');
    assert.match(output, /Autonomy v2 health commands/);
    assert.match(output, /health:score/);
    assert.match(output, /health:why/);
    assert.match(output, /--max-lines/);
    assert.match(output, /docs\/health-score\.md/);
  } finally {
    console.log = originalLog;
  }
});
