import fs from 'fs';
import path from 'path';
import { countBy, ensureInitialized, getAutonomyPaths, readJson } from '../commands/shared-core.js';
import { buildAgentStatusSummaries } from '../commands/shared-agent-status.js';
import { buildPullRequestStatusSummaries } from '../commands/shared-pr-status.js';
import { gitRefExists, resolveBaseRef, runGitRead } from '../commands/shared-repo.js';
import { loadAllState, loadTrackedPrdHistory, loadTrackedPrds } from '../commands/shared-prds.js';
import { getTaskQueue, isTerminalTaskStatus, listTasks } from '../commands/shared-queues.js';
import { buildDeploymentVersionSnapshot, buildUnavailableDeploymentVersionSnapshot } from '../commands/deploy-version.js';
import { readAutonomyPackageStatus } from '../commands/update.js';
import { reconcilePullRequestRecord, reconcileReviewTaskRecord } from '../../sync/review-reconciliation.js';
import { resolveRepoAssistantGithubCapabilityStatus } from '../../server/control-plane/control-plane-github.js';
import { loadControlPlaneConfig, readControlPlaneConfig } from '../../server/control-plane/control-plane-config.js';
import { getManagedProcesses } from '../../server/control-plane/control-plane-store.js';
import { listConfiguredCustomAgents } from '../../server/orchestrator/custom-agents.js';

