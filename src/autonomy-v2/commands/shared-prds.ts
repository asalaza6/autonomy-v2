import path from 'path';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { getPullRequestStateReconciliation, isPullRequestActive, isPullRequestResolved } from '../../sync/review-reconciliation.js';
import { buildPrdStateRelativePath } from '../../sync/sync-prd.js';
import { commitTrackedFilesToIntegrationBranch, listArchivedPrdSpecs, listTrackedPrdSpecs, readTrackedPrdStateMap } from '../../sync/sync-git.js';
import type { AnyRecord, AutonomyConfig, BranchLocksState, PrState, QueueMap, TrackedPrdRecord } from '../autonomy-types.js';
import { getAutonomyPaths, readJson } from './shared-core.js';
import { isTerminalTaskStatus, listTasks, readTaskQueues } from './shared-queues.js';

const DEFAULT_AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const PRD_SPECS_SEGMENTS = [...DEFAULT_AUTONOMY_SEGMENTS, 'specs', 'prds'];
const PRD_ARCHIVE_SEGMENTS = [...PRD_SPECS_SEGMENTS, 'archived'];

function findArchivablePrdIds(prdIds: string[], { taskQueues, prs, prds }: { taskQueues: QueueMap; prs: PrState; prds: { prds: TrackedPrdRecord[] } }) {
  const prdIdSet = new Set(prdIds || []);
  const prdById = new Map<string, TrackedPrdRecord>(((prds && prds.prds) || []).map((prd) => [prd.id, prd]));
  const tasksByPrdId = new Map();
  listTasks(taskQueues).forEach((task) => {
    if (!task || !task.prdId || !prdIdSet.has(task.prdId)) {
      return;
    }
    const tasks = tasksByPrdId.get(task.prdId) || [];
    tasks.push(task);
    tasksByPrdId.set(task.prdId, tasks);
  });
  const prsByPrdId = new Map();
  ((prs && prs.pullRequests) || []).forEach((pr) => {
    if (!pr || !pr.prdId || !prdIdSet.has(pr.prdId)) {
      return;
    }
    const pullRequests = prsByPrdId.get(pr.prdId) || [];
    pullRequests.push(pr);
    prsByPrdId.set(pr.prdId, pullRequests);
  });

  return Array.from(prdIdSet).filter((prdId) => {
    const linkedPullRequests = prsByPrdId.get(prdId) || [];
    if (linkedPullRequests.length > 0) {
      return linkedPullRequests.every(isMergedPullRequest);
    }

    const linkedTasks = tasksByPrdId.get(prdId) || [];
    if (linkedTasks.some((task) => !isTerminalTaskStatus(task.status))) {
      return false;
    }

    const prd = prdById.get(prdId);
    return Boolean(prd && prd.status === 'completed');
  });
}

function normalizeStringIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(
    value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
  ));
}

function isMergedPullRequest(pr) {
  return isPullRequestResolved(pr);
}

