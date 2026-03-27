import path from 'path';
import { planPrdTasksWithCodex } from '../../codex/index.js';
import { acquireStateLock } from '../../lock/index.js';
import { isImplementationRole, TASK_TYPES } from '../../agents/role-catalog.js';
import { commitPrdSpecToIntegrationBranch, commitTrackedFilesToIntegrationBranch, commitTrackedPrdStateToIntegrationBranch, readTrackedPrdStateMap } from '../../sync/git.js';
import { extractExecError } from './git.js';
import { buildTaskQueueState, getAgent, listPrds, listTasks } from './helpers.js';
import { appendAgentLog, loadPrds } from './state.js';
import { loadQueues } from './queues.js';

function useCodexStub() {
  return process.env.AUTONOMY_CODEX_STUB === '1';
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function isProcessAcceptance(value) {
  return /(reflog|origin\/|merge-base|created from|branch|commit)/i.test(String(value || ''));
}

function buildFallbackAcceptance(taskId) {
  return [`Task \`${taskId}\` is complete within the assigned agent scope.`];
}

function sanitizePlannedTaskSpecs(taskSpecs) {
  return (Array.isArray(taskSpecs) ? taskSpecs : []).map((task) => {
    const acceptance = normalizeStringList(task && task.acceptance)
      .filter((entry) => !isProcessAcceptance(entry));
    return {
      ...task,
      acceptance: acceptance.length > 0
        ? acceptance
        : buildFallbackAcceptance(task && task.id),
    };
  });
}

function buildPmStubTaskSpecs(config, sprint, prd) {
  const implementationAgents = (config.agents || []).filter((candidate) => isImplementationRole(candidate.role));
  const primaryAgent = implementationAgents[0];
  if (!primaryAgent) {
    return [];
  }
  const taskId = `${prd.id}-${primaryAgent.id}-1`;
  const acceptance = normalizeStringList(prd.requirements);
  const description = typeof prd.specification === 'string' && prd.specification.trim()
    ? prd.specification.trim()
    : acceptance[0] || `Implement ${prd.title || prd.id}.`;
  return [{
    id: taskId,
    title: `Implement ${prd.title || prd.id}`,
    agentId: primaryAgent.id,
    description,
    laneKey: `${prd.id}:${primaryAgent.id}`,
    sprintId: prd.sprintId || sprint.sprintId || 'shared',
    acceptance: acceptance.length > 0 ? acceptance : buildFallbackAcceptance(taskId),
  }];
}

function buildTrackedImplementationQueueUpdates(rootDir, config, taskSpecs, { prd, sprint }) {
  const queues = loadQueues(rootDir, config);
  const nextByAgent = new Map();
  const now = new Date().toISOString();

  (Array.isArray(taskSpecs) ? taskSpecs : []).forEach((spec) => {
    const agent = getAgent(config, spec.agentId);
    const baseQueue = nextByAgent.get(agent.id) || buildTaskQueueState(agent, listTasks(queues[agent.id]).slice());
    const existingIndex = listTasks(baseQueue).findIndex((task) => task.id === spec.id);
    const nextTask = {
      id: spec.id,
      title: spec.title,
      description: spec.description || '',
      agentId: spec.agentId,
      prdId: prd.id || undefined,
      laneKey: spec.laneKey || `${prd.id}:${spec.agentId}`,
      type: spec.type || TASK_TYPES.DEFAULT,
      source: spec.source || 'planned',
      sprintId: spec.sprintId || prd.sprintId || sprint.sprintId || 'shared',
      baseBranch: config.integrationBranch,
      checks: normalizeStringList(agent.checks || []),
      acceptance: normalizeStringList(spec.acceptance),
      state: 'queued',
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    if (!nextTask.prdId) {
      delete nextTask.prdId;
    }
    if (existingIndex >= 0) {
      baseQueue.tasks[existingIndex] = {
        ...baseQueue.tasks[existingIndex],
        ...nextTask,
      };
    } else {
      baseQueue.tasks.push(nextTask);
    }
    nextByAgent.set(agent.id, baseQueue);
  });

  return Array.from(nextByAgent.entries()).map(([agentId, queueState]) => {
    const agent = getAgent(config, agentId);
    const relativePath = agent.taskQueue;
    if (path.isAbsolute(relativePath)) {
      throw new Error(`Implementation queue for "${agentId}" must be repo-relative to commit it to ${config.integrationBranch}.`);
    }
    return {
      relativePath,
      content: buildTaskQueueState(agent, listTasks(queueState)),
    };
  });
}

function claimQueuedPrd(rootDir, config, agent) {
  const release = acquireStateLock(rootDir);
  try {
    const prds = loadPrds(rootDir, config);
    const prd = listPrds(prds)
      .filter((candidate) => candidate.status === 'queued')
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))[0];
    if (!prd) {
      return null;
    }
    const now = new Date().toISOString();
    commitTrackedPrdStateToIntegrationBranch(rootDir, config.integrationBranch, {
      prdId: prd.id,
      status: 'planning',
      createdAt: now,
      updatedAt: now,
    }, {
      commitMessage: `autonomy(prd-state): planning ${prd.id}`,
      gitIdentity: agent.gitIdentity,
    });
    prd.status = 'planning';
    prd.updatedAt = now;
    return JSON.parse(JSON.stringify(prd));
  } finally {
    release();
  }
}

