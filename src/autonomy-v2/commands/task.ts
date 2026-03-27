import { AGENT_ROLES, TASK_TYPES, getRoleAgentLabel, getRoleLabel, isImplementationRole, } from '../../agents/role-catalog.js';
import { appendAgentLog, ensureInitialized, getAgent, getListOption, getStringOption, printOutput, requireOption, } from './shared-core.js';
import { buildTaskLaneKey, getImplementationTaskState, getTask, getTaskQueue, listTasks } from './shared-repo.js';
import { commitTrackedImplementationQueue, resolveImplementationBranchRef, writeTaskQueues } from './shared-queues.js';
import { loadAllState } from './shared-prds.js';

function run(rootDir, options, command) {
  if (command === 'task:add') {
    return handleTaskAdd(rootDir, options);
  }
  if (command === 'task:finish') {
    return handleTaskFinish(rootDir, options);
  }
  return handleTaskList(rootDir, options);
}

function handleTaskAdd(rootDir, options) {
  ensureInitialized(rootDir);
  const { config, sprint, taskQueues } = loadAllState(rootDir);
  const taskId = requireOption(options, 'id');
  const title = requireOption(options, 'title');
  const agentId = requireOption(options, 'agent');
  const agent = getAgent(config, agentId);

  if (!isImplementationRole(agent.role)) {
    throw new Error(`Agent "${agentId}" is not an ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)}.`);
  }
  if (listTasks(taskQueues).some((task) => task.id === taskId)) {
    throw new Error(`Task "${taskId}" already exists.`);
  }

  const checks = getListOption(options, 'check');
  const acceptance = getListOption(options, 'acceptance');
  const now = new Date().toISOString();
  const task = {
    id: taskId,
    title,
    description: getStringOption(options, 'description', ''),
    agentId,
    prdId: getStringOption(options, 'prd-id', ''),
    laneKey: getStringOption(options, 'lane-key', ''),
    type: getStringOption(options, 'type', TASK_TYPES.DEFAULT),
    sprintId: getStringOption(options, 'sprint-id', sprint.sprintId || 'shared'),
    baseBranch: getStringOption(options, 'base-branch', sprint.defaultTaskBaseBranch || config.integrationBranch),
    checks: checks.length > 0 ? checks : agent.checks || [],
    acceptance,
    source: getStringOption(options, 'source', 'manual'),
    state: 'queued',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  task.laneKey = task.laneKey || buildTaskLaneKey(task);
  if (!task.prdId) {
    delete task.prdId;
  }

  const queue = getTaskQueue(taskQueues, config, agentId);
  queue.tasks.push(task);
  commitTrackedImplementationQueue(rootDir, config, agent, queue, {
    commitMessage: `autonomy(queue): add ${task.id}`,
    gitIdentity: agent.gitIdentity,
  });
  writeTaskQueues(rootDir, config, taskQueues);
  appendAgentLog(rootDir, config, agentId, 'task:add', {
    input: {
      id: taskId,
      title,
      acceptance,
    },
    output: {
      status: task.status,
      baseBranch: task.baseBranch,
    },
  });

  printOutput(options, task, () => {
    console.log(`Added task ${task.id} for ${task.agentId}`);
  });
}

function handleTaskFinish(rootDir, options) {
  ensureInitialized(rootDir);
  const { config, taskQueues, branchLocks } = loadAllState(rootDir);
  const task = getTask(taskQueues, requireOption(options, 'task'));
  const agent = getAgent(config, task.agentId);
  const queue = getTaskQueue(taskQueues, config, task.agentId);
  const taskIndex = queue.tasks.findIndex((candidate) => candidate.id === task.id);
  if (taskIndex === -1) {
    throw new Error(`Task "${task.id}" is not present in queue "${task.agentId}".`);
  }
  if (isImplementationRole(agent.role)) {
    const laneKey = task.laneKey || buildTaskLaneKey(task);
    const claimedBranch = resolveImplementationBranchRef(rootDir, config, branchLocks, task.agentId, laneKey, { task });
    if (claimedBranch) {
      throw new Error(
        `${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)[0].toUpperCase()}${getRoleLabel(AGENT_ROLES.IMPLEMENTATION).slice(1)} lane "${laneKey}" is active on branch "${claimedBranch}". Finish it from the lane worktree instead of mutating ${config.integrationBranch}.`
      );
    }
    const now = new Date().toISOString();
    task.state = 'done';
    task.status = 'done';
    task.updatedAt = now;
    task.completedAt = now;
    task.completionMode = getStringOption(options, 'completion-mode', 'noop');
    delete task.lastError;
    if (!queue.tasks.some((candidate) => candidate.id !== task.id && getImplementationTaskState(candidate) === 'active')) {
      const nextTask = queue.tasks.find((candidate) => candidate.id !== task.id && getImplementationTaskState(candidate) === 'queued');
      if (nextTask) {
        nextTask.state = 'active';
        nextTask.status = 'active';
        nextTask.startedAt = nextTask.startedAt || now;
        nextTask.updatedAt = now;
      }
    }
    commitTrackedImplementationQueue(rootDir, config, agent, queue, {
      commitMessage: `autonomy(queue): finish ${task.id}`,
      gitIdentity: agent.gitIdentity,
    });
    writeTaskQueues(rootDir, config, taskQueues);
  } else {
    queue.tasks.splice(taskIndex, 1);
    writeTaskQueues(rootDir, config, taskQueues);
  }
  appendAgentLog(rootDir, config, task.agentId, 'task:finish', {
    input: {
      taskId: task.id,
      laneKey: task.laneKey || buildTaskLaneKey(task),
      type: task.type,
    },
    output: {
      removed: isImplementationRole(agent.role) ? false : true,
      state: task.state || task.status || null,
      completionMode: task.completionMode || null,
    },
  });

  printOutput(options, task, () => {
    console.log(`Finished task ${task.id} for ${task.agentId}`);
  });
}

function handleTaskList(rootDir, options) {
  ensureInitialized(rootDir);
  const { taskQueues } = loadAllState(rootDir);
  const statusFilter = options.status;
  const agentFilter = getStringOption(options, 'agent', '');
  const filtered = listTasks(taskQueues).filter((task) => {
    if (statusFilter && task.status !== statusFilter) {
      return false;
    }
    if (agentFilter && task.agentId !== agentFilter) {
      return false;
    }
    return true;
  });

  printOutput(options, filtered, () => {
    if (filtered.length === 0) {
      console.log('No tasks found.');
      return;
    }

    filtered.forEach((task) => {
      console.log(`${task.id} | ${task.status} | ${task.agentId} | ${task.title}`);
    });
  });
}


export { run };
