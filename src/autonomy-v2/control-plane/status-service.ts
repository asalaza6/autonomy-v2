import fs from 'fs';
import path from 'path';
import { countBy, ensureInitialized, getAutonomyPaths, readJson } from '../commands/shared-core.js';
import { buildAgentStatusSummaries } from '../commands/shared-agent-status.js';
import { buildPullRequestStatusSummaries } from '../commands/shared-pr-status.js';
import { loadAllState, loadTrackedPrds } from '../commands/shared-prds.js';
import { getTaskQueue, listTasks } from '../commands/shared-queues.js';

function buildStatusSnapshot(rootDir) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const runtime = fs.existsSync(paths.runtimeState)
    ? readJson(paths.runtimeState)
    : { workers: {} };
  const { config, sprint, taskQueues, prs, branchLocks } = loadAllState(rootDir);
  const prds = loadTrackedPrds(rootDir, config, {
    taskQueues,
    prs,
  });
  const taskCounts = countBy(listTasks(taskQueues), 'status');
  const prCounts = countBy(prs.pullRequests, 'status');
  const queues = (config.agents || []).map((agent) => {
    const queue = getTaskQueue(taskQueues, config, agent.id);
    return {
      agentId: queue.agentId,
      role: queue.role,
      taskCount: queue.tasks.length,
      statuses: countBy(queue.tasks, 'status'),
    };
  });
  const agentStatuses = buildAgentStatusSummaries({
    rootDir,
    config,
    taskQueues,
    prs,
    branchLocks,
    runtime,
    prds,
  });
  const pullRequestStatuses = buildPullRequestStatusSummaries({
    taskQueues,
    prs,
    runtime,
    branchLocks,
  });

  return {
    configPath: pathRelative(rootDir, paths.agentsConfig),
    sprintPath: pathRelative(rootDir, paths.sprintConfig),
    configSchemaVersion: typeof config.schemaVersion === 'undefined' ? null : config.schemaVersion,
    integrationBranch: config.integrationBranch,
    productionBranch: config.productionBranch,
    blockedBranches: config.blockedBranches || [],
    sprint,
    agents: config.agents || [],
    agentStatuses,
    queues,
    taskCounts,
    prCounts,
    pullRequestStatuses,
    branchLockCount: branchLocks.locks.length,
    runtime,
    prds,
  };
}

function buildRuntimeSnapshot(rootDir) {
  const snapshot = buildStatusSnapshot(rootDir);
  return {
    workers: snapshot.runtime.workers || {},
    agentStatuses: snapshot.agentStatuses,
    pullRequestStatuses: snapshot.pullRequestStatuses,
    prdCounts: countBy(snapshot.prds.prds || [], 'status'),
  };
}

function pathRelative(rootDir, targetPath) {
  return path.relative(rootDir, targetPath);
}

export {
  buildRuntimeSnapshot,
  buildStatusSnapshot,
};