function buildStatusSnapshot(rootDir) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const runtime = fs.existsSync(paths.runtimeState)
    ? readJson(paths.runtimeState)
    : { workers: {} };
  const { config, sprint, taskQueues: loadedTaskQueues, prs: loadedPrs, branchLocks } = loadAllState(rootDir);
  const customLifecycle = loadCustomLifecycleStatusState(rootDir);
  const rawTaskQueues = mergeCustomLifecycleTaskQueues(loadedTaskQueues, customLifecycle.taskQueues);
  const rawPrs = mergeCustomLifecyclePullRequests(loadedPrs, customLifecycle.prs);
  const taskQueues = reconcileTaskQueuesForStatus(rawTaskQueues, rawPrs);
  const prs = reconcilePullRequestsForStatus(rawPrs, taskQueues);
  const prds = applyCustomLifecyclePrdProjection(loadTrackedPrds(rootDir, config, {
    taskQueues,
    prs,
  }), customLifecycle);
  const prdHistory = loadTrackedPrdHistory(rootDir, config, {
    prds,
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
  const customAgents = listConfiguredCustomAgents(rootDir, runtime);
  const controlPlaneConfig = readControlPlaneConfig(rootDir);
  const repoAssistant = {
    github: resolveRepoAssistantGithubCapabilityStatus(rootDir, {
      configuredValidationPullNumber: controlPlaneConfig && typeof controlPlaneConfig.repoAssistantValidationPullRequest === 'number'
        ? controlPlaneConfig.repoAssistantValidationPullRequest
        : null,
    }),
  };
  const managedProcesses = buildManagedProcessSnapshot(rootDir);

  return {
    rootDir,
    configPath: pathRelative(rootDir, paths.agentsConfig),
    sprintPath: pathRelative(rootDir, paths.sprintConfig),
    configSchemaVersion: typeof config.schemaVersion === 'undefined' ? null : config.schemaVersion,
    integrationBranch: config.integrationBranch,
    productionBranch: config.productionBranch,
    blockedBranches: config.blockedBranches || [],
    sprint,
    agents: config.agents || [],
    customAgents,
    agentStatuses,
    queues,
    taskCounts,
    prCounts,
    pullRequestStatuses,
    branchLockCount: branchLocks.locks.length,
    deployment: buildDeploymentSnapshot(rootDir, config),
    autonomyPackage: readAutonomyPackageStatus(rootDir),
    repoAssistant,
    controlPlane: {
      managedProcesses,
    },
    runtime,
    prds,
    prdHistory,
  };
}

function loadCustomLifecycleStatusState(rootDir) {
  const lifecycleDir = path.join(rootDir, '.autonomy', 'runtime', 'custom-lifecycle');
  const queuesDir = path.join(lifecycleDir, 'queues');
  const prdStateDir = path.join(lifecycleDir, 'prd-state');
  const prsPath = path.join(lifecycleDir, 'state', 'prs.json');
  const taskQueues = {};
  const prdStateById = new Map();

  if (fs.existsSync(queuesDir)) {
    for (const entry of fs.readdirSync(queuesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const queue = readJsonIfPresent(path.join(queuesDir, entry.name));
      if (!queue || !Array.isArray(queue.tasks)) {
        continue;
      }
      const agentId = String(queue.agentId || path.basename(entry.name, '.json')).trim();
      if (!agentId) {
        continue;
      }
      taskQueues[agentId] = {
        schemaVersion: queue.schemaVersion || 1,
        agentId,
        role: queue.role || inferCustomQueueRole(agentId),
        tasks: queue.tasks.map((task) => normalizeCustomLifecycleTask(task, agentId)),
      };
    }
  }

  if (fs.existsSync(prdStateDir)) {
    for (const entry of fs.readdirSync(prdStateDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const state = readJsonIfPresent(path.join(prdStateDir, entry.name));
      const prdId = String(state && (state.prdId || state.id) || path.basename(entry.name, '.json')).trim();
      if (prdId) {
        prdStateById.set(prdId, state || {});
      }
    }
  }

  const prs = normalizeCustomLifecyclePrs(readJsonIfPresent(prsPath));
  return {
    taskQueues,
    prdStateById,
    prs,
  };
}

function readJsonIfPresent(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function inferCustomQueueRole(agentId) {
  return String(agentId || '').includes('review') ? 'review' : 'implementation';
}

function normalizeCustomLifecycleTask(task, agentId) {
  return {
    ...(task || {}),
    agentId: String(task && task.agentId || agentId || '').trim(),
    status: String(task && (task.status || task.state) || 'pending').trim() || 'pending',
  };
}

function normalizeCustomLifecyclePrs(prsState) {
  const pullRequests = Array.isArray(prsState && prsState.pullRequests)
    ? prsState.pullRequests
    : [];
  return {
    ...(prsState || {}),
    pullRequests: pullRequests.map((pr) => {
      const remoteUrl = String(pr && (pr.remoteUrl || pr.url || pr.html_url) || '').trim();
      const remote = {
        ...((pr && pr.remote) || {}),
        ...(remoteUrl && !(pr && pr.remote && pr.remote.url) ? { url: remoteUrl } : {}),
      };
      return {
        ...(pr || {}),
        remote,
      };
    }),
  };
}

function mergeCustomLifecycleTaskQueues(taskQueues, customTaskQueues) {
  const merged = { ...(taskQueues || {}) };
  Object.entries(customTaskQueues || {}).forEach(([agentId, queue]) => {
    merged[agentId] = queue;
  });
  return merged;
}

function mergeCustomLifecyclePullRequests(prs, customPrs) {
  const byId = new Map();
  (((prs && prs.pullRequests) || []) as any[]).forEach((pr) => {
    if (pr && pr.id) {
      byId.set(String(pr.id), pr);
    }
  });
  (((customPrs && customPrs.pullRequests) || []) as any[]).forEach((pr) => {
    if (pr && pr.id) {
      byId.set(String(pr.id), pr);
    }
  });
  return {
    ...(prs || {}),
    pullRequests: Array.from(byId.values()),
  };
}

function applyCustomLifecyclePrdProjection(prds, customLifecycle) {
  const tasksByPrdId = new Map();
  Object.values(customLifecycle.taskQueues || {}).forEach((queue: any) => {
    ((queue && queue.tasks) || []).forEach((task) => {
      const prdId = String(task && task.prdId || '').trim();
      if (!prdId) {
        return;
      }
      const tasks = tasksByPrdId.get(prdId) || [];
      tasks.push(task);
      tasksByPrdId.set(prdId, tasks);
    });
  });

  return {
    ...(prds || {}),
    prds: ((prds && prds.prds) || []).map((prd) => {
      const prdId = String(prd && prd.id || '').trim();
      const customState = customLifecycle.prdStateById.get(prdId) || null;
      const customTasks = tasksByPrdId.get(prdId) || [];
      if (!customState && customTasks.length === 0) {
        return prd;
      }

      const plannedTaskIds = normalizeStringList(
        customState && Array.isArray(customState.plannedTaskIds) && customState.plannedTaskIds.length > 0
          ? customState.plannedTaskIds
          : customTasks.map((task) => task.id)
      );
      const completedTaskSpecIds = plannedTaskIds.filter((taskId) => {
        const task = customTasks.find((candidate) => String(candidate && candidate.id || '') === taskId);
        return isTerminalTaskStatus(String(task && (task.status || task.state) || ''));
      });
      const hasOpenTask = customTasks.some((task) => !isTerminalTaskStatus(String(task && (task.status || task.state) || '')));
      const stateStatus = String(customState && customState.status || '').trim();
      const status = resolveCustomLifecyclePrdStatus(prd, {
        stateStatus,
        plannedTaskIds,
        completedTaskSpecIds,
        hasOpenTask,
      });

      return {
        ...prd,
        status,
        statusSource: stateStatus ? 'custom-lifecycle' : prd.statusSource,
        statusReason: describeCustomLifecyclePrdStatus(status, stateStatus, plannedTaskIds, completedTaskSpecIds, hasOpenTask),
        plannedTaskIds: plannedTaskIds.length > 0 ? plannedTaskIds : prd.plannedTaskIds,
        completedTaskSpecIds: completedTaskSpecIds.length > 0 ? completedTaskSpecIds : prd.completedTaskSpecIds,
        tasks: customTasks.length > 0 ? customTasks : prd.tasks,
        updatedAt: String(
          customState && (customState.updatedAt || customState.archivedAt || customState.plannedAt)
          || customTasks.map((task) => task && task.updatedAt).filter(Boolean).sort().pop()
          || prd.updatedAt
          || prd.createdAt
          || ''
        ),
      };
    }),
  };
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean)));
}

function resolveCustomLifecyclePrdStatus(prd, { stateStatus, plannedTaskIds, completedTaskSpecIds, hasOpenTask }) {
  if (stateStatus === 'archived' || stateStatus === 'completed') {
    return 'completed';
  }
  if (stateStatus === 'planning' || stateStatus === 'failed') {
    return stateStatus;
  }
  if (plannedTaskIds.length > 0 && completedTaskSpecIds.length >= plannedTaskIds.length && !hasOpenTask) {
    return 'completed';
  }
  if (stateStatus === 'planned' || plannedTaskIds.length > 0) {
    return 'planned';
  }
  return String(prd && prd.status || 'queued');
}

function describeCustomLifecyclePrdStatus(status, stateStatus, plannedTaskIds, completedTaskSpecIds, hasOpenTask) {
  if (stateStatus === 'archived') {
    return 'custom lifecycle runtime marks this PRD archived';
  }
  if (status === 'completed') {
    return 'custom lifecycle runtime shows all planned tasks complete';
  }
  if (status === 'planned' && hasOpenTask) {
    return `custom lifecycle runtime shows ${completedTaskSpecIds.length}/${plannedTaskIds.length} planned tasks complete`;
  }
  if (status === 'planned') {
    return 'custom lifecycle runtime marks this PRD planned';
  }
  return 'custom lifecycle runtime state projected into control plane';
}

function buildManagedProcessSnapshot(rootDir) {
  const repoId = String(loadControlPlaneConfig(rootDir)?.repoId || '').trim();
  const managedProcesses = getManagedProcesses(rootDir, repoId) || {};
  return Object.fromEntries(Object.entries(managedProcesses).map(([target, process]) => {
    const pid = normalizeManagedPid(process && (process.pid ?? process.postRestartPid));
    const running = pid ? isProcessAlive(pid) : false;
    return [target, {
      ...process,
      pid,
      postRestartPid: normalizeManagedPid(process && process.postRestartPid) ?? pid,
      preRestartPid: normalizeManagedPid(process && process.preRestartPid),
      running,
      updatedAt: String(process && process.updatedAt || process && process.completedAt || process && process.startedAt || new Date().toISOString()),
    }];
  }));
}

function normalizeManagedPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid) {
  if (!pid || pid === process.pid) {
    return pid === process.pid;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && error.code === 'EPERM');
  }
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
