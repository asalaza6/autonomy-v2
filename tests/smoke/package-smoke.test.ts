import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createFixtureRepo, initAutonomyRepo, runNode, CLI_BIN } from './package-smoke.helpers.js';

test('init creates generic definitions without workflow scaffold and preserves repository choices', t => {
  const root = createFixtureRepo('generic-init-'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  initAutonomyRepo(root);
  const dir = path.join(root, 'prompts/autonomous/v2/config');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['control-plane.json', 'custom-agents.json']);
  const file = path.join(dir, 'custom-agents.json'); fs.writeFileSync(file, '{"agents":[],"mine":true}');
  runNode(CLI_BIN, ['refresh', '--root', root]);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mine, true);
  const result = runNode(CLI_BIN, ['custom-agent:list', '--root', root, '--json']);
  assert.ok(result);
});
