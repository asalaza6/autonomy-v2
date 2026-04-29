import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCli } from '../../src/autonomy-v2/cli/parse.js';

test('parseCli supports --key=value syntax', () => {
  const parsed = parseCli([
    'deploy',
    '--auto-stash=false',
    '--root=/tmp/repo',
  ]);

  assert.equal(parsed.command, 'deploy');
  assert.deepEqual(parsed.options, {
    'auto-stash': 'false',
    root: '/tmp/repo',
  });
});

test('parseCli preserves repeated options across equals and spaced syntax', () => {
  const parsed = parseCli([
    'task:add',
    '--acceptance=one',
    '--acceptance',
    'two',
  ]);

  assert.equal(parsed.command, 'task:add');
  assert.deepEqual(parsed.options, {
    acceptance: ['one', 'two'],
  });
});