function hasValidPullRequestUrl(value) {
  const rawValue = String(value || '').trim();
  if (!rawValue) {
    return false;
  }
  try {
    const parsedUrl = new URL(rawValue);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch {
    return false;
  }
}

function compareLinkedPullRequests(left, right) {
  const leftMergedAt = Date.parse(String(left && left.remote && (left.remote.mergedAt || left.remote.merged_at) || '')) || 0;
  const rightMergedAt = Date.parse(String(right && right.remote && (right.remote.mergedAt || right.remote.merged_at) || '')) || 0;
  if (leftMergedAt !== rightMergedAt) {
    return rightMergedAt - leftMergedAt;
  }

  const leftUpdatedAt = Date.parse(String(left && left.updatedAt || left && left.createdAt || '')) || 0;
  const rightUpdatedAt = Date.parse(String(right && right.updatedAt || right && right.createdAt || '')) || 0;
  if (leftUpdatedAt !== rightUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }

  const leftNumber = Number(left && left.remote && left.remote.number) || 0;
  const rightNumber = Number(right && right.remote && right.remote.number) || 0;
  if (leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }

  return String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function selectLinkedPullRequestSummary(linkedPullRequests = []) {
  const bestPullRequest = (linkedPullRequests || [])
    .filter((pr) => {
      const remote = pr && pr.remote;
      return Boolean(
        remote
        && (
          Number(remote.number) > 0
          || hasValidPullRequestUrl(remote.url)
          || hasValidPullRequestUrl(remote.html_url)
        )
      );
    })
    .slice()
    .sort(compareLinkedPullRequests)[0] || null;
  if (!bestPullRequest) {
    return null;
  }

  const remote = bestPullRequest.remote || {};
  const url = hasValidPullRequestUrl(remote.url)
    ? String(remote.url).trim()
    : hasValidPullRequestUrl(remote.html_url)
      ? String(remote.html_url).trim()
      : null;
  const number = Number(remote.number);
  return {
    number: Number.isFinite(number) && number > 0 ? number : null,
    url,
  };
}

function isActiveLinkedPullRequest(pr, linkedTasks) {
  return isPullRequestActive(pr, linkedTasks);
}

function derivePrdStatusSource(
  linkedPullRequests = [],
  pullRequestReconciliations = [],
  plannedTaskIds = [],
  isQueued = false
) {
  if (pullRequestReconciliations.some((entry) => entry && entry.canonicalSource === 'remote')) {
    return 'remote';
  }
  if (linkedPullRequests.length > 0) {
    return 'inferred';
  }
  if (plannedTaskIds.length > 0) {
    return 'inferred';
  }
  if (isQueued) {
    return 'queued';
  }
  return 'inferred';
}

function derivePrdReconciliationStatus(pullRequestReconciliations = []) {
  if (pullRequestReconciliations.some((entry) => entry && entry.reconciliationStatus === 'stale')) {
    return 'stale';
  }
  if (pullRequestReconciliations.some((entry) => entry && entry.canonicalSource === 'remote')) {
    return 'remote';
  }
  return 'inferred';
}

function deriveCompletedTaskSpecIds(plannedTaskIds, linkedTasks = [], linkedPullRequests = []) {
  const plannedIds = normalizeStringIds(plannedTaskIds);
  if (plannedIds.length === 0) {
    return [];
  }

  const plannedIdSet = new Set(plannedIds);
  const completedIds = new Set();

  linkedTasks.forEach((task) => {
    const taskId = String(task && task.id || '').trim();
    const status = String(task && (task.status || task.state) || '').trim();
    if (taskId && plannedIdSet.has(taskId) && isTerminalTaskStatus(status)) {
      completedIds.add(taskId);
    }
  });

  linkedPullRequests.forEach((pr) => {
    const pendingIds = new Set(normalizeStringIds(pr && pr.pendingTaskIds));
    normalizeStringIds(pr && pr.completedTaskIds).forEach((taskId) => {
      if (plannedIdSet.has(taskId) && !pendingIds.has(taskId)) {
        completedIds.add(taskId);
      }
    });

    if (isMergedPullRequest(pr) || Array.isArray(pr && pr.pendingTaskIds)) {
      normalizeStringIds(pr && pr.taskIds).forEach((taskId) => {
        if (plannedIdSet.has(taskId) && !pendingIds.has(taskId)) {
          completedIds.add(taskId);
        }
      });
    }
  });

  return plannedIds.filter((taskId) => completedIds.has(taskId));
}

function loadTrackedPrds(rootDir: string, config: AutonomyConfig, options: AnyRecord = {}): { prds: TrackedPrdRecord[] } {
  const taskQueues = (options.taskQueues as QueueMap) || readTaskQueues(rootDir, config);
  const prs = (options.prs as PrState) || readJson<PrState>(getAutonomyPaths(rootDir).prsState);
  const prdStateMap = readTrackedPrdStateMap(rootDir, config.integrationBranch);
  const tasksByPrdId = new Map();
  const prsByPrdId = new Map();

  listTasks(taskQueues).forEach((task) => {
    if (!task || !task.prdId) {
      return;
    }
    const tasks = tasksByPrdId.get(task.prdId) || [];
    tasks.push(task);
    tasksByPrdId.set(task.prdId, tasks);
  });
  ((prs && prs.pullRequests) || []).forEach((pr) => {
    if (!pr || !pr.prdId) {
      return;
    }
    const pullRequests = prsByPrdId.get(pr.prdId) || [];
    pullRequests.push(pr);
    prsByPrdId.set(pr.prdId, pullRequests);
  });

  return {
    prds: listTrackedPrdSpecs(rootDir, config.integrationBranch).map((entry) => {
      const trackedState = prdStateMap.get(entry.spec.id) || null;
      const linkedTasks = tasksByPrdId.get(entry.spec.id) || [];
      const linkedPullRequests = prsByPrdId.get(entry.spec.id) || [];
      const plannedTaskIds = trackedState && Array.isArray(trackedState.plannedTaskIds) && trackedState.plannedTaskIds.length > 0
        ? trackedState.plannedTaskIds.slice()
        : linkedTasks.map((task) => task.id);
      const completedTaskSpecIds = deriveCompletedTaskSpecIds(plannedTaskIds, linkedTasks, linkedPullRequests);
      const plannedTaskIdSet = new Set(normalizeStringIds(plannedTaskIds));
      const completedTaskSpecIdSet = new Set(completedTaskSpecIds);
      const hasActivePullRequest = linkedPullRequests.some((pr) => isActiveLinkedPullRequest(pr, linkedTasks));
      const pullRequestReconciliations = linkedPullRequests.map((pr) => getPullRequestStateReconciliation(pr, linkedTasks));
      const prdStatusSource = derivePrdStatusSource(linkedPullRequests, pullRequestReconciliations, plannedTaskIds, entry.isQueued === true);
      const prdReconciliationStatus = derivePrdReconciliationStatus(pullRequestReconciliations);
      const hasPendingUncompletedTask = linkedTasks.some((task) => {
        const taskId = String(task && task.id || '').trim();
        if (!taskId || !plannedTaskIdSet.has(taskId) || completedTaskSpecIdSet.has(taskId)) {
          return false;
        }
        return !isTerminalTaskStatus(String(task && (task.status || task.state) || ''));
      });
      let status = 'queued';
      if (trackedState && (trackedState.status === 'planning' || trackedState.status === 'failed')) {
        status = trackedState.status;
      } else if (
        plannedTaskIds.length > 0
        && completedTaskSpecIds.length >= plannedTaskIds.length
        && !hasActivePullRequest
        && !hasPendingUncompletedTask
      ) {
        status = 'completed';
      } else if (linkedPullRequests.length > 0 && linkedPullRequests.every(isMergedPullRequest)) {
        status = 'completed';
      } else if ((trackedState && trackedState.status === 'planned') || plannedTaskIds.length > 0) {
        status = 'planned';
      } else if (entry.isQueued) {
        status = 'queued';
      }
      return {
        ...entry.spec,
        isQueued: entry.isQueued === true,
        status,
        statusSource: prdStatusSource,
        statusReason: hasActivePullRequest
          ? 'linked pull request remains open upstream'
          : linkedPullRequests.length > 0 && linkedPullRequests.every(isMergedPullRequest)
            ? 'all linked pull requests are resolved upstream'
            : plannedTaskIds.length > 0 && completedTaskSpecIds.length >= plannedTaskIds.length
              ? 'all planned tasks are complete locally'
              : entry.isQueued === true
                ? 'spec remains queued'
                : 'tracked PRD status derived from local repo state',
        reconciliationStatus: prdReconciliationStatus,
        linkedPullRequestSummary: linkedPullRequests.length > 0 ? {
          total: linkedPullRequests.length,
          open: pullRequestReconciliations.filter((entry) => entry.canonicalState === 'open').length,
          resolved: pullRequestReconciliations.filter((entry) => entry.canonicalState !== 'open').length,
          stale: pullRequestReconciliations.filter((entry) => entry.reconciliationStatus === 'stale').length,
        } : undefined,
        plannedTaskIds: plannedTaskIds.length > 0 ? plannedTaskIds : undefined,
        completedTaskSpecIds: completedTaskSpecIds.length > 0 ? completedTaskSpecIds : undefined,
        lastError: trackedState && trackedState.lastError ? trackedState.lastError : undefined,
        updatedAt: trackedState && trackedState.updatedAt ? trackedState.updatedAt : entry.spec.createdAt,
      };
    }),
  };
}

function loadTrackedPrdHistory(rootDir: string, config: AutonomyConfig, options: AnyRecord = {}): { prds: TrackedPrdRecord[] } {
  const prs = (options.prs as PrState) || readJson<PrState>(getAutonomyPaths(rootDir).prsState);
  const prsByPrdId = new Map<string, any[]>();
  ((prs && prs.pullRequests) || []).forEach((pr) => {
    const prdId = String(pr && pr.prdId || '').trim();
    if (!prdId) {
      return;
    }
    const pullRequests = prsByPrdId.get(prdId) || [];
    pullRequests.push(pr);
    prsByPrdId.set(prdId, pullRequests);
  });
  const activePrds = ((options.prds && Array.isArray(options.prds.prds)) ? options.prds.prds : [])
    .filter((prd) => prd && String(prd.status || '') === 'completed')
    .map((prd) => {
      const pullRequest = selectLinkedPullRequestSummary(prsByPrdId.get(String(prd && prd.id || '').trim()) || []);
      return {
        ...prd,
        status: 'completed',
        isQueued: false,
        ...(pullRequest ? { pullRequest } : {}),
      };
    });
  const archivedPrds = listArchivedPrdSpecs(rootDir, config.integrationBranch).map((entry) => {
    const pullRequest = selectLinkedPullRequestSummary(prsByPrdId.get(String(entry.spec && entry.spec.id || '').trim()) || []);
    return {
      ...entry.spec,
      isQueued: false,
      status: String(entry.spec && entry.spec.archive && entry.spec.archive.kind || '').trim() === 'reset'
        ? 'reset'
        : 'completed',
      updatedAt: String(entry.spec && entry.spec.archive && entry.spec.archive.archivedAt || entry.spec.createdAt),
      archived: true,
      archivePath: entry.relativePath,
      ...(pullRequest ? { pullRequest } : {}),
    };
  });
  const historyById = new Map<string, TrackedPrdRecord>();
  [...activePrds, ...archivedPrds].forEach((prd) => {
    if (!prd || !prd.id || historyById.has(prd.id)) {
      return;
    }
    historyById.set(prd.id, prd);
  });
  return {
    prds: Array.from(historyById.values()).sort((left, right) => {
      return (Date.parse(String(right.updatedAt || right.createdAt || '')) || 0)
        - (Date.parse(String(left.updatedAt || left.createdAt || '')) || 0);
    }),
  };
}

function archiveCompletedPrdSpecs(rootDir, state) {
  if (!state || !state.config || !state.config.integrationBranch) {
    throw new Error('archiveCompletedPrdSpecs requires config.integrationBranch.');
  }
  const currentSpecs = listTrackedPrdSpecs(rootDir, state.config.integrationBranch).map((entry) => ({
    id: entry.spec.id,
    fileName: path.basename(entry.relativePath),
    relativePath: entry.relativePath,
    spec: entry.spec,
  }));
  const archivableIds = new Set(findArchivablePrdIds(
    currentSpecs.map((entry) => entry.id),
    state
  ));

  if (archivableIds.size === 0) {
    return [];
  }

  const archivableEntries = currentSpecs.filter((entry) => archivableIds.has(entry.id));
  const archived = archivableEntries.map((entry) => ({
    id: entry.id,
    from: entry.relativePath,
    to: path.posix.join(...PRD_ARCHIVE_SEGMENTS, entry.fileName),
  }));

  const trackedUpdates = [];
  archivableEntries.forEach((entry) => {
    trackedUpdates.push({
      relativePath: path.posix.join(...PRD_ARCHIVE_SEGMENTS, entry.fileName),
      content: entry.spec,
    });
    trackedUpdates.push({
      relativePath: entry.relativePath,
      delete: true,
    });
    trackedUpdates.push({
      relativePath: buildPrdStateRelativePath(entry.id),
      delete: true,
    });
  });
  commitTrackedFilesToIntegrationBranch(rootDir, state.config.integrationBranch, trackedUpdates, {
    commitMessage: `autonomy(specs): archive completed prd${archivableEntries.length === 1 ? '' : 's'}`,
    gitIdentity: state.gitIdentity,
  });
  return archived;
}

function loadAllState(rootDir: string): {
  config: AutonomyConfig;
  sprint: AnyRecord;
  taskQueues: QueueMap;
  prs: PrState;
  branchLocks: BranchLocksState;
} {
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  return {
    config,
    sprint: readJson(paths.sprintConfig),
    taskQueues: readTaskQueues(rootDir, config),
    prs: readJson<PrState>(paths.prsState),
    branchLocks: readJson<BranchLocksState>(paths.branchLocksState),
  };
}

export {
  archiveCompletedPrdSpecs,
  loadAllState,
  loadTrackedPrdHistory,
  loadTrackedPrds,
};
