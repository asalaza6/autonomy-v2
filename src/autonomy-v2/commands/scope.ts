import { collectFilesForValidation, ensureInitialized, evaluateScope, getAgent, getTask, loadAllState, printOutput, requireOption, } from './shared.js';

function run(rootDir, options) {
  ensureInitialized(rootDir);
  const { config, taskQueues } = loadAllState(rootDir);
  const task = getTask(taskQueues, requireOption(options, 'task'));
  const agent = getAgent(config, task.agentId);
  const files = collectFilesForValidation(rootDir, options);
  if (files.length === 0) {
    throw new Error('No files provided for validation. Use --files or --worktree.');
  }

  const result = evaluateScope({
    files,
    agent,
    task,
  });

  if (!result.ok) {
    process.exitCode = 1;
  }

  printOutput(options, result, () => {
    console.log(result.ok ? 'Scope validation passed.' : 'Scope validation failed.');
    if (result.violations.length > 0) {
      result.violations.forEach((violation) => {
        console.log(`- ${violation.file}: ${violation.reason}`);
      });
    }
  });
}


export { run };
