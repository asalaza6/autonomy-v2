import path from 'path';
import { acquireStateLock } from '../lock/index.js';
import { validateAutonomyConfig } from '../config/index.js';
import {
  DEFAULT_SYNC_STATE,
  PRD_ARCHIVE_DIR,
  PRD_QUEUE_DIR,
  PRD_SPECS_DIR,
} from './constants.js';
import { emitSyncProgress, getSyncPaths, readJson, writeJson } from './core.js';
import type { AnyRecord, AutonomyConfig } from './types.js';
import { buildDerivedImportedRuntimeState, isImportedPrdRecord } from './derived-state.js';
import { buildTrackedImplementationTaskIndex, readTrackedImplementationQueuesFromRef, readTrackedReviewerTasksFromRef, resolveRemoteLaneStates } from './lanes.js';
import { buildImportedSpecState } from './lanes.js';
import { buildPrdSpecRelativePath, parsePrdSpec } from './prd.js';
import { fetchIntegrationBranch } from './git.js';
import { listTreeFiles, readGit, readTreeFile } from './git-shared.js';

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
  const seenPrdIds = new Set();
  for (const candidate of allSpecCandidates) {
    const relativePath = candidate.filePath;
    const blobSha = readGit(rootDir, ['rev-parse', `${ref}:${relativePath}`]);
    try {
      const raw = readTreeFile(rootDir, ref, relativePath);
      const spec = parsePrdSpec(raw, relativePath);
      if (seenPrdIds.has(spec.id)) {
        result.invalid.push({
          path: relativePath,
          message: `Duplicate PRD id "${spec.id}"; skipping duplicate spec.`,
        });
        continue;
      }
      seenPrdIds.add(spec.id);
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
    const hasActivePrd = remoteSpecs.some((remoteSpec) => !remoteSpec.isQueued);
    const importedSpecs = remoteSpecs.filter((remoteSpec) => !remoteSpec.isQueued);
    if (!hasActivePrd) {
      const queuedSpecToPromote = remoteSpecs.find((remoteSpec) => remoteSpec.isQueued);
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

    const trackedImplementationTasksByPrd = buildTrackedImplementationTaskIndex(
      readTrackedImplementationQueuesFromRef(rootDir, config, ref)
    );
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
    const nextBranchLocks = (branchLocksState.locks || [])
      .filter((lock) => {
        if (!isImportedPrdRecord(lock, importedPrdIds)) {
          return true;
        }
        const key = `${lock.agentId}:${lock.laneKey || lock.taskId || ''}`;
        return !derivedBranchLockKeys.has(key);
      })
      .concat(derived.branchLocks);
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
