import { createActionRuntime } from '../../../src/runtime/index.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import actions from '../actions.js';

test('package update reports errors directly and releases its repository state lock', async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-maintenance-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const action = actions['package:update'];
  await assert.rejects(async () => action.run(action.validate({}), { rootDir, runtime: createActionRuntime(rootDir), log() {} }), /package.json/);
  assert.equal(fs.existsSync(path.join(rootDir, '.autonomy', 'state-lock')), false);
});
