import { createActionRuntime } from '../runtime/index.js';
import { fileURLToPath } from 'node:url';
import { loadAutonomyEnv } from '../env/env-main.js';
import { loadActionModule } from './actions.js';
import { createActionCapabilities } from './capabilities.js';

/** Module paths come from trusted host configuration, never action input. */
async function main() {
  let request = '';
  for await (const chunk of process.stdin) {
    request += chunk;
    if (request.length > 2097152) throw new Error('Action request too large.');
  }
  const { modulePath, name, input, rootDir, options } = JSON.parse(request);
  if (typeof rootDir !== 'string' || !rootDir) throw new Error('Missing repository root.');
  loadAutonomyEnv(rootDir);
  const module = await loadActionModule(modulePath);
  if (!Object.hasOwn(module.default, name)) throw new Error(`Unknown action: ${name}`);
  const action = module.default[name];
  const result = await action.run(action.validate(input), { rootDir, runtime: createActionRuntime(rootDir), options, capabilities: createActionCapabilities(rootDir), log: (message) => console.error(message) });
  if (result !== undefined) console.log(JSON.stringify(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
