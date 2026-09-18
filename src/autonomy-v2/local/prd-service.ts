import fs from 'fs';
import path from 'path';
import {
  appendAgentLog,
  ensureInitialized,
  getAgent,
  getAutonomyPaths,
  getListOption,
  getStringOption,
  readJson,
  requireOption,
  writeJson,
} from '../commands/shared-core.js';
import {
  buildTrackedImplementationQueueUpdates,
  sanitizePlannedTaskSpecs,
} from '../commands/shared-queues.js';
import { loadAllState, loadTrackedPrds } from '../commands/shared-prds.js';
import {
  buildPrdSpecPayload,
  commitPrdSpecToIntegrationBranch,
  commitTrackedFilesToIntegrationBranch,
  getRoleLabel,
  hasActivePrdSpecInIntegrationBranch,
  hasPrdSpecInIntegrationBranch,
  validateAutonomyConfig,
  AGENT_ROLES,
} from '../commands/command-dependencies.js';
import { isImplementationRole, usesTrackedQueueForRole } from '../../agents/role-catalog.js';
import { buildPrdSpecRelativePath, buildPrdStateRelativePath } from '../../sync/sync-prd.js';
import { listTrackedPrdSpecs } from '../../sync/sync-git.js';
import { selectActivePrd } from './status-view.js';

function executePrdAdd(rootDir, options = {}) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const config = readJson(paths.agentsConfig);
  const id = requireOption(options, 'id');
  const title = requireOption(options, 'title');
  const trackedPrds = loadTrackedPrds(rootDir, config, {
    prs: readJson(paths.prsState),
  });
  const hasActivePrd = (trackedPrds.prds || []).some((prd) => ['planning', 'planned', 'queued'].includes(
    String((prd && prd.status) || '')
  ));
  const hasActiveIntegrationPrdSpec = hasActivePrdSpecInIntegrationBranch(rootDir, config.integrationBranch);
  const hasExistingPrdSpec = hasPrdSpecInIntegrationBranch(rootDir, config.integrationBranch, id);

  const now = new Date().toISOString();
  const specification = getStringOption(options, 'specification', '');
  const requirements = getListOption(options, 'requirement');
  const priority = getStringOption(options, 'priority', '');
  const rawTaskSpecs = Object.prototype.hasOwnProperty.call(options, 'task-spec')
    ? (Array.isArray(options['task-spec']) ? options['task-spec'] : [options['task-spec']])
    : [];
  const taskSpecs = rawTaskSpecs.map((entry, index) => {
    try {
      const parsed = JSON.parse(String(entry));
      if (!parsed.id || !parsed.title || !parsed.agentId) {
        throw new Error('task-spec must include id, title, and agentId');
      }
      return parsed;
    } catch (error) {
      throw new Error(`Invalid --task-spec at index ${index}: ${error.message}`);
    }
  });
  if (taskSpecs.length === 0 && !specification && requirements.length === 0) {
    throw new Error('Provide at least one --task-spec or a --specification/--requirement input for PM planning.');
  }
  if (taskSpecs.length > 0 && (hasActivePrd || hasActiveIntegrationPrdSpec || hasExistingPrdSpec)) {
    throw new Error(`Cannot enqueue ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} task specs while the PRD spec would be queued instead of active on the integration branch.`);
  }

  const prdSpec = buildPrdSpecPayload({
    id,
    title,
    createdAt: now,
    specification,
    requirements,
    priority,
  });
  const pmAgent = getAgent(config, `${AGENT_ROLES.PM}-agent`);
  const commitResult = commitPrdSpecToIntegrationBranch(rootDir, config.integrationBranch, prdSpec, {
    commitMessage: `autonomy(prd): upsert ${id}`,
    gitIdentity: pmAgent.gitIdentity,
    queueSpec: hasActivePrd || hasActiveIntegrationPrdSpec || hasExistingPrdSpec,
  });
  let queueCommitResult = null;
  if (taskSpecs.length > 0) {
    queueCommitResult = commitTrackedFilesToIntegrationBranch(
      rootDir,
      config.integrationBranch,
      buildTrackedImplementationQueueUpdates(
        rootDir,
        config,
        sanitizePlannedTaskSpecs(taskSpecs),
        {
          prd: {
            id,
            title,
            createdAt: now,
            sprintId: getStringOption(options, 'sprint-id', ''),
          },
          sprint: readJson(paths.sprintConfig),
          source: 'manual',
        }
      ),
      {
        commitMessage: `autonomy(queue): enqueue ${id}`,
        gitIdentity: pmAgent.gitIdentity,
      }
    );
  }
  appendAgentLog(rootDir, config, pmAgent.id, 'prd:committed', {
    input: {
      prdId: id,
      taskCount: taskSpecs.length,
      integrationBranch: config.integrationBranch,
    },
    output: {
      committed: commitResult.committed,
      pushed: commitResult.pushed,
      commitSha: commitResult.commitSha,
      specPath: commitResult.specPath,
      queueCommitSha: queueCommitResult ? queueCommitResult.commitSha : null,
      queuePaths: queueCommitResult ? queueCommitResult.paths : [],
      pushMessage: commitResult.pushMessage || null,
    },
  });

  return {
    prdSpec,
    integrationBranch: config.integrationBranch,
    commit: commitResult,
    queueCommit: queueCommitResult,
    taskSpecs,
  };
}

