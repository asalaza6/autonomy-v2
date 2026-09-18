import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';


import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const REPO_ROOT = fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))
  ? PROJECT_ROOT
  : path.join(PROJECT_ROOT, '..');
const PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'package.json');

test('public runtime entrypoints exclude removed legacy services', () => {
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
  assert.equal(packageJson.main, './dist/src/autonomy-v2/index.js');
  assert.equal(packageJson.exports['.'], './dist/src/autonomy-v2/index.js');
  assert.equal(packageJson.exports['./server'], './dist/src/server/server-main.js');
  assert.equal(packageJson.exports['./control'], undefined);
  assert.equal(packageJson.bin['autonomy-v2-control'], undefined);
  assert.equal(packageJson.exports['./worker'], undefined);
  assert.equal(packageJson.bin['autonomy-v2-worker'], undefined);

  assert.equal(packageJson.exports['./runtime'], './dist/src/runtime/index.js');
});

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.tsx?$/.test(file) ? [file] : [];
  });
}

test('core has no workflow role definitions or concrete workflow imports', () => {
  for (const file of sourceFiles(path.join(REPO_ROOT, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /AGENT_ROLES|TASK_TYPES|executePrd|review.reconciliation|runtime\.workers|control-presets\/(development|maintenance|shared)/, file);
  }
});

test('control presets reuse only public runtime contracts from core', () => {
  for (const file of sourceFiles(path.join(REPO_ROOT, 'control-presets')).filter(file => !file.includes('/tests/'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/from ['"]([^'"]*src\/[^'"]+)['"]/g)) {
      assert.match(match[1], /src\/(runtime|frontend)\/index\.js$/, file);
    }
    assert.doesNotMatch(text, /acquireStateLock|Atomics\.wait|fs\.(readFileSync|writeFileSync)|spawnSync|execFileSync/, file);
  }
});
