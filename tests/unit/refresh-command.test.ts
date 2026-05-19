import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { run as initRun } from '../../src/autonomy-v2/commands/init.js';
import { run as refreshRun } from '../../src/autonomy-v2/commands/refresh.js';

test('refresh reruns the forced autonomy scaffold without updating package dependencies', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-refresh-'));
  const manifestPath = path.join(rootDir, 'package.json');
  const scaffoldReadmePath = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'README.md');
  const staleTasksPath = path.join(rootDir, '.autonomy', 'runtime', 'state', 'tasks.json');
  const stalePrdsPath = path.join(rootDir, '.autonomy', 'runtime', 'state', 'prds.json');

  fs.writeFileSync(manifestPath, `${JSON.stringify({
    optionalDependencies: {
      '@asalaza6/autonomy-v2': '1.0.0',
    },
  }, null, 2)}\n`, 'utf8');

  withMutedConsole(() => initRun(rootDir, { json: true }));
  const originalReadme = fs.readFileSync(scaffoldReadmePath, 'utf8');
  fs.writeFileSync(scaffoldReadmePath, 'stale scaffold\n', 'utf8');
  fs.writeFileSync(staleTasksPath, '{}\n', 'utf8');
  fs.writeFileSync(stalePrdsPath, '{}\n', 'utf8');

  withMutedConsole(() => refreshRun(rootDir, { json: true }));

  assert.equal(fs.readFileSync(scaffoldReadmePath, 'utf8'), originalReadme);
  assert.equal(fs.existsSync(staleTasksPath), false);
  assert.equal(fs.existsSync(stalePrdsPath), false);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.optionalDependencies['@asalaza6/autonomy-v2'], '1.0.0');
});

function withMutedConsole(callback: () => void) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    callback();
  } finally {
    console.log = originalLog;
  }
}
