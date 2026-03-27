import path from 'path';
import { getAgentDefinition } from '../../agents/AgentDefinitionRegistry.js';
import { IMPLEMENTATION_DUE_STATUSES } from './orchestrator-constants.js';

function getAgent(config, agentId) {
  const agent = (config.agents || []).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent "${agentId}".`);
  }
  return agent;
}

function buildTaskQueueState(agent, tasks = []) {
  return getAgentDefinition(agent).buildQueueState(agent, tasks);
}

function listTasks(queue) {
  return queue && Array.isArray(queue.tasks) ? queue.tasks : [];
}

function getImplementationTaskState(task) {
  return String((task && (task.state || task.status)) || '').trim();
}

function isPendingImplementationTask(task) {
  const state = getImplementationTaskState(task);
  return state === 'active' || state === 'queued';
}

function buildTaskLaneKey(task) {
  if (task && task.laneKey) {
    return task.laneKey;
  }
  if (task && task.prdId) {
    return `${task.prdId}:${task.agentId}`;
  }
  return task ? task.id : '';
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'shared';
}

function buildTaskBranchName(config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const agentSegment = slugify(task.agentId);
  const laneSegment = slugify(buildTaskLaneKey(task));
  return `${config.branchPrefixes.task}/${sprintSegment}/${agentSegment}/${laneSegment}`;
}

function buildWorktreePath(rootDir, config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const laneSegment = slugify(buildTaskLaneKey(task));
  return path.join(rootDir, config.worktreesRoot, task.agentId, `${sprintSegment}-${laneSegment}`);
}

function normalizeNonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function listPrds(prds) {
  return Array.isArray(prds && prds.prds) ? prds.prds : [];
}

function comparePrdBacklogOrder(left, right) {
  const leftCreated = String(left && left.createdAt || '');
  const rightCreated = String(right && right.createdAt || '');
  const createdOrder = leftCreated.localeCompare(rightCreated);
  if (createdOrder !== 0) {
    return createdOrder;
  }

  const leftUpdated = String(left && left.updatedAt || '');
  const rightUpdated = String(right && right.updatedAt || '');
  const updatedOrder = leftUpdated.localeCompare(rightUpdated);
  if (updatedOrder !== 0) {
    return updatedOrder;
  }

  return String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function implementationTaskNeedsDispatch(task) {
  return IMPLEMENTATION_DUE_STATUSES.has(getImplementationTaskState(task));
}

function getImplementationTaskPriority(task) {
  if (!task) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (getImplementationTaskState(task) === 'active') {
    return 0;
  }
  if (task.type === 'review_followup') {
    return 1;
  }
  if (task.type === 'conflict_resolution') {
    return 2;
  }
  if (getImplementationTaskState(task) === 'queued') {
    return 3;
  }
  return 10;
}

function compareImplementationTaskPriority(left, right) {
  return getImplementationTaskPriority(left)
    - getImplementationTaskPriority(right);
}

function selectImplementationTask(tasks, prds) {
  const prdById = new Map((prds || []).map((prd) => [prd.id, prd]));
  return (tasks || [])
    .filter((candidate) => implementationTaskNeedsDispatch(candidate))
    .sort((left, right) => {
      const priorityOrder = compareImplementationTaskPriority(left, right);
      if (priorityOrder !== 0) {
        return priorityOrder;
      }
      return comparePrdBacklogOrder(prdById.get(left.prdId), prdById.get(right.prdId));
    })[0] || null;
}

export {
  buildTaskBranchName,
  buildTaskLaneKey,
  buildTaskQueueState,
  buildWorktreePath,
  compareImplementationTaskPriority,
  comparePrdBacklogOrder,
  getAgent,
  getImplementationTaskState,
  implementationTaskNeedsDispatch,
  isPendingImplementationTask,
  listPrds,
  listTasks,
  normalizeNonEmptyString,
  selectImplementationTask,
  slugify,
};
