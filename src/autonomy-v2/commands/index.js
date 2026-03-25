const { loadAutonomyEnv } = require('../../env');
const { withStateLock } = require('../../lock');
const { AGENT_ROLES, buildRoleEventName } = require('../../agents/role-catalog');
const { printHelp } = require('../cli/help');
const { isMutatingCommand, parseCli, resolveRootDir } = require('../cli/parse');
const initCommand = require('./init');
const statusCommand = require('./status');
const taskCommand = require('./task');
const prdCommand = require('./prd');
const worktreeCommand = require('./worktree');
const scopeCommand = require('./scope');
const prCommand = require('./pr');
const gateCommand = require('./gate');
const mergeCommand = require('./merge');
const runtimeCommand = require('./runtime');

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

module.exports = {
  main,
};
