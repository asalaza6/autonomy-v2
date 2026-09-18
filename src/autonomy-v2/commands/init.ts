import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, printOutput } from './shared-core.js';

export function run(rootDir: string, options = {}) {
  const created: string[] = [], skipped: string[] = [];
  const files = {
    '.env.autonomy': 'AUTONOMY_INITIALIZED=1\n',
    'prompts/autonomous/v2/config/control-plane.json': JSON.stringify({ schemaVersion: 1, repoId: path.basename(rootDir), spawnCustomAgents: 'prompts/autonomous/v2/config/custom-agents.json', controls: {} }, null, 2) + '\n',
    'prompts/autonomous/v2/config/custom-agents.json': JSON.stringify({ schemaVersion: 1, agents: [] }, null, 2) + '\n',
    'prompts/autonomous/v2/project-context.md': '# Project context\n\nDescribe this repository for your agents.\n',
  };
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(rootDir, file);
    if (fs.existsSync(target)) { skipped.push(file); continue; }
    ensureDir(path.dirname(target)); fs.writeFileSync(target, content); created.push(file);
  }
  const ignore = path.join(rootDir, '.gitignore');
  const existing = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  const missing = ['.autonomy/', '.env.autonomy'].filter(line => !existing.split(/\r?\n/).includes(line));
  if (missing.length) fs.writeFileSync(ignore, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  const result = { rootDir, created, skipped };
  printOutput(options, result, () => console.log(`Initialized ${rootDir}: ${created.length} files created.`));
  return result;
}