function buildPrdAddCliOptions(payload) {
  const options: Record<string, any> = {
    id: payload.id,
    title: payload.title,
  };
  if (payload.specification) {
    options.specification = payload.specification;
  }
  if (Array.isArray(payload.requirements) && payload.requirements.length > 0) {
    options.requirement = payload.requirements;
  }
  if (Array.isArray(payload.taskSpecs) && payload.taskSpecs.length > 0) {
    options['task-spec'] = payload.taskSpecs.map((taskSpec) => JSON.stringify(taskSpec));
  }
  if (payload.sprintId) {
    options['sprint-id'] = payload.sprintId;
  }
  if (payload.priority) {
    options.priority = payload.priority;
  }
  return options;
}

function executePrdReset(rootDir, options = {}) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const config = readJson(paths.agentsConfig);
  const now = new Date().toISOString();
  const confirmPrdId = requireOption(options, 'confirm-prd-id');
  const reason = getStringOption(options, 'reason', '').trim();
  const state = loadAllState(rootDir);
  const trackedPrds = loadTrackedPrds(rootDir, state.config, {
    taskQueues: state.taskQueues,
    prs: state.prs,
  });
  const activePrd = selectActivePrd(trackedPrds.prds || []);
  const specEntries = listTrackedPrdSpecs(rootDir, config.integrationBranch);
  const queuedSpecEntry = specEntries.find((entry) => entry.spec && entry.spec.id === confirmPrdId && entry.isQueued === true) || null;

  if (!activePrd) {
    if (queuedSpecEntry) {
      return executeQueuedPrdReset(rootDir, {
        config,
        confirmPrdId,
        reason,
        specEntry: queuedSpecEntry,
        now,
      });
    }
    return {
      noop: true,
      message: 'No active PRD exists to reset.',
      resetAt: now,
      prdId: null,
      commitSha: null,
    };
  }
  if (confirmPrdId !== activePrd.id) {
    if (queuedSpecEntry) {
      return executeQueuedPrdReset(rootDir, {
        config,
        confirmPrdId,
        reason,
        specEntry: queuedSpecEntry,
        now,
      });
    }
    throw new Error(`Confirmation must match the active PRD id "${activePrd.id}".`);
  }

  const activeSpecEntry = specEntries.find((entry) => entry.spec && entry.spec.id === activePrd.id && entry.isQueued !== true) || null;
  if (!activeSpecEntry) {
    throw new Error(`Could not locate the active PRD spec for "${activePrd.id}" on ${config.integrationBranch}.`);
  }

  const removedTaskIds = new Set<string>();
  const removedReviewTaskIds = new Set<string>();
  const activePrIds = new Set<string>(
    ((state.prs && state.prs.pullRequests) || [])
      .filter((pr) => String(pr && pr.prdId || '').trim() === activePrd.id)
      .map((pr) => String(pr && pr.id || '').trim())
      .filter(Boolean)
  );
  const activeLaneKeys = new Set<string>();
  const queueFileUpdates: Array<Record<string, unknown>> = [];
  const nextQueues = new Map<string, unknown[]>();

  (state.config.agents || [])
    .filter((agent) => usesTrackedQueueForRole(agent.role) && isImplementationRole(agent.role))
    .forEach((agent) => {
      const queue = state.taskQueues[agent.id];
      const originalTasks = queue && Array.isArray(queue.tasks) ? queue.tasks : [];
      const filteredTasks = originalTasks.filter((task) => {
        const prdId = String(task && task.prdId || '').trim();
        const laneKey = String(task && task.laneKey || '').trim();
        const shouldRemove = prdId === activePrd.id;
        if (shouldRemove) {
          if (laneKey) {
            activeLaneKeys.add(laneKey);
          }
          if (task && task.id) {
            removedTaskIds.add(String(task.id));
          }
        }
        return !shouldRemove;
      });
      if (filteredTasks.length !== originalTasks.length) {
        nextQueues.set(agent.id, filteredTasks);
      }
    });

  (state.config.agents || [])
    .filter((agent) => usesTrackedQueueForRole(agent.role) && !isImplementationRole(agent.role))
    .forEach((agent) => {
      const queue = state.taskQueues[agent.id];
      const originalTasks = queue && Array.isArray(queue.tasks) ? queue.tasks : [];
      const filteredTasks = originalTasks.filter((task) => {
        const prdId = String(task && task.prdId || '').trim();
        const laneKey = String(task && task.laneKey || '').trim();
        const sourceTaskId = String(task && task.sourceTaskId || '').trim();
        const prId = String(task && task.prId || '').trim();
        const shouldRemove = prdId === activePrd.id
          || (sourceTaskId && removedTaskIds.has(sourceTaskId))
          || (prId && activePrIds.has(prId));
        if (shouldRemove) {
          if (laneKey) {
            activeLaneKeys.add(laneKey);
          }
          if (task && task.id) {
            removedReviewTaskIds.add(String(task.id));
          }
        }
        return !shouldRemove;
      });
      if (filteredTasks.length !== originalTasks.length) {
        nextQueues.set(agent.id, filteredTasks);
      }
    });

  (state.config.agents || []).forEach((agent) => {
    if (!nextQueues.has(agent.id)) {
      return;
    }
    queueFileUpdates.push({
      relativePath: agent.taskQueue,
      content: {
        ...(isImplementationRole(agent.role) ? { schemaVersion: 1 } : {}),
        agentId: agent.id,
        role: agent.role,
        tasks: nextQueues.get(agent.id),
      },
    });
  });

  const archivedSpecPath = path.posix.join(
    path.posix.dirname(buildPrdSpecRelativePath(activePrd.id)),
    'archived',
    path.posix.basename(activeSpecEntry.relativePath)
  );
  const trackedUpdates = [
    {
      relativePath: archivedSpecPath,
      content: buildPrdSpecPayload({
        ...activeSpecEntry.spec,
        archive: {
          kind: 'reset',
          status: 'abandoned',
          archivedAt: now,
          reason: reason || undefined,
          fromStatus: String(activePrd.status || '').trim() || undefined,
          actor: 'manager',
        },
      }),
    },
    {
      relativePath: activeSpecEntry.relativePath,
      delete: true,
    },
    {
      relativePath: buildPrdStateRelativePath(activePrd.id),
      delete: true,
    },
    ...specEntries
      .filter((entry) => entry.spec && entry.spec.id === activePrd.id && entry.isQueued === true)
      .map((entry) => ({
        relativePath: entry.relativePath,
        delete: true,
      })),
    ...queueFileUpdates,
  ];

  const pmAgent = getAgent(config, `${AGENT_ROLES.PM}-agent`);
  const commitResult = commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, trackedUpdates, {
    commitMessage: `autonomy(prd): reset ${activePrd.id}`,
    gitIdentity: pmAgent.gitIdentity,
  });
  applyLocalQueueUpdates(rootDir, queueFileUpdates);
  fs.rmSync(path.join(rootDir, buildPrdStateRelativePath(activePrd.id)), { force: true });

  const remainingPullRequests = ((state.prs && state.prs.pullRequests) || []).filter(
    (pr) => String(pr && pr.prdId || '').trim() !== activePrd.id
  );
  if (remainingPullRequests.length !== ((state.prs && state.prs.pullRequests) || []).length) {
    writeJson(paths.prsState, {
      ...(state.prs || {}),
      pullRequests: remainingPullRequests,
    });
  }

  const nextBranchLocks = {
    ...(state.branchLocks || { locks: [] }),
    locks: ((state.branchLocks && state.branchLocks.locks) || []).filter((lock) => {
      const prdId = String(lock && lock.prdId || '').trim();
      const laneKey = String(lock && lock.laneKey || '').trim();
      const taskId = String(lock && lock.taskId || '').trim();
      return prdId !== activePrd.id
        && (!laneKey || !activeLaneKeys.has(laneKey))
        && (!taskId || !removedTaskIds.has(taskId));
    }),
  };
  writeJson(paths.branchLocksState, nextBranchLocks);

  const runtimeState = fs.existsSync(paths.runtimeState)
    ? readJson(paths.runtimeState)
    : { workers: {} };
  const affectedAgentIds = new Set<string>([
    ...Array.from(removedTaskIds).map((taskId) => {
      const task = findTaskById(state.taskQueues, taskId);
      return String(task && task.agentId || '').trim();
    }),
    ...Array.from(removedReviewTaskIds).map((taskId) => {
      const task = findTaskById(state.taskQueues, taskId);
      return String(task && task.agentId || '').trim();
    }),
    ...Array.from(((state.branchLocks && state.branchLocks.locks) || [])
      .filter((lock) => String(lock && lock.prdId || '').trim() === activePrd.id)
      .map((lock) => String(lock && lock.agentId || '').trim())),
  ].filter(Boolean));
  const detachedWorkers = [];
  const workers = { ...((runtimeState && runtimeState.workers) || {}) };
  affectedAgentIds.forEach((agentId) => {
    const currentWorker = workers[agentId];
    const pid = Number(currentWorker && currentWorker.pid);
    const terminated = Number.isInteger(pid) && pid > 0 ? terminateWorker(pid) : false;
    detachedWorkers.push({
      agentId,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      terminated,
    });
    workers[agentId] = {
      agentId,
      status: 'idle',
      pid: null,
      finishedAt: now,
      reason: 'prd-reset',
      lastResult: null,
      lastError: null,
    };
  });
  writeJson(paths.runtimeState, {
    ...(runtimeState || {}),
    workers,
    ...(runtimeState && runtimeState.lastPrdPromotion && String(runtimeState.lastPrdPromotion.id || '').trim() === activePrd.id
      ? { lastPrdPromotion: null }
      : {}),
  });

  appendAgentLog(rootDir, config, pmAgent.id, 'prd:reset', {
    input: {
      prdId: activePrd.id,
      reason: reason || null,
      integrationBranch: config.integrationBranch,
    },
    output: {
      commitSha: commitResult.commitSha,
      archivedSpecPath,
      removedTaskIds: Array.from(removedTaskIds),
      removedReviewTaskIds: Array.from(removedReviewTaskIds),
      removedPullRequestIds: Array.from(activePrIds),
      detachedWorkers,
    },
  });

  return {
    noop: false,
    prdId: activePrd.id,
    title: activePrd.title,
    reason: reason || null,
    resetAt: now,
    archivedPath: archivedSpecPath,
    commitSha: commitResult.commitSha || null,
    pushMessage: commitResult.pushMessage || null,
    clearedTaskCount: removedTaskIds.size + removedReviewTaskIds.size,
    clearedPullRequestCount: activePrIds.size,
    detachedWorkers,
  };
}

