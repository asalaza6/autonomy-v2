import { fileURLToPath } from 'node:url';
import { main as runCli } from '../autonomy-v2/index.js';
import { buildPrdAddCliOptions, executePrdAdd, executePrdReset, executePrdPriorityUpdate } from '../autonomy-v2/local/prd-service.js';
import { loadAutonomyEnv } from '../env/env-main.js';
import { withStateLock } from '../lock/lock-main.js';
import { validateLocalAction } from './actions.js';

/** Fixed worker dispatch keeps blocking CLI/Git services off the local UI host. */
async function main() {
  let request = '';
  for await (const chunk of process.stdin) {
    request += chunk;
    if (request.length > 2097152) throw new Error('Action request too large.');
  }
  const { name, input, rootDir } = JSON.parse(request);
  if (typeof rootDir !== 'string' || !rootDir) throw new Error('Missing repository root.');
  const data = validateLocalAction(name, input);
  loadAutonomyEnv(rootDir);
  if (name.startsWith('prd:')) {
    const result = await withStateLock(rootDir, () => {
      if (name === 'prd:add') return executePrdAdd(rootDir, buildPrdAddCliOptions(data));
      if (name === 'prd:reset') return executePrdReset(rootDir, { 'confirm-prd-id': data.prdId, reason: data.reason });
      return executePrdPriorityUpdate(rootDir, { 'prd-id': data.prdId, priority: data.priority, reason: data.reason });
    });
    console.log(JSON.stringify(result));
    return;
  }
  const command = { deploy: 'deploy', 'package:update': 'update', 'server:restart': 'server:restart' }[name];
  if (!command) throw new Error(`Unsupported worker action: ${name}`);
  await runCli([command, '--root', rootDir, '--json', ...(name === 'server:restart' ? ['--detached'] : [])]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
