import fs from 'fs';
import path from 'path';
import { countBy, ensureInitialized, getAutonomyPaths, readJson } from '../commands/shared-core.js';
import { buildAgentStatusSummaries } from '../commands/shared-agent-status.js';
import { buildPullRequestStatusSummaries } from '../commands/shared-pr-status.js';
import { gitRefExists, resolveBaseRef, runGitRead } from '../commands/shared-repo.js';
import { loadAllState, loadTrackedPrdHistory, loadTrackedPrds } from '../commands/shared-prds.js';
import { getTaskQueue, listTasks } from '../commands/shared-queues.js';
import { buildDeploymentVersionSnapshot, buildUnavailableDeploymentVersionSnapshot } from '../commands/deploy-version.js';
import { readAutonomyPackageStatus } from '../commands/update.js';
import { reconcilePullRequestRecord, reconcileReviewTaskRecord } from '../../sync/review-reconciliation.js';

function buildStatusSnapshot(rootDir) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const runtime = fs.existsSync(paths.runtimeState)
    ? readJson(paths.runtimeState)
    : { workers: {} };
  const { config, sprint, taskQueues: loadedTaskQueues, prs: loadedPrs, branchLocks } = loadAllState(rootDir);
  const taskQueues = reconcileTaskQueuesForStatus(loadedTaskQueues, loadedPrs);
  const prs = reconcilePullRequestsForStatus(loadedPrs, taskQueues);
  const prds = loadTrackedPrds(rootDir, config, {
    taskQueues,
    prs,
  });
  const prdHistory = loadTrackedPrdHistory(rootDir, config, {
    prds,
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
    deployment: buildDeploymentSnapshot(rootDir, config),
    autonomyPackage: readAutonomyPackageStatus(rootDir),
    runtime,
    prds,
    prdHistory,
  };
}

function reconcileTaskQueuesForStatus(taskQueues, prs) {
  const pullRequests = ((prs && prs.pullRequests) || []) as any[];
  const pullRequestsById = new Map<string, any>(
    pullRequests
      .filter((pr) => pr && pr.id)
      .map((pr) => [String(pr.id), pr])
  );
  const implementationTasks = listTasks(taskQueues).filter((task) => task && task.type !== 'review');
  const now = new Date().toISOString();
  return Object.fromEntries(Object.entries(taskQueues || {}).map(([agentId, queue]) => {
    const queueState = queue as any;
    if (!queueState || queueState.role !== 'review') {
      return [agentId, queueState];
    }
    return [agentId, {
      ...queueState,
      tasks: (queueState.tasks || []).map((task) => reconcileReviewTaskRecord(task, {
        pullRequestsById,
        implementationTasks,
        now,
      })),
    }];
  }));
}

function reconcilePullRequestsForStatus(prs, taskQueues) {
  const implementationTasks = listTasks(taskQueues).filter((task) => task && task.type !== 'review');
  const now = new Date().toISOString();
  return {
    ...(prs || {}),
    pullRequests: (((prs && prs.pullRequests) || []) as any[])
      .map((pr) => reconcilePullRequestRecord(pr, implementationTasks, now)),
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

function buildDeploymentSnapshot(rootDir, config) {
  const sourceBranch = String(config.integrationBranch || 'dev').trim() || 'dev';
  const targetBranch = String(config.productionBranch || 'main').trim() || 'main';

  if (sourceBranch === targetBranch) {
    return {
      sourceBranch,
      targetBranch,
      sourceAheadBy: 0,
      targetAheadBy: 0,
      branchesAligned: true,
      hasChanges: false,
      deployable: false,
      status: 'invalid',
      statusLabel: 'Invalid deploy branches',
      detail: `Deploy source and target branches must differ. Received ${sourceBranch}.`,
      sourceSha: null,
      targetSha: null,
      version: buildUnavailableDeploymentVersionSnapshot(rootDir),
    };
  }

  try {
    const sourceRef = gitRefExists(rootDir, sourceBranch) ? sourceBranch : resolveBaseRef(rootDir, sourceBranch);
    const targetRef = gitRefExists(rootDir, targetBranch) ? targetBranch : resolveBaseRef(rootDir, targetBranch);
    const counts = runGitRead(rootDir, ['rev-list', '--left-right', '--count', `${targetRef}...${sourceRef}`]).trim();
    const [targetAheadRaw, sourceAheadRaw] = counts.split(/\s+/);
    const targetAheadBy = Number(targetAheadRaw || 0);
    const sourceAheadBy = Number(sourceAheadRaw || 0);
    const sourceSha = runGitRead(rootDir, ['rev-parse', sourceRef]).trim() || null;
    const targetSha = runGitRead(rootDir, ['rev-parse', targetRef]).trim() || null;
    const version = buildDeploymentVersionSnapshot(rootDir, sourceRef, targetRef);
    const branchesAligned = targetAheadBy === 0 && sourceAheadBy === 0;
    const hasChanges = !branchesAligned;
    const deployable = hasChanges;

    let status = 'aligned';
    let statusLabel = 'Ready';
    let detail = `${sourceBranch} and ${targetBranch} are aligned.`;
    if (hasChanges) {
      status = sourceAheadBy > 0 ? 'pending' : 'diverged';
      statusLabel = sourceAheadBy > 0 ? 'Deploy available' : 'Branches differ';
      const parts = [];
      if (sourceAheadBy > 0) {
        parts.push(`${sourceBranch} is ${sourceAheadBy} commit${sourceAheadBy === 1 ? '' : 's'} ahead of ${targetBranch}`);
      }
      if (targetAheadBy > 0) {
        parts.push(`${targetBranch} is ${targetAheadBy} commit${targetAheadBy === 1 ? '' : 's'} ahead of ${sourceBranch}`);
      }
      detail = parts.join(' | ');
    }

    return {
      sourceBranch,
      targetBranch,
      sourceAheadBy,
      targetAheadBy,
      branchesAligned,
      hasChanges,
      deployable,
      status,
      statusLabel,
      detail,
      sourceSha,
      targetSha,
      version,
    };
  } catch (error) {
    return {
      sourceBranch,
      targetBranch,
      sourceAheadBy: 0,
      targetAheadBy: 0,
      branchesAligned: false,
      hasChanges: false,
      deployable: false,
      status: 'unknown',
      statusLabel: 'Deploy status unavailable',
      detail: error instanceof Error ? error.message : String(error),
      sourceSha: null,
      targetSha: null,
      version: buildUnavailableDeploymentVersionSnapshot(rootDir),
    };
  }
}

export {
  buildRuntimeSnapshot,
  buildStatusSnapshot,
};
