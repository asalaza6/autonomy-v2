import path from 'path';
import { acquireStateLock } from '../lock/lock-main.js';
import { validateAutonomyConfig } from '../config/config-main.js';
import {
  DEFAULT_SYNC_STATE,
  PRD_ARCHIVE_DIR,
  PRD_QUEUE_DIR,
  PRD_SPECS_DIR,
} from './sync-constants.js';
import { emitSyncProgress, getSyncPaths, readJson, writeJson } from './core.js';
import type { AnyRecord, AutonomyConfig } from './sync-types.js';
import { buildDerivedImportedRuntimeState, isImportedPrdRecord } from './derived-state.js';
import { buildTrackedImplementationTaskIndex, readTrackedImplementationQueuesFromRef, readTrackedReviewerTasksFromRef, resolveRemoteLaneStates } from './lanes.js';
import { buildImportedSpecState } from './lanes.js';
import { buildPrdSpecRelativePath, parsePrdSpec } from './sync-prd.js';
import { commitTrackedFilesToIntegrationBranch, fetchIntegrationBranch } from './sync-git.js';
import { listTreeFiles, readGit, readJsonFromGitRef, readTreeFile } from './git-shared.js';
import { AGENT_ROLES } from '../agents/role-catalog.js';
import { reconcileReviewTaskRecord } from './review-reconciliation.js';

function buildTrackedReviewQueueState(agent, tasks = []) {
  return {
    agentId: agent.id,
    role: agent.role,
    tasks,
  };
}

