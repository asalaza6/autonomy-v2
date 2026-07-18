import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const projectRoot = process.cwd();

test('the source tree contains only the server, management commands, and custom-agent runtime', () => {
  const files = listFiles(path.join(projectRoot, 'src'))
    .map((file) => path.relative(projectRoot, file))
    .sort();
  assert.deepEqual(files, [
    'src/autonomy-v2/index.ts',
    'src/cli.ts',
    'src/commands/auth-command.ts',
    'src/commands/project-command.ts',
    'src/commands/server-command.ts',
    'src/commands/update-command.ts',
    'src/custom-agents/codex.ts',
    'src/custom-agents/command.ts',
    'src/custom-agents/config.ts',
    'src/custom-agents/scheduler.ts',
    'src/custom-agents/state.ts',
    'src/custom-agents/worker.ts',
    'src/runtime.ts',
    'src/server.ts',
    'src/server/server-main.ts',
    'src/types.ts',
  ]);
});

test('package metadata publishes no control plane or legacy binaries', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(packageJson.bin).sort(), ['autonomy-v2', 'autonomy-v2-server']);
  assert.equal(packageJson.exports['./control'], undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.deepEqual(packageJson.files, ['README.md', 'LICENSE', 'dist/bin', 'dist/src']);
});

function listFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  });
}
