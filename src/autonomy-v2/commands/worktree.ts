import { TASK_TYPES, isImplementationRole } from '../../agents/role-catalog.js';
import { appendAgentLog, ensureInitialized, getAgent, printOutput, requireOption, writeJson, getAutonomyPaths } from './shared-core.js';
import { loadAllState } from './shared-prds.js';
import { resolveTaskForWorktreePreparation } from './shared-lanes.js';
import { prepareTaskWorktree } from './shared-worktrees.js';

function run(rootDir, options) {
  ensureInitialized(rootDir);
  const state = loadAllState(rootDir);
  const taskId = requireOption(options, 'task');
  const task = resolveTaskForWorktreePreparation(rootDir, state, taskId);
  const agent = getAgent(state.config, task.agentId);
  if (!isImplementationRole(agent.role) && agent.role !== TASK_TYPES.CONFLICT) {
    throw new Error(`Agent "${agent.id}" does not use worktree preparation.`);
  }
  const create = options.create === true;
  const payload = prepareTaskWorktree(rootDir, state.config, state.branchLocks, task, { create });
  writeJson(getAutonomyPaths(rootDir).branchLocksState, state.branchLocks);

  appendAgentLog(rootDir, state.config, task.agentId, 'worktree:prepare', {
    input: {
      taskId: task.id,
      create,
    },
    output: payload,
  });

  printOutput(options, payload, () => {
    console.log(`${create ? 'Created' : 'Planned'} worktree for ${task.id}`);
    console.log(`Branch: ${payload.branch}`);
    console.log(`Worktree: ${payload.worktreePath}`);
  });
}


export { run };