function stripUpdatedAtFields(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => stripUpdatedAtFields(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce((record, key) => {
      if (key === 'updatedAt') {
        return record;
      }
      record[key] = stripUpdatedAtFields(value[key]);
      return record;
    }, {});
}

function trackedReviewQueueSemanticallyEqual(existingQueue, nextQueue) {
  return JSON.stringify(stripUpdatedAtFields(existingQueue || {})) === JSON.stringify(stripUpdatedAtFields(nextQueue || {}));
}

function syncTrackedReviewerQueues(rootDir: string, integrationBranch: string, config: AutonomyConfig, ref: string, derivedTasks: AnyRecord[] = [], options: AnyRecord = {}) {
  const updates = [];
  const pullRequestsById = new Map<string, AnyRecord>(
    ((options.pullRequests || []) as AnyRecord[])
      .filter((pr) => pr && pr.id)
      .map((pr) => [String(pr.id), pr])
  );
  const implementationTasks = Array.isArray(options.implementationTasks) ? options.implementationTasks : [];
  const now = String(options.now || new Date().toISOString());
  const derivedTaskIds = new Set((derivedTasks || []).map((task) => task && task.id).filter(Boolean));
  const reconciledDerivedTasks = (derivedTasks || []).map((task) => reconcileReviewTaskRecord(task, {
    pullRequestsById,
    implementationTasks,
    now,
  }));
  (config.agents || []).forEach((agent) => {
    if (agent.role !== AGENT_ROLES.REVIEW) {
      return;
    }
    const relativePath = agent.taskQueue;
    if (!relativePath || path.isAbsolute(relativePath)) {
      return;
    }
    const existingQueue = readJsonFromGitRef(rootDir, ref, relativePath, buildTrackedReviewQueueState(agent, []));
    const retainedTasks = Array.isArray(existingQueue && existingQueue.tasks)
      ? existingQueue.tasks.filter((task) => {
        return !derivedTaskIds.has(task.id);
      }).map((task) => reconcileReviewTaskRecord(task, {
        pullRequestsById,
        implementationTasks,
        now,
      }))
      : [];
    const nextQueue = buildTrackedReviewQueueState(agent, retainedTasks.concat(reconciledDerivedTasks));
    if (trackedReviewQueueSemanticallyEqual(existingQueue, nextQueue)) {
      return;
    }
    updates.push({
      relativePath,
      content: nextQueue,
    });
  });
  if (updates.length === 0) {
    return null;
  }
  return commitTrackedFilesToIntegrationBranch(rootDir, integrationBranch, updates, {
    commitMessage: 'autonomy(queue): sync reviewer queue',
  });
}

function dedupeBranchLocksByOwnership(locks) {
  const byLane = new Map();
  (locks || []).forEach((lock) => {
    if (!lock) {
      return;
    }
    const laneKey = `${lock.agentId || ''}:${lock.laneKey || lock.taskId || ''}`;
    byLane.set(laneKey, lock);
  });
  const deduped = [];
  const branchOwners = new Map();
  const worktreeOwners = new Map();
  Array.from(byLane.values())
    .sort((left, right) => (Date.parse(right && right.updatedAt || '') || 0) - (Date.parse(left && left.updatedAt || '') || 0))
    .forEach((lock) => {
      const branchKey = lock.branch ? `${lock.agentId || ''}:${lock.branch}` : '';
      const worktreeKey = lock.worktreePath ? `${lock.agentId || ''}:${lock.worktreePath}` : '';
      if (branchKey && branchOwners.has(branchKey)) {
        return;
      }
      if (worktreeKey && worktreeOwners.has(worktreeKey)) {
        return;
      }
      deduped.push(lock);
      if (branchKey) {
        branchOwners.set(branchKey, true);
      }
      if (worktreeKey) {
        worktreeOwners.set(worktreeKey, true);
      }
    });
  return deduped;
}

function flattenTrackedImplementationTasks(trackedImplementationTasksByPrd) {
  if (!(trackedImplementationTasksByPrd instanceof Map)) {
    return [];
  }
  return Array.from(trackedImplementationTasksByPrd.values()).flatMap((tasks) => Array.isArray(tasks) ? tasks : []);
}

function promoteQueuedPrdSpec(rootDir: string, integrationBranch: string, queuedSpec: AnyRecord) {
  if (!queuedSpec || !queuedSpec.relativePath || !queuedSpec.spec || !queuedSpec.spec.id) {
    return null;
  }
  const activeRelativePath = buildPrdSpecRelativePath(queuedSpec.spec.id);
  return commitTrackedFilesToIntegrationBranch(rootDir, integrationBranch, [
    {
      relativePath: activeRelativePath,
      content: queuedSpec.spec,
    },
    {
      relativePath: queuedSpec.relativePath,
      delete: true,
    },
  ], {
    commitMessage: `autonomy(specs): promote queued prd ${queuedSpec.spec.id}`,
  });
}

function compareQueuedPrdSpecsForPromotion(left: AnyRecord, right: AnyRecord) {
  const leftTimestamp = String(left && left.spec && (left.spec.createdAt || left.spec.updatedAt) || '');
  const rightTimestamp = String(right && right.spec && (right.spec.createdAt || right.spec.updatedAt) || '');
  return (Date.parse(leftTimestamp) || 0) - (Date.parse(rightTimestamp) || 0);
}

function syncPrdSpecsFromIntegrationBranch(rootDir: string, integrationBranch: string, options: AnyRecord = {}) {
  const paths = getSyncPaths(rootDir);
  const fetchStartedAt = Date.now();
  emitSyncProgress(options, 'sync:fetch:start', { integrationBranch });
  const fetchResult = fetchIntegrationBranch(rootDir, integrationBranch, options);
  emitSyncProgress(options, 'sync:fetch:done', {
    integrationBranch,
    durationMs: Date.now() - fetchStartedAt,
    ref: fetchResult.ref || '-',
    fetchedRef: fetchResult.commitSha || '-',
    message: fetchResult.message || '',
  });

  const ref = fetchResult.ref;
  const agentsConfigPath = path.join(paths.repoAutonomyDir, 'config', 'agents.json');
  const config = validateAutonomyConfig(readJson<AutonomyConfig>(agentsConfigPath, {} as AutonomyConfig), agentsConfigPath);
  const sprint = readJson(path.join(paths.repoAutonomyDir, 'config', 'sprint.json'), {});
  const result: AnyRecord = {
    integrationBranch,
    ref,
    fetchedRef: fetchResult.commitSha || null,
    imported: [],
    updated: [],
    skipped: [],
    invalid: [],
    fetchMessage: fetchResult.message || '',
    queuedPromotion: null,
  };

  if (!ref) {
    return result;
  }

  emitSyncProgress(options, 'sync:specs:list:start', { ref, directory: PRD_SPECS_DIR });
  const specFiles = listTreeFiles(rootDir, ref, PRD_SPECS_DIR)
    .filter((filePath) => filePath.endsWith('.json'))
    .filter((filePath) => !filePath.startsWith(`${PRD_ARCHIVE_DIR}/`))
    .filter((filePath) => !filePath.startsWith(`${PRD_QUEUE_DIR}/`));
  const queueSpecFiles = listTreeFiles(rootDir, ref, PRD_QUEUE_DIR)
    .filter((filePath) => filePath.endsWith('.json'))
    .filter((filePath) => !filePath.startsWith(`${PRD_ARCHIVE_DIR}/`));
  const allSpecCandidates = [
    ...specFiles.map((filePath) => ({ filePath, isQueued: false })),
    ...queueSpecFiles.map((filePath) => ({ filePath, isQueued: true })),
  ];
  emitSyncProgress(options, 'sync:specs:list:done', { ref, specFiles: allSpecCandidates.length });

  const remoteSpecs = [];
  const seenPrdIds = new Set<string>();
  for (const candidate of allSpecCandidates) {
    const relativePath = candidate.filePath;
    const blobSha = readGit(rootDir, ['rev-parse', `${ref}:${relativePath}`]);
    try {
      const raw = readTreeFile(rootDir, ref, relativePath);
      const spec = parsePrdSpec(raw, relativePath);
      const prdId = String(spec.id);
      if (seenPrdIds.has(prdId)) {
        result.invalid.push({
          path: relativePath,
          message: `Duplicate PRD id "${prdId}"; skipping duplicate spec.`,
        });
        continue;
      }
      seenPrdIds.add(prdId);
      remoteSpecs.push({
        relativePath,
        blobSha,
        isQueued: candidate.isQueued,
        spec,
      });
    } catch (error) {
      result.invalid.push({
        path: relativePath,
        message: error.message,
      });
    }
  }
  emitSyncProgress(options, 'sync:specs:parsed', {
    parsed: remoteSpecs.length,
    invalid: result.invalid.length,
  });

  if (specFiles.length === 0 && options.skipQueuePromotion !== true) {
    const queuedSpecToPromote = remoteSpecs
      .filter((remoteSpec) => remoteSpec.isQueued)
      .slice()
      .sort(compareQueuedPrdSpecsForPromotion)[0];
    if (queuedSpecToPromote) {
      promoteQueuedPrdSpec(rootDir, integrationBranch, queuedSpecToPromote);
      const queuedPromotion = {
        id: String(queuedSpecToPromote.spec.id),
        title: String(queuedSpecToPromote.spec.title || queuedSpecToPromote.spec.id || ''),
        source: queuedSpecToPromote.relativePath,
        destination: buildPrdSpecRelativePath(queuedSpecToPromote.spec.id),
        promotedAt: new Date().toISOString(),
      };
      emitSyncProgress(options, 'sync:specs:queue:promoted', {
        ...queuedPromotion,
      });
      const promotionResult = syncPrdSpecsFromIntegrationBranch(rootDir, integrationBranch, {
        ...options,
        skipQueuePromotion: true,
      });
      return {
        ...promotionResult,
        queuedPromotion,
      };
    }
  }

  emitSyncProgress(options, 'sync:state-lock:wait', { lock: 'state-lock' });
  const release = acquireStateLock(rootDir);
  try {
    emitSyncProgress(options, 'sync:state-lock:acquired', { lock: 'state-lock' });
    const prsState = readJson(paths.prsState, { pullRequests: [] });
    const branchLocksState = readJson(paths.branchLocksState, { locks: [] });
    const syncState = readJson(paths.specSyncState, DEFAULT_SYNC_STATE);
    const currentQueueTasks = readTrackedReviewerTasksFromRef(rootDir, config, ref);
    const trackedImplementationTasksByPrd = buildTrackedImplementationTaskIndex(
      readTrackedImplementationQueuesFromRef(rootDir, config, ref)
    );
    const importedSpecs = remoteSpecs.filter((remoteSpec) => !remoteSpec.isQueued);

    const laneStatesStartedAt = Date.now();
    emitSyncProgress(options, 'sync:lane-states:start', {
      prds: importedSpecs.length,
      queued: remoteSpecs.length - importedSpecs.length,
    });
    const remoteLaneStates = resolveRemoteLaneStates(
      rootDir,
      integrationBranch,
      importedSpecs,
      trackedImplementationTasksByPrd,
      config,
      sprint,
      options
    );
    emitSyncProgress(options, 'sync:lane-states:done', {
      prds: importedSpecs.length,
      queued: remoteSpecs.length - importedSpecs.length,
      durationMs: Date.now() - laneStatesStartedAt,
    });

    const now = new Date().toISOString();
    const derived = buildDerivedImportedRuntimeState({
      rootDir,
      integrationBranch,
      config,
      remoteSpecs: importedSpecs,
      trackedImplementationTasksByPrd,
      remoteLaneStates,
      currentPrds: [],
      currentTasks: currentQueueTasks,
      currentPrs: prsState.pullRequests || [],
      currentBranchLocks: branchLocksState.locks || [],
      now,
      fetchedRef: fetchResult.commitSha,
    });

    result.imported.push(...derived.imported);
    result.updated.push(...derived.updated);
    result.skipped.push(...derived.skipped);
    emitSyncProgress(options, 'sync:derived-state:built', {
      imported: derived.imported.length,
      updated: derived.updated.length,
      skipped: derived.skipped.length,
      tasks: derived.tasks.length,
      prs: derived.pullRequests.length,
      branchLocks: derived.branchLocks.length,
    });

    const importedPrdIds = derived.importedPrdIds;
    const derivedPullRequestIds = new Set((derived.pullRequests || []).map((pr) => pr.id));
    const derivedBranchLockKeys = new Set((derived.branchLocks || []).map((lock) => `${lock.agentId}:${lock.laneKey || lock.taskId || ''}`));
    const nextPrs = (prsState.pullRequests || [])
      .filter((pr) => !isImportedPrdRecord(pr, importedPrdIds) || !derivedPullRequestIds.has(pr.id))
      .concat(derived.pullRequests);
    const nextBranchLocks = dedupeBranchLocksByOwnership((branchLocksState.locks || [])
      .filter((lock) => {
        if (!isImportedPrdRecord(lock, importedPrdIds)) {
          return true;
        }
        const key = `${lock.agentId}:${lock.laneKey || lock.taskId || ''}`;
        return !derivedBranchLockKeys.has(key);
      })
      .concat(derived.branchLocks));
    writeJson(paths.prsState, { pullRequests: nextPrs });
    writeJson(paths.branchLocksState, { locks: nextBranchLocks });
    syncTrackedReviewerQueues(rootDir, integrationBranch, config, ref, derived.tasks || [], {
      pullRequests: nextPrs,
      implementationTasks: flattenTrackedImplementationTasks(trackedImplementationTasksByPrd),
      now,
    });
    emitSyncProgress(options, 'sync:state:written', {
      prs: nextPrs.length,
      branchLocks: nextBranchLocks.length,
    });

    importedSpecs.forEach((remoteSpec) => {
      syncState.importedSpecs[remoteSpec.relativePath] = buildImportedSpecState(remoteSpec, fetchResult.commitSha);
    });
    syncState.integrationBranch = integrationBranch;
    syncState.lastFetchedRef = fetchResult.commitSha || syncState.lastFetchedRef || null;
    writeJson(paths.specSyncState, syncState);
    emitSyncProgress(options, 'sync:state:finalized', {
      importedSpecs: Object.keys(syncState.importedSpecs || {}).length,
      lastFetchedRef: syncState.lastFetchedRef || '-',
    });
  } finally {
    emitSyncProgress(options, 'sync:state-lock:release', { lock: 'state-lock' });
    release();
  }

  return result;
}

export { syncPrdSpecsFromIntegrationBranch };