function finalizePrd(rootDir, config, agent, prdId, patch) {
  const release = acquireStateLock(rootDir);
  try {
    const currentState = readTrackedPrdStateMap(rootDir, config.integrationBranch).get(prdId) || null;
    const now = new Date().toISOString();
    const rawError = patch.error || patch.lastError || '';
    commitTrackedPrdStateToIntegrationBranch(rootDir, config.integrationBranch, {
      prdId,
      status: patch.status || (currentState && currentState.status) || 'planned',
      plannedTaskIds: Array.isArray(patch.plannedTaskIds)
        ? patch.plannedTaskIds
        : (currentState && currentState.plannedTaskIds) || [],
      lastError: patch.status === 'failed'
        ? (typeof rawError === 'string' ? rawError : extractExecError(rawError))
        : '',
      createdAt: currentState && currentState.createdAt ? currentState.createdAt : now,
      updatedAt: now,
    }, {
      commitMessage: `autonomy(prd-state): ${patch.status || 'update'} ${prdId}`,
      gitIdentity: agent.gitIdentity,
    });
  } finally {
    release();
  }
}

function runPmWorker(rootDir, config, sprint, agent) {
  const prd = claimQueuedPrd(rootDir, config, agent);
  if (!prd) {
    return { ok: true, status: 'noop', reason: 'no_queued_prd' };
  }

  const plannedSpecs = useCodexStub()
    ? buildPmStubTaskSpecs(config, sprint, prd)
    : planPrdTasksWithCodex({ rootDir, agent, config, sprint, prd }).tasks;
  const sanitizedPlannedSpecs = sanitizePlannedTaskSpecs(plannedSpecs);
  if (!Array.isArray(sanitizedPlannedSpecs) || sanitizedPlannedSpecs.length === 0) {
    throw new Error(`PM planning produced no tasks for PRD "${prd.id}".`);
  }

  const createdTaskIds = [];
  try {
    commitPrdSpecToIntegrationBranch(rootDir, config.integrationBranch, {
      id: prd.id,
      title: prd.title,
      createdAt: prd.createdAt,
      specification: prd.specification,
      requirements: prd.requirements,
    }, {
      commitMessage: `autonomy(prd): persist plan ${prd.id}`,
      gitIdentity: agent.gitIdentity,
    });

    const queueUpdates = buildTrackedImplementationQueueUpdates(rootDir, config, sanitizedPlannedSpecs, {
      prd,
      sprint,
    });
    commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, queueUpdates, {
      commitMessage: `autonomy(queue): enqueue plan ${prd.id}`,
      gitIdentity: agent.gitIdentity,
    });
    createdTaskIds.push(...sanitizedPlannedSpecs.map((spec) => spec.id));
  } catch (error) {
    finalizePrd(rootDir, config, agent, prd.id, {
      status: 'failed',
      error: extractExecError(error),
    });
    appendAgentLog(rootDir, config, agent.id, 'prd:failed', {
      input: {
        prdId: prd.id,
        taskCount: Array.isArray(prd.plannedTaskIds) ? prd.plannedTaskIds.length : 0,
      },
      output: {
        createdTaskIds,
        status: 'failed',
      },
    });
    throw error;
  }

  finalizePrd(rootDir, config, agent, prd.id, {
    status: 'planned',
    plannedTaskIds: createdTaskIds,
  });
  appendAgentLog(rootDir, config, agent.id, 'prd:planned', {
    input: {
      prdId: prd.id,
      taskCount: sanitizedPlannedSpecs.length,
    },
    output: {
      plannedTaskIds: createdTaskIds,
      status: 'planned',
    },
  });

  return {
    ok: true,
    status: 'planned',
    prdId: prd.id,
    createdTaskIds,
  };
}

export {
  runPmWorker,
  sanitizePlannedTaskSpecs,
};