function executeQueuedPrdReset(rootDir, options) {
  const { config, confirmPrdId, reason, specEntry, now } = options;
  const archivedSpecPath = path.posix.join(
    path.posix.dirname(buildPrdSpecRelativePath(confirmPrdId)),
    'archived',
    path.posix.basename(specEntry.relativePath)
  );
  const pmAgent = getAgent(config, `${AGENT_ROLES.PM}-agent`);
  const commitResult = commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, [
    {
      relativePath: archivedSpecPath,
      content: buildPrdSpecPayload({
        ...specEntry.spec,
        archive: {
          kind: 'reset',
          status: 'abandoned',
          archivedAt: now,
          reason: reason || undefined,
          fromStatus: 'queued',
          actor: 'manager',
        },
      }),
    },
    {
      relativePath: specEntry.relativePath,
      delete: true,
    },
  ], {
    commitMessage: `autonomy(prd): reset queued ${confirmPrdId}`,
    gitIdentity: pmAgent.gitIdentity,
  });

  appendAgentLog(rootDir, config, pmAgent.id, 'prd:reset:queued', {
    input: {
      prdId: confirmPrdId,
      reason: reason || null,
      integrationBranch: config.integrationBranch,
      queuedPath: specEntry.relativePath,
    },
    output: {
      commitSha: commitResult.commitSha,
      archivedSpecPath,
    },
  });

  return {
    noop: false,
    prdId: confirmPrdId,
    title: specEntry.spec.title,
    reason: reason || null,
    resetAt: now,
    archivedPath: archivedSpecPath,
    commitSha: commitResult.commitSha || null,
    pushMessage: commitResult.pushMessage || null,
    clearedTaskCount: 0,
    clearedPullRequestCount: 0,
    detachedWorkers: [],
    queued: true,
  };
}

