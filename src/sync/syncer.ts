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
import { fetchIntegrationBranch, readTrackedPrdStateMap } from './sync-git.js';
import { listTreeFiles, readGit, readTreeFile } from './git-shared.js';

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

function isPrdStateActiveForPromotion(prdState, trackedTasksByPrd) {
  if (!prdState) {
    return false;
  }
  const status = String(prdState.status || '').trim();
  if (status === 'planning') {
    return true;
  }
  if (!['planning', 'planned', 'failed'].includes(status)) {
    return false;
  }
  const plannedTaskIds = Array.isArray(prdState.plannedTaskIds)
    ? prdState.plannedTaskIds
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    : [];
  if (plannedTaskIds.length === 0) {
    return false;
  }
  const trackedTasks = Array.isArray(trackedTasksByPrd?.get(String(prdState.prdId || '').trim()))
    ? trackedTasksByPrd.get(String(prdState.prdId || '').trim())
    : [];
  const trackedTaskIds = new Set(plannedTaskIds);
  const relevantTasks = trackedTasks.filter((task) => trackedTaskIds.has(String(task && task.id || '')));
  if (relevantTasks.length === 0) {
    return false;
  }
  return relevantTasks.some((task) => {
    const taskState = String(task && (task.state || task.status || '') || '').trim();
    return !['done', 'merged'].includes(taskState);
  });
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
  const seenPrdIds = new Map<string, { hasQueued: boolean; hasUnqueued: boolean }>();
  for (const candidate of allSpecCandidates) {
    const relativePath = candidate.filePath;
    const blobSha = readGit(rootDir, ['rev-parse', `${ref}:${relativePath}`]);
    try {
      const raw = readTreeFile(rootDir, ref, relativePath);
      const spec = parsePrdSpec(raw, relativePath);
      const prdId = String(spec.id);
      const candidateState = seenPrdIds.get(prdId) || { hasQueued: false, hasUnqueued: false };
      if (candidate.isQueued) {
        candidateState.hasQueued = true;
      } else {
        candidateState.hasUnqueued = true;
      }
      if (seenPrdIds.has(prdId)) {
        result.invalid.push({
          path: relativePath,
          message: `Duplicate PRD id "${prdId}"; skipping duplicate spec.`,
        });
        seenPrdIds.set(prdId, candidateState);
        continue;
      }
      seenPrdIds.set(prdId, candidateState);
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

  emitSyncProgress(options, 'sync:state-lock:wait', { lock: 'state-lock' });
  const release = acquireStateLock(rootDir);
  try {
    emitSyncProgress(options, 'sync:state-lock:acquired', { lock: 'state-lock' });
    const prsState = readJson(paths.prsState, { pullRequests: [] });
    const branchLocksState = readJson(paths.branchLocksState, { locks: [] });
    const syncState = readJson(paths.specSyncState, DEFAULT_SYNC_STATE);
    const currentQueueTasks = readTrackedReviewerTasksFromRef(rootDir, config, ref);
    const trackedPrdStateMap = readTrackedPrdStateMap(rootDir, config.integrationBranch);
    const trackedImplementationTasksByPrd = buildTrackedImplementationTaskIndex(
      readTrackedImplementationQueuesFromRef(rootDir, config, ref)
    );
    const hasActivePrd = Array.from(seenPrdIds.entries()).some(([prdId, entry]) => {
      const isQueuedOnly = entry.hasUnqueued && !entry.hasQueued;
      if (!isQueuedOnly) {
        return false;
      }
      return isPrdStateActiveForPromotion(trackedPrdStateMap.get(prdId), trackedImplementationTasksByPrd);
    });
    const importedSpecs = remoteSpecs.filter((remoteSpec) => !remoteSpec.isQueued);
    if (!hasActivePrd) {
      const unqueuedPrdIds = new Set(Array.from(seenPrdIds.entries())
        .filter((entry) => entry[1].hasUnqueued)
        .map((entry) => entry[0]));
      const queuedSpecToPromote = remoteSpecs.find((remoteSpec) => remoteSpec.isQueued && !unqueuedPrdIds.has(remoteSpec.spec.id));
      if (queuedSpecToPromote) {
        queuedSpecToPromote.isQueued = false;
        importedSpecs.push(queuedSpecToPromote);
        emitSyncProgress(options, 'sync:specs:queue:promoted', {
          id: queuedSpecToPromote.spec.id,
          source: queuedSpecToPromote.relativePath,
          destination: buildPrdSpecRelativePath(queuedSpecToPromote.spec.id),
        });
      }
    }

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
