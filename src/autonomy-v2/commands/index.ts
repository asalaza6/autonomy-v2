import { loadAutonomyEnv } from '../../env/index.js';
import { withStateLock } from '../../lock/index.js';
import { AGENT_ROLES, buildRoleEventName } from '../../agents/role-catalog.js';
import { printHelp } from '../cli/help.js';
import { isMutatingCommand, parseCli, resolveRootDir } from '../cli/parse.js';
import initCommand from './init.js';
import statusCommand from './status.js';
import taskCommand from './task.js';
import prdCommand from './prd.js';
import worktreeCommand from './worktree.js';
import scopeCommand from './scope.js';
import prCommand from './pr.js';
import gateCommand from './gate.js';
import mergeCommand from './merge.js';
import runtimeCommand from './runtime.js';

const REVIEW_RECORD_COMMAND = buildRoleEventName(AGENT_ROLES.REVIEW, 'record');

const COMMAND_HANDLERS = new Map([
  ['init', initCommand],
  ['status', statusCommand],
  ['task:add', taskCommand],
  ['task:finish', taskCommand],
  ['task:list', taskCommand],
  ['prd:add', prdCommand],
  ['prd:list', prdCommand],
  ['prd:archive-completed', prdCommand],
  ['worktree:prepare', worktreeCommand],
  ['scope:validate', scopeCommand],
  ['pr:record', prCommand],
  [REVIEW_RECORD_COMMAND, gateCommand],
  ['merge', mergeCommand],
  ['runtime:status', runtimeCommand],
]);

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  const rootDir = resolveRootDir(options.root);
  loadAutonomyEnv(rootDir);

  try {
    if (command === 'help' || command === '--help' || command === '-h' || command === '') {
      printHelp();
      return;
    }

    const handler = COMMAND_HANDLERS.get(command);
    if (!handler) {
      throw new Error('Unknown command "'.concat(command, '". Run "autonomy-v2 --help".'));
    }

    const runCommand = () => handler.run(rootDir, options, command);
    if (!isMutatingCommand(command)) {
      await runCommand();
      return;
    }
    await withStateLock(rootDir, runCommand);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}


export { main };
export default {
  main
};