function executePrdPriorityUpdate(rootDir, options = {}) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const config = readJson(paths.agentsConfig);
  const now = new Date().toISOString();
  const prdId = requireOption(options, 'prd-id');
  const priority = requireOption(options, 'priority');
  const reason = getStringOption(options, 'reason', '').trim();
  const specEntries = listTrackedPrdSpecs(rootDir, config.integrationBranch);
  const queuedSpecEntry = specEntries.find((entry) => entry.spec && entry.spec.id === prdId && entry.isQueued === true) || null;
  if (!queuedSpecEntry) {
    throw new Error(`Could not locate queued PRD "${prdId}" on ${config.integrationBranch}.`);
  }

  const previousPriority = String(queuedSpecEntry.spec.priority || '').trim();
  const nextSpec = buildPrdSpecPayload({
    ...queuedSpecEntry.spec,
    priority,
  });
  const pmAgent = getAgent(config, `${AGENT_ROLES.PM}-agent`);
  const commitResult = commitTrackedFilesToIntegrationBranch(rootDir, config.integrationBranch, [
    {
      relativePath: queuedSpecEntry.relativePath,
      content: nextSpec,
    },
  ], {
    commitMessage: `autonomy(prd): reprioritize ${prdId}`,
    gitIdentity: pmAgent.gitIdentity,
  });

  appendAgentLog(rootDir, config, pmAgent.id, 'prd:priority', {
    input: {
      prdId,
      previousPriority: previousPriority || null,
      priority,
      reason: reason || null,
      integrationBranch: config.integrationBranch,
      queuedPath: queuedSpecEntry.relativePath,
    },
    output: {
      commitSha: commitResult.commitSha,
      pushed: commitResult.pushed,
      pushMessage: commitResult.pushMessage || null,
    },
  });

  return {
    prdId,
    title: queuedSpecEntry.spec.title,
    previousPriority: previousPriority || null,
    priority,
    reason: reason || null,
    updatedAt: now,
    queuedPath: queuedSpecEntry.relativePath,
    commitSha: commitResult.commitSha || null,
    pushMessage: commitResult.pushMessage || null,
  };
}

function applyLocalQueueUpdates(rootDir, queueFileUpdates) {
  (queueFileUpdates || []).forEach((entry) => {
    const relativePath = String(entry && entry.relativePath || '').trim();
    if (!relativePath || !Object.prototype.hasOwnProperty.call(entry || {}, 'content')) {
      return;
    }
    writeJson(path.join(rootDir, relativePath), entry.content);
  });
}

function findTaskById(taskQueues, taskId) {
  for (const queue of Object.values(taskQueues || {}) as any[]) {
    const task = (queue && Array.isArray(queue.tasks) ? queue.tasks : []).find((candidate: any) => String(candidate && candidate.id || '') === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

function terminateWorker(pid) {
  try {
    process.kill(pid, 'SIGTERM');
    return true;
  } catch (_) {
    return false;
  }
}

function loadValidatedAutonomyConfig(rootDir) {
  const paths = getAutonomyPaths(rootDir);
  return validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
}

export {
  buildPrdAddCliOptions,
  executePrdAdd,
  executePrdPriorityUpdate,
  executePrdReset,
  loadValidatedAutonomyConfig,
};
