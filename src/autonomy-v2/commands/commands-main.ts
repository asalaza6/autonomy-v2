import { loadAutonomyEnv } from '../../env/env-main.js';
import { createFrontendRuntime } from '../../frontend/configured-runtime.js';
import { parseCli, resolveRootDir } from '../cli/parse.js';
import { printHelp } from '../cli/help.js';
import { run as initialize } from './init.js';
import { run as refresh } from './refresh.js';
import { run as customAgent } from './custom-agent-command.js';
import { run as controlServer } from '../../server/server-controller.js';

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  const rootDir = resolveRootDir(String(options.root || ''));
  loadAutonomyEnv(rootDir);
  try {
    if (!command || ['help', '--help', '-h'].includes(command)) return printHelp();
    if (command === 'init') return initialize(rootDir, options);
    if (command === 'refresh') return refresh(rootDir, options);
    if (['custom-agent:list', 'custom-agent:toggle', 'custom-agent:run', 'custom-agent:reset'].includes(command)) return customAgent(rootDir, options, command);
    if (['server:start', 'server:kill', 'server:restart', 'server:status'].includes(command)) return controlServer(rootDir, options, command);
    if (command === 'action:run') {
      const { runtime } = await createFrontendRuntime({ rootDir, configPath: options.config ? String(options.config) : undefined });
      try {
        const input = options.input ? JSON.parse(String(options.input)) : {};
        const operation = await runtime.runAction(String(options.name || ''), input);
        for (;;) {
          const result = await runtime.getOperation(operation.id);
          if (result.status !== 'running') {
            console.log(JSON.stringify(result, null, 2));
            if (result.status === 'failure') process.exitCode = 1;
            return result;
          }
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      } finally { runtime.dispose(); }
    }
    throw new Error(`Unknown command "${command}". Run "autonomy-v2 --help".`);
  } catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
}
