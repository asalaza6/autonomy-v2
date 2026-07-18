import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { main as cliMain } from '../src/cli.js';
import { main as serverMain } from '../src/server.js';
import { loadRuntime } from '../src/runtime.js';
import {
  makeRoot,
  withEnvironment,
  writeExecutable,
  writeFluxborneFixture,
  writeJson,
} from './helpers.js';

test('the CLI exposes only configured custom agents', async () => {
  const fixture = writeFluxborneFixture(makeRoot());
  const result: any = await cliMain(['custom-agent:list', '--root', fixture.rootDir]);
  assert.deepEqual(result?.runtimeKeys, ['game-agent:fluxborne']);
});

test('the manual run command uses the same decision and runtime path', async () => {
  const fixture = writeFluxborneFixture(makeRoot());
  await withEnvironment({ AUTONOMY_CUSTOM_AGENT_STUB: '1' }, async () => {
    const result: any = await cliMain([
      'custom-agent:run',
      '--root',
      fixture.rootDir,
      '--runtime-key',
      'game-agent:fluxborne',
    ]);
    assert.equal(result?.started, true);
    assert.equal(result?.exit.code, 0);
  });
  const runtime = loadRuntime(fixture.rootDir);
  assert.equal(runtime.customAgents['game-agent:fluxborne'].running, false);
});

test('removed built-in commands fail clearly', async () => {
  await assert.rejects(
    cliMain(['prd:add', '--root', makeRoot()]),
    /Unknown command/
  );
});

test('a server tick with no config performs no default work', async () => {
  const result: any = await serverMain(['tick', '--root', makeRoot()]);
  assert.deepEqual(result?.started, []);
  assert.deepEqual(result?.runtime.customAgents, {});
  assert.deepEqual(result?.runtime.customAgentInvocations, {});
});

test('importing the CLI module from a consumer cli.js has no side effects', () => {
  const rootDir = makeRoot();
  const consumerCli = path.join(rootDir, 'cli.js');
  const modulePath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  writeJson(path.join(rootDir, 'package.json'), { type: 'module' });
  writeExecutable(consumerCli, `#!/usr/bin/env node
await import(${JSON.stringify(pathToFileURL(modulePath).href)});
console.log('IMPORT_DONE');
`);

  const result = spawnSync(process.execPath, [consumerCli, 'consumer-argument'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'IMPORT_DONE');
});
