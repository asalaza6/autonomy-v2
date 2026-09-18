import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI_BIN = path.join(PROJECT_ROOT, 'bin/autonomy-v2.js');
export function git(cwd: string, args: string[]) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
export function createFixtureRepo(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'src/apps/fixture'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/apps/fixture/index.js'), 'export const value = 1;\n');
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.email', 'test@example.test']); git(root, ['config', 'user.name', 'Test']);
  git(root, ['add', '.']); git(root, ['commit', '-m', 'fixture']); git(root, ['branch', 'dev']); return root;
}
export function runNode(script: string, args: string[], options: Record<string, any> = {}) {
  return execFileSync(process.execPath, [script, ...args], { cwd: options.cwd || PROJECT_ROOT, encoding: 'utf8', env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
export function initAutonomyRepo(root: string) { return runNode(CLI_BIN, ['init', '--root', root]); }
