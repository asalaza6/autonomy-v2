import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function makeRepo(customConfig, controlPlane = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agents-'));
  const configDir = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'context.md'), '# Strategy context\n', 'utf8');
  fs.writeFileSync(path.join(configDir, 'control-plane.json'), `${JSON.stringify({
    schemaVersion: 1,
    repoId: 'fixture',
    spawnCustomAgents: 'prompts/autonomous/v2/config/custom-agents.json',
    ...controlPlane,
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(configDir, 'custom-agents.json'), `${JSON.stringify(customConfig, null, 2)}\n`, 'utf8');
  return rootDir;
}

