import { loadAutonomyEnv } from '../../env/env-main.js';
import { withStateLock } from '../../lock/lock-main.js';
import { AGENT_ROLES, buildRoleEventName } from '../../agents/role-catalog.js';
import { printHelp } from '../cli/help.js';
import { isMutatingCommand, parseCli, resolveRootDir } from '../cli/parse.js';
import { run as initRun } from './init.js';
import { run as statusRun } from './status.js';
import { run as taskRun } from './task.js';
import { run as prdRun } from './prd-command.js';
import { run as worktreeRun } from './worktree.js';
import { run as scopeRun } from './scope.js';
import { run as prRun } from './pr.js';
import { run as gateRun } from './gate.js';
import { run as mergeRun } from './merge.js';
import { run as runtimeRun } from './runtime-command.js';
import { run as deployRun } from './deploy.js';
import { run as updateRun } from './update.js';
import { run as refreshRun } from './refresh.js';
import type { CliOptions } from '../autonomy-types.js';

const REVIEW_RECORD_COMMAND = buildRoleEventName(AGENT_ROLES.REVIEW, 'record');

const COMMAND_HANDLERS = new Map([
  ['init', initRun],
  ['status', statusRun],
  ['task:add', taskRun],
  ['task:finish', taskRun],
  ['task:list', taskRun],
  ['prd:add', prdRun],
  ['prd:list', prdRun],
  ['prd:archive-completed', prdRun],
  ['worktree:prepare', worktreeRun],
  ['scope:validate', scopeRun],
  ['pr:record', prRun],
  [REVIEW_RECORD_COMMAND, gateRun],
  ['merge', mergeRun],
  ['deploy', deployRun],
  ['runtime:status', runtimeRun],
  ['update', updateRun],
  ['refresh', refreshRun],
]);

async function main(argv: string[] = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  const rootDir = resolveRootDir(String(options.root || ''));
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

    const runCommand = () => handler(rootDir, options as CliOptions, command);
    if (!isMutatingCommand(command)) {
      await runCommand();
      return;
    }
    if (shouldBypassStateLock()) {
      await runCommand();
      return;
    }
    await withStateLock(rootDir, runCommand);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

function shouldBypassStateLock() {
  return String(process.env.AUTONOMY_SKIP_STATE_LOCK || '').trim().toLowerCase() === '1'
    || String(process.env.AUTONOMY_SKIP_STATE_LOCK || '').trim().toLowerCase() === 'true';
}


export { main };
