import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { validateAutonomyConfig } from '../config/index.js';
import { resolveGithubAuthToken } from '../github/index.js';
import { acquireStateLock } from '../lock/index.js';
import { AGENT_ROLES, TASK_TYPES, getRoleLabel, isImplementationRole, isReviewRole, } from '../agents/role-catalog.js';
import type { AnyRecord, AutonomyConfig, HttpResponse, PrState, PrdSpecPayload, PrdStateRecord, PullRequestRecord, QueueMap, QueueState, TaskRecord, TrackedPrdRecord } from '../types.js';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const PRD_SPECS_DIR = path.posix.join(...AUTONOMY_SEGMENTS, 'specs', 'prds');
const PRD_QUEUE_DIR = path.posix.join(PRD_SPECS_DIR, 'queue');
const PRD_ARCHIVE_DIR = path.posix.join(PRD_SPECS_DIR, 'archived');
const PRD_STATE_DIR = path.posix.join(...AUTONOMY_SEGMENTS, 'specs', 'prd-state');
const GIT_NETWORK_TIMEOUT_MS = 15000;
const HTTP_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_SYNC_STATE = {
  integrationBranch: 'dev',
  lastFetchedRef: null,
  importedSpecs: {},
};

function emitSyncProgress(options: AnyRecord, event: string, payload: AnyRecord = {}) {
  if (!options || typeof options.onProgress !== 'function') {
    return;
  }
  try {
    options.onProgress(event, payload);
  } catch (_) {
    // Sync progress logs must never break sync itself.
  }
}

function getSyncPaths(rootDir) {
  const repoAutonomyDir = path.join(rootDir, ...AUTONOMY_SEGMENTS);
  const stateDir = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state');
  return {
    repoAutonomyDir,
    stateDir,
    prsState: path.join(stateDir, 'prs.json'),
    branchLocksState: path.join(stateDir, 'branch-locks.json'),
    queuesDir: path.join(stateDir, 'queues'),
    specSyncState: path.join(stateDir, 'spec-sync.json'),
    controlWorktree: path.join(rootDir, '.autonomy', 'control', 'dev-sync'),
  };
}

function buildPrdSpecPayload({ id, title, tasks, createdAt, specification, requirements }: AnyRecord): PrdSpecPayload {
  const normalizedSpecification = typeof specification === 'string' ? specification.trim() : '';
  const normalizedRequirements = normalizeStringList(requirements);
  const normalizedTasks = Array.isArray(tasks) && tasks.length > 0
    ? normalizeTaskSpecs(tasks || [], {
        allowEmpty: Boolean(normalizedSpecification) || normalizedRequirements.length > 0,
      })
    : [];
  const payload: PrdSpecPayload = {
    schemaVersion: normalizedSpecification || normalizedRequirements.length > 0 ? 2 : 1,
    id: String(id),
    title: String(title),
    createdAt: createdAt || new Date().toISOString(),
    specification: normalizedSpecification || undefined,
    requirements: normalizedRequirements.length > 0 ? normalizedRequirements : undefined,
  };
  if (normalizedTasks.length > 0) {
    payload.tasks = normalizedTasks;
  }
  return payload;
}


function hasPrdSpecInIntegrationBranch(rootDir, integrationBranch, prdId) {
  const fetchResult = fetchIntegrationBranch(rootDir, integrationBranch);
  const ref = fetchResult.ref || integrationBranch;
  if (!ref) {
    return false;
  }
  const specPath = buildPrdSpecRelativePath(String(prdId));
  const queueSpecPath = buildPrdSpecRelativePath(String(prdId), { queue: true });

  try {
    readGit(rootDir, ['cat-file', '-e', `${ref}:${specPath}`]);
    return true;
  } catch (_) {
    // File path does not exist in active location.
  }

  try {
    readGit(rootDir, ['cat-file', '-e', `${ref}:${queueSpecPath}`]);
    return true;
  } catch (_) {
    // File path does not exist in queue location.
  }

  return false;
}

function hasActivePrdSpecInIntegrationBranch(rootDir, integrationBranch) {
  const fetchResult = fetchIntegrationBranch(rootDir, integrationBranch);
  const ref = fetchResult.ref || integrationBranch;
  if (!ref) {
    return false;
  }
  try {
    const output = readGit(rootDir, [
      'ls-tree',
      '-r',
      '--name-only',
      ref,
      path.posix.join(...AUTONOMY_SEGMENTS, 'specs', 'prds'),
    ]);
    return output
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .some((entry) => {
        return entry.startsWith(`${PRD_SPECS_DIR}/`)
          && !entry.startsWith(`${PRD_QUEUE_DIR}/`)
          && !entry.startsWith(`${PRD_ARCHIVE_DIR}/`)
          && !entry.endsWith('README.md');
      });
  } catch (_) {
    return false;
  }
}

function commitPrdSpecToIntegrationBranch(rootDir: string, integrationBranch: string, prdSpec: AnyRecord, options: AnyRecord = {}) {
  const normalizedSpec = buildPrdSpecPayload(prdSpec);
  const paths = getSyncPaths(rootDir);
  const controlWorktree = ensureControlWorktree(rootDir, integrationBranch, paths.controlWorktree);
  configureGitIdentity(controlWorktree, options.gitIdentity);
  const relativeSpecPath = buildPrdSpecRelativePath(normalizedSpec.id, {
    queue: Boolean(options.queueSpec),
  });
  const absoluteSpecPath = path.join(controlWorktree, relativeSpecPath);
  ensureDir(path.dirname(absoluteSpecPath));
  fs.writeFileSync(absoluteSpecPath, `${JSON.stringify(normalizedSpec, null, 2)}\n`, 'utf8');

  runGit(controlWorktree, ['add', relativeSpecPath]);
  if (!gitHasStagedChanges(controlWorktree)) {
    return {
      integrationBranch,
      controlWorktree,
      specPath: relativeSpecPath,
      committed: false,
      pushed: false,
      commitSha: readGit(controlWorktree, ['rev-parse', 'HEAD']),
    };
  }

  const commitMessage = options.commitMessage || `autonomy(prd): upsert ${normalizedSpec.id}`;
  runGit(controlWorktree, ['commit', '-m', commitMessage]);
  const commitSha = readGit(controlWorktree, ['rev-parse', 'HEAD']);
  const pushArgs = gitAuthArgs().concat(['push', 'origin', `HEAD:${integrationBranch}`]);
  let pushed = false;
  let pushMessage = '';
  if (gitRemoteExists(controlWorktree, 'origin')) {
    try {
      runGit(controlWorktree, pushArgs);
      pushed = true;
      pushMessage = `pushed to origin/${integrationBranch}`;
    } catch (error) {
      pushMessage = extractExecError(error);
      throw new Error(`Failed to push PRD spec to origin/${integrationBranch}: ${pushMessage}`);
    }
  } else {
    pushMessage = 'origin remote not configured; committed locally only';
  }

  return {
    integrationBranch,
    controlWorktree,
    specPath: relativeSpecPath,
    committed: true,
    pushed,
    pushMessage,
    commitSha,
  };
}

function commitTrackedFilesToIntegrationBranch(rootDir: string, integrationBranch: string, fileUpdates: AnyRecord[], options: AnyRecord = {}) {
  const normalizedUpdates = (Array.isArray(fileUpdates) ? fileUpdates : [])
    .map((entry) => {
      if (!entry || !entry.relativePath) {
        return null;
      }
      const relativePath = String(entry.relativePath).trim().replace(/\\/g, '/');
      if (!relativePath) {
        return null;
      }
      return {
        relativePath,
        delete: entry.delete === true,
        content: entry.delete === true
          ? null
          : (typeof entry.content === 'string'
            ? entry.content
            : `${JSON.stringify(entry.content || {}, null, 2)}\n`),
      };
    })
    .filter(Boolean);

  if (normalizedUpdates.length === 0) {
    return {
      integrationBranch,
      controlWorktree: null,
      paths: [],
      committed: false,
      pushed: false,
      commitSha: null,
    };
  }

  const paths = getSyncPaths(rootDir);
  const controlWorktree = ensureControlWorktree(rootDir, integrationBranch, paths.controlWorktree);
  configureGitIdentity(controlWorktree, options.gitIdentity);

  normalizedUpdates.forEach((entry) => {
    const absolutePath = path.join(controlWorktree, entry.relativePath);
    if (entry.delete === true) {
      fs.rmSync(absolutePath, { force: true });
      return;
    }
    ensureDir(path.dirname(absolutePath));
    fs.writeFileSync(absolutePath, entry.content, 'utf8');
  });

  runGit(controlWorktree, ['add', '--all', '--', ...normalizedUpdates.map((entry) => entry.relativePath)]);
  if (!gitHasStagedChanges(controlWorktree)) {
    return {
      integrationBranch,
      controlWorktree,
      paths: normalizedUpdates.map((entry) => entry.relativePath),
      committed: false,
      pushed: false,
      commitSha: readGit(controlWorktree, ['rev-parse', 'HEAD']),
    };
  }

  const commitMessage = options.commitMessage || 'autonomy(sync): update tracked files';
  runGit(controlWorktree, ['commit', '-m', commitMessage]);
  const commitSha = readGit(controlWorktree, ['rev-parse', 'HEAD']);
  const pushArgs = gitAuthArgs().concat(['push', 'origin', `HEAD:${integrationBranch}`]);
  let pushed = false;
  let pushMessage = '';
  if (gitRemoteExists(controlWorktree, 'origin')) {
    try {
      runGit(controlWorktree, pushArgs);
      pushed = true;
      pushMessage = `pushed to origin/${integrationBranch}`;
    } catch (error) {
      pushMessage = extractExecError(error);
      throw new Error(`Failed to push tracked files to origin/${integrationBranch}: ${pushMessage}`);
    }
  } else {
    pushMessage = 'origin remote not configured; committed locally only';
  }

  return {
    integrationBranch,
    controlWorktree,
    paths: normalizedUpdates.map((entry) => entry.relativePath),
    committed: true,
    pushed,
    pushMessage,
    commitSha,
  };
}

function syncPrdSpecsFromIntegrationBranch(rootDir: string, integrationBranch: string, options: AnyRecord = {}) {
  const paths = getSyncPaths(rootDir);
  const fetchStartedAt = Date.now();
  emitSyncProgress(options, 'sync:fetch:start', {
    integrationBranch,
  });
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

  emitSyncProgress(options, 'sync:specs:list:start', {
    ref,
    directory: PRD_SPECS_DIR,
  });
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
  emitSyncProgress(options, 'sync:specs:list:done', {
    ref,
    specFiles: allSpecCandidates.length,
  });
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
    const queuedSpecsRemaining = remoteSpecs.length - importedSpecs.length;
    const trackedImplementationTasksByPrd = buildTrackedImplementationTaskIndex(
      readTrackedImplementationQueuesFromRef(rootDir, config, ref)
    );
    const laneStatesStartedAt = Date.now();
    emitSyncProgress(options, 'sync:lane-states:start', {
      prds: importedSpecs.length,
      queued: queuedSpecsRemaining,
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
      queued: queuedSpecsRemaining,
      durationMs: Date.now() - laneStatesStartedAt,
    });
    const now = new Date().toISOString();
    const derived = buildDerivedImportedRuntimeState({
      rootDir,
      integrationBranch,
      config,
      sprint,
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
    const derivedBranchLockKeys = new Set((derived.branchLocks || []).map((lock) => {
      return `${lock.agentId}:${lock.laneKey || lock.taskId || ''}`;
    }));
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


function readJsonFromGitRef(rootDir, ref, relativePath, fallbackValue) {
  if (!ref || path.isAbsolute(relativePath)) {
    return fallbackValue;
  }
  try {
    return JSON.parse(readGit(rootDir, [
      'show',
      `${ref}:${relativePath.replace(/\\/g, '/')}`,
    ]));
  } catch (_) {
    return fallbackValue;
  }
}

function readTrackedImplementationQueuesFromRef(rootDir: string, config: AutonomyConfig, ref: string): QueueMap {
  return (config.agents || []).reduce((queues, agent) => {
    if (!isImplementationRole(agent.role)) {
      return queues;
    }
    const relativePath = agent.taskQueue;
    const absolutePath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(rootDir, relativePath);
    const fallbackQueue = fs.existsSync(absolutePath)
      ? readJson(absolutePath, { tasks: [] })
      : {
          schemaVersion: 1,
          agentId: agent.id,
          role: agent.role,
          tasks: [],
        };
    const queueState = readJsonFromGitRef(rootDir, ref, relativePath, fallbackQueue);
    queues[agent.id] = {
      schemaVersion: 1,
      agentId: agent.id,
      role: agent.role,
      tasks: Array.isArray(queueState.tasks) ? queueState.tasks : [],
    };
    return queues;
  }, {});
}

function readTrackedReviewerTasksFromRef(rootDir: string, config: AutonomyConfig, ref: string): TaskRecord[] {
  return (config.agents || []).reduce((tasks, agent) => {
    if (!isReviewRole(agent.role)) {
      return tasks;
    }
    const relativePath = agent.taskQueue;
    const absolutePath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(rootDir, relativePath);
    const fallbackQueue = fs.existsSync(absolutePath)
      ? readJson(absolutePath, { tasks: [] })
      : {
          agentId: agent.id,
          role: agent.role,
          tasks: [],
        };
    const queueState = readJsonFromGitRef(rootDir, ref, relativePath, fallbackQueue);
    return tasks.concat(Array.isArray(queueState.tasks) ? queueState.tasks : []);
  }, []);
}

function buildTrackedImplementationTaskIndex(trackedQueues: QueueMap) {
  const tasksByPrd = new Map<string, TaskRecord[]>();
  Object.values(trackedQueues || {}).forEach((queue) => {
    (queue.tasks || []).forEach((task) => {
      const prdId = String(task && task.prdId || '').trim();
      if (!prdId) {
        return;
      }
      const tasks = tasksByPrd.get(prdId) || [];
      tasks.push(task);
      tasksByPrd.set(prdId, tasks);
    });
  });
  return tasksByPrd;
}

function getPlannedImplementationTasksForPrd(remoteSpec, trackedImplementationTasksByPrd) {
  const prdId = String(remoteSpec && remoteSpec.spec && remoteSpec.spec.id || '').trim();
  const trackedTasks = trackedImplementationTasksByPrd instanceof Map
    ? trackedImplementationTasksByPrd.get(prdId)
    : null;
  if (Array.isArray(trackedTasks) && trackedTasks.length > 0) {
    return trackedTasks.slice();
  }
  return [];
}

function resolveRemoteLaneStates(rootDir: string, integrationBranch: string, remoteSpecs: AnyRecord[], trackedImplementationTasksByPrd: Map<string, TaskRecord[]>, config: AutonomyConfig, sprint: AnyRecord, options: AnyRecord = {}) {
  const token = resolveGithubAuthToken();
  let repo = null;
  if (token) {
    try {
      repo = resolveGithubRepo(rootDir);
    } catch (_) {
      repo = null;
    }
  }

  const result: Record<string, AnyRecord> = {};

  remoteSpecs.forEach((remoteSpec) => {
    const laneStates = {};
    const groupedTasks = groupLaneTasksByAgent(
      getPlannedImplementationTasksForPrd(remoteSpec, trackedImplementationTasksByPrd)
    );
    emitSyncProgress(options, 'sync:lane-state:prd:start', {
      prdId: remoteSpec.spec.id,
      lanes: Object.keys(groupedTasks).length,
    });
    Object.keys(groupedTasks).forEach((agentId) => {
      const branch = buildLaneBranchName(config, sprint, remoteSpec.spec.id, groupedTasks[agentId][0]);
      emitSyncProgress(options, 'sync:lane-state:start', {
        prdId: remoteSpec.spec.id,
        agentId,
        branch,
      });
      laneStates[agentId] = resolveRemoteLaneState(rootDir, repo, token, integrationBranch, branch, config, agentId);
      emitSyncProgress(options, 'sync:lane-state:done', {
        prdId: remoteSpec.spec.id,
        agentId,
        branch,
        branchExists: laneStates[agentId].branchExists ? 'yes' : 'no',
        commitCount: laneStates[agentId].commitCount,
        merged: laneStates[agentId].merged ? 'yes' : 'no',
      });
    });
    emitSyncProgress(options, 'sync:lane-state:prd:done', {
      prdId: remoteSpec.spec.id,
      lanes: Object.keys(groupedTasks).length,
    });
    result[remoteSpec.spec.id] = laneStates;
  });

  return result;
}

function resolveRemoteLaneState(rootDir: string, repo: AnyRecord, token: string, integrationBranch: string, branch: string, config: AutonomyConfig, agentId: string) {
  const branchQueueState = readRemoteImplementationQueueState(rootDir, config, integrationBranch, branch, agentId);
  try {
    if (repo && token) {
      const pulls = listPullRequestsByHead(repo, token, integrationBranch, branch);
      const merged = pulls.find((pull) => Boolean(pull.merged_at)) || null;
      const open = pulls.find((pull) => pull.state === 'open') || null;
      const preferredPr = open || merged;
      if (preferredPr) {
        const details = getPullRequest(repo, token, preferredPr.number);
        return {
          branch,
          branchExists: branchQueueState ? true : remoteBranchExists(rootDir, branch),
          commitCount: branchQueueState ? branchQueueState.commitCount : Number(details.commits || 0),
          merged: Boolean(details.merged_at),
          mergedPrNumber: details.merged_at ? details.number : null,
          openPrNumber: details.state === 'open' ? details.number : null,
          queueState: branchQueueState ? branchQueueState.queueState : null,
          remote: {
            number: details.number,
            url: details.html_url,
            state: details.state,
            mergedAt: details.merged_at || null,
            title: details.title || '',
            body: details.body || '',
          },
        };
      }

      const comparison = compareBranchToBase(repo, token, integrationBranch, branch);
      if (comparison) {
        return {
          branch,
          branchExists: true,
          commitCount: branchQueueState ? branchQueueState.commitCount : Number(comparison.ahead_by || 0),
          merged: false,
          mergedPrNumber: null,
          openPrNumber: null,
          queueState: branchQueueState ? branchQueueState.queueState : null,
          remote: null,
        };
      }
    }

    if (branchQueueState || remoteBranchExists(rootDir, branch)) {
      return {
        branch,
        branchExists: true,
        commitCount: branchQueueState ? branchQueueState.commitCount : countRemoteBranchCommits(rootDir, integrationBranch, branch),
        merged: false,
        mergedPrNumber: null,
        openPrNumber: null,
        queueState: branchQueueState ? branchQueueState.queueState : null,
        remote: null,
      };
    }
  } catch (_) {
    // Fall back to an empty lane state below.
  }

  return {
    branch,
    branchExists: false,
    commitCount: 0,
    merged: false,
    mergedPrNumber: null,
    openPrNumber: null,
    queueState: null,
    remote: null,
  };
}

function buildDerivedImportedRuntimeState({
  rootDir,
  integrationBranch,
  config,
  sprint,
  remoteSpecs,
  trackedImplementationTasksByPrd,
  remoteLaneStates,
  currentPrds,
  currentTasks,
  currentPrs,
  currentBranchLocks,
  now,
  fetchedRef,
}: AnyRecord) {
  const currentPrdById = new Map((currentPrds || []).map((prd) => [prd.id, prd]));
  const currentTasksByPrId = new Map();
  (currentTasks || []).forEach((task) => {
    if (!task || !task.prId) {
      return;
    }
    const tasks = currentTasksByPrId.get(task.prId) || [];
    tasks.push(task);
    currentTasksByPrId.set(task.prId, tasks);
  });
  const currentReviewerTaskByPrId = new Map<string, TaskRecord>(
    (currentTasks || [])
      .filter((task) => task && task.type === TASK_TYPES.REVIEW && task.prId)
      .map((task) => [task.prId, task])
  );
  const currentBranchLockByLane = new Map(
    (currentBranchLocks || [])
      .filter((lock) => lock && (lock.laneKey || (lock.prdId && lock.agentId)))
      .map((lock) => [normalizeLaneKey(lock), lock])
  );
  const currentPrByLane = new Map();
  const currentPrByRemoteNumber = new Map();
  (currentPrs || []).forEach((pr) => {
    const laneKey = normalizeLaneKey(pr);
    if (laneKey) {
      currentPrByLane.set(laneKey, pr);
    }
    if (pr && pr.remote && pr.remote.number) {
      currentPrByRemoteNumber.set(Number(pr.remote.number), pr);
    }
  });

  const derivedPrds = [];
  const derivedTasks = [];
  const derivedPullRequests = [];
  const derivedBranchLocks = [];
  const derivedTaskIds = new Set();
  const reconciledTaskIds = new Set();
  const importedPrdIds = new Set();
  const imported = [];
  const updated = [];
  const skipped = [];

  remoteSpecs.forEach((remoteSpec) => {
    const prdId = remoteSpec.spec.id;
    importedPrdIds.add(prdId);
    const laneStates = remoteLaneStates[prdId] || {};
    const plannedImplementationTasks = getPlannedImplementationTasksForPrd(remoteSpec, trackedImplementationTasksByPrd);
    const derivedPrd = buildDerivedPrdRecord({
      integrationBranch,
      config,
      sprint,
      remoteSpec,
      implementationTasks: plannedImplementationTasks,
      laneStates,
      now,
      fetchedRef,
    });
    const currentPrd = currentPrdById.get(prdId);
    if (!currentPrd) {
      imported.push(prdId);
    } else if (prdStateChanged(currentPrd, derivedPrd)) {
      updated.push(prdId);
    } else {
      skipped.push(prdId);
    }
    derivedPrds.push(derivedPrd);

    const groupedTasks = groupLaneTasksByAgent(plannedImplementationTasks);
    Object.keys(groupedTasks).forEach((agentId) => {
      const laneTasks = groupedTasks[agentId];
      const laneState = laneStates[agentId] || {
        branch: buildLaneBranchName(config, sprint, prdId, laneTasks[0]),
        commitCount: 0,
        merged: false,
        remote: null,
      };
      const laneKey = `${prdId}:${agentId}`;
      const existingPr = currentPrByRemoteNumber.get(Number(laneState.remote && laneState.remote.number))
        || currentPrByLane.get(laneKey)
        || null;
      const prId = existingPr ? existingPr.id : buildStablePullRequestId(laneKey);
      const existingBranchLock = currentBranchLockByLane.get(laneKey) || null;
      const laneTaskIds = new Set(laneTasks.map((task) => task.id));
      const remoteCompletedCount = countCompletedRemoteLaneTasks(laneTasks, laneState);
      const localCompletedCount = Math.max(
        countCompletedLaneTasks(existingBranchLock, laneTaskIds, laneTasks.length),
        countCompletedTaskIds(existingPr && existingPr.completedTaskIds, laneTaskIds, laneTasks.length)
      );
      const completedCount = Math.max(remoteCompletedCount, localCompletedCount);
      const completedTasks = laneTasks.slice(0, completedCount);
      const pendingTasks = laneTasks.slice(completedCount);
      const agentConfig = getAgentConfig(config, agentId);
      const branch = laneState.branch || buildLaneBranchName(config, sprint, prdId, laneTasks[0]);
      const linkedRuntimeTasks = currentTasksByPrId.get(prId) || [];
      const existingReviewerTask = currentReviewerTaskByPrId.get(prId) || null;

      laneTasks.forEach((task) => {
        reconciledTaskIds.add(task.id);
      });

      if (completedTasks.length > 0) {
        derivedBranchLocks.push({
          taskId: completedTasks[completedTasks.length - 1].id,
          laneKey,
          agentId,
          branch,
          worktreePath: buildLaneWorktreePath(rootDir, config, remoteSpec.spec.id, laneTasks[0]),
          baseBranch: integrationBranch,
          mode: 'remote-reconciled',
          updatedAt: now,
          completedTasks: completedTasks.map((task) => buildDerivedCompletedTaskSnapshot(task, prdId, integrationBranch, agentConfig, now)),
        });
      }

      if (laneState.remote || existingPr) {
        const derivedPr = buildDerivedPullRequestRecord({
          existingPr,
          existingReviewerTask,
          linkedRuntimeTasks,
          remoteSpec,
          laneTasks,
          laneState,
          completedTasks,
          pendingTasks,
          integrationBranch,
          agentConfig,
          now,
        });
        derivedPullRequests.push(derivedPr);
        const derivedPendingLinkedTaskIds = new Set();
        linkedRuntimeTasks.forEach((task) => {
          if (!task || task.type === TASK_TYPES.REVIEW) {
            return;
          }
          if (!derivedPendingLinkedTaskIds.has(task.id)) {
            reconciledTaskIds.add(task.id);
          }
        });
        uniqueStrings(
          ((existingPr && existingPr.pendingTaskIds) || []).filter((taskId) => !laneTaskIds.has(taskId))
        ).forEach((taskId) => {
          if (!derivedPendingLinkedTaskIds.has(taskId)) {
            reconciledTaskIds.add(taskId);
          }
        });
        if (pendingTasks.length === 0 || currentReviewerTaskByPrId.has(derivedPr.id)) {
          const reviewerTask = buildDerivedReviewerTask(
            derivedPr,
            laneTasks[laneTasks.length - 1],
            now,
            currentReviewerTaskByPrId.get(derivedPr.id) || null,
            linkedRuntimeTasks
          );
          derivedTaskIds.add(reviewerTask.id);
          derivedTasks.push(reviewerTask);
        }
      }
    });
  });

  return {
    importedPrdIds,
    imported,
    updated,
    skipped,
    derivedTaskIds,
    reconciledTaskIds,
    prds: derivedPrds,
    tasks: sortDerivedTasks(derivedTasks),
    pullRequests: derivedPullRequests,
    branchLocks: derivedBranchLocks,
  };
}

function buildDerivedPrdRecord({ integrationBranch, config, sprint, remoteSpec, implementationTasks, laneStates, now, fetchedRef }: AnyRecord) {
  const planningOnlySpec = requiresPmPlanning(remoteSpec.spec, implementationTasks);
  const groupedTasks = groupLaneTasksByAgent(implementationTasks || []);
  const completedTaskSpecIds = [];

  Object.keys(groupedTasks).forEach((agentId) => {
    const laneTasks = groupedTasks[agentId];
    const laneState = laneStates[agentId] || {
      commitCount: 0,
      merged: false,
    };
    const completedCount = countCompletedRemoteLaneTasks(laneTasks, laneState);
    completedTaskSpecIds.push(...laneTasks.slice(0, completedCount).map((task) => task.id));
  });

  let status = 'planned';
  if (planningOnlySpec && (!Array.isArray(implementationTasks) || implementationTasks.length === 0)) {
    status = 'queued';
  } else if (Object.keys(groupedTasks).length > 0 && Object.values(groupedTasks).every((laneTasks) => {
    const laneState = laneStates[laneTasks[0].agentId] || {};
    return Boolean(laneState.merged) || Math.min(Number(laneState.commitCount || 0), laneTasks.length) >= laneTasks.length;
  })) {
    status = 'completed';
  }

  const record: AnyRecord = {
    ...remoteSpec.spec,
    completedTaskSpecIds,
    remoteLaneStates: laneStates,
    status,
    planningOnlySpec,
    updatedAt: now,
    source: buildSourceMetadata(remoteSpec, fetchedRef, integrationBranch),
  };
  delete record.tasks;
  if (Array.isArray(implementationTasks) && implementationTasks.length > 0) {
    record.plannedTaskIds = implementationTasks.map((task) => task.id);
  } else {
    delete record.plannedTaskIds;
  }
  delete record.error;
  return record;
}

function buildDerivedCompletedTaskSnapshot(task, prdId, integrationBranch, agentConfig, now) {
  return {
    id: task.id,
    title: task.title,
    description: task.description || '',
    agentId: task.agentId,
    prdId,
    laneKey: `${prdId}:${task.agentId}`,
    type: TASK_TYPES.DEFAULT,
    sprintId: task.sprintId || 'shared',
    baseBranch: integrationBranch,
    checks: uniqueStrings([...(task.checks || []), ...((agentConfig && agentConfig.checks) || [])]),
    acceptance: normalizeStringList(task.acceptance),
    completedAt: now,
  };
}

function buildDerivedPullRequestRecord({
  existingPr,
  existingReviewerTask,
  linkedRuntimeTasks,
  remoteSpec,
  laneTasks,
  laneState,
  completedTasks,
  pendingTasks,
  integrationBranch,
  agentConfig,
  now,
}: AnyRecord): PullRequestRecord {
  const laneKey = `${remoteSpec.spec.id}:${laneTasks[0].agentId}`;
  const prId = buildStablePullRequestId(laneKey);
  const baseTaskIds = laneTasks.map((task) => task.id);
  const baseTaskIdSet = new Set(baseTaskIds);
  const checks = uniqueStrings(laneTasks.flatMap((task) => [
    ...(task.checks || []),
    ...((agentConfig && agentConfig.checks) || []),
  ]));
  const acceptance = uniqueStrings(laneTasks.flatMap((task) => task.acceptance || []));
  const source = buildLaneSourceSummary(remoteSpec.spec.id, laneTasks);
  const prForReviewState = {
    ...(existingPr || {}),
    commitCount: Number(laneState.commitCount || 0),
    remote: laneState.remote
      ? {
          ...laneState.remote,
          commitCount: Number(laneState.commitCount || 0),
        }
      : (existingPr && existingPr.remote)
        ? { ...existingPr.remote }
        : null,
  };
  const reviewerHasStaleCommitView = reviewedCommitCountIsStale(prForReviewState, existingReviewerTask);
  const linkedWorkTasks = (linkedRuntimeTasks || [])
    .filter((task) => task && task.type !== TASK_TYPES.REVIEW)
    .filter((task) => !(reviewerHasStaleCommitView && task.type === 'review_followup'));
  const extraTaskIds = uniqueStrings([
    ...((existingPr && existingPr.taskIds) || []).filter((taskId) => !baseTaskIdSet.has(taskId)),
    ...(linkedWorkTasks.map((task) => task.id)).filter((taskId) => !baseTaskIdSet.has(taskId)),
  ]);
  const extraPendingTaskIds = uniqueStrings([
    ...((existingPr && existingPr.pendingTaskIds) || []).filter((taskId) => !baseTaskIdSet.has(taskId)),
    ...(linkedWorkTasks
      .filter((task) => isPendingRuntimeTask(task))
      .map((task) => task.id))
      .filter((taskId) => !baseTaskIdSet.has(taskId)),
  ]).filter((taskId) => !(reviewerHasStaleCommitView && inferLinkedTaskType(taskId) === 'review_followup'));
  const extraCompletedTaskIds = uniqueStrings([
    ...((existingPr && existingPr.completedTaskIds) || []).filter((taskId) => !baseTaskIdSet.has(taskId)),
  ]);
  const reviews = Array.isArray(existingPr && existingPr.reviews)
    ? existingPr.reviews.map((decisionRecord) => ({ ...decisionRecord }))
    : [];
  const record: PullRequestRecord = {
    id: prId,
    taskId: existingPr && existingPr.taskId ? existingPr.taskId : laneTasks[0].id,
    laneKey,
    prdId: remoteSpec.spec.id,
    sprintId: laneTasks[0].sprintId || 'shared',
    agentId: laneTasks[0].agentId,
    sourceTitle: existingPr && existingPr.sourceTitle ? existingPr.sourceTitle : source.title,
    sourceBody: existingPr && existingPr.sourceBody ? existingPr.sourceBody : source.body,
    taskIds: uniqueStrings([...baseTaskIds, ...extraTaskIds]),
    completedTaskIds: uniqueStrings([...completedTasks.map((task) => task.id), ...extraCompletedTaskIds]),
    pendingTaskIds: uniqueStrings([...pendingTasks.map((task) => task.id), ...extraPendingTaskIds]),
    acceptance,
    checks,
    commitCount: Number(laneState.commitCount || 0),
    headBranch: laneState.branch || (existingPr && existingPr.headBranch) || null,
    baseBranch: integrationBranch,
    status: resolveDerivedPullRequestStatus(
      existingPr && existingPr.status,
      laneState,
      pendingTasks,
      extraPendingTaskIds,
      existingPr,
      existingReviewerTask
    ),
    reviews,
    createdAt: existingPr && existingPr.createdAt ? existingPr.createdAt : now,
    updatedAt: now,
    remote: laneState.remote ? {
      number: laneState.remote.number,
      url: laneState.remote.url,
      state: laneState.remote.state,
      mergedAt: laneState.remote.mergedAt,
      commitCount: Number(laneState.commitCount || 0),
    } : (existingPr && existingPr.remote) ? { ...existingPr.remote } : null,
    title: existingPr && existingPr.title ? existingPr.title : buildPersonaPrTitle(laneTasks[0].agentId, source.title),
    body: existingPr && existingPr.body ? existingPr.body : source.body,
  };
  if (Array.isArray(existingPr && existingPr.scopeViolations) && existingPr.scopeViolations.length > 0) {
    record.scopeViolations = existingPr.scopeViolations.map((violation) => ({ ...violation }));
  }
  if (Array.isArray(existingPr && existingPr.conflicts) && existingPr.conflicts.length > 0) {
    record.conflicts = existingPr.conflicts.map((conflict) => ({ ...conflict }));
  }
  if (existingPr && existingPr.conflict) {
    record.conflict = { ...existingPr.conflict };
  }
  return record;
}

function buildStablePullRequestId(laneKey) {
  return `pr-${slugify(laneKey || 'lane')}`;
}




function inferLinkedTaskType(taskId) {
  if (String(taskId || '').includes('-conflict-')) {
    return 'conflict_resolution';
  }
  return 'review_followup';
}


function buildDerivedReviewerTask(pr: PullRequestRecord, sourceTask: TaskRecord, now: string, existingTask: TaskRecord | null = null, linkedRuntimeTasks: TaskRecord[] = []) {
  const pendingLinkedTasks = linkedRuntimeTasks.filter((task) => task && task.type !== TASK_TYPES.REVIEW && isPendingRuntimeTask(task));
  const existingStatus = existingTask && existingTask.status ? existingTask.status : '';
  const reviewerHasStaleCommitView = reviewedCommitCountIsStale(pr, existingTask);
  const needsReviewerRecovery = approvedPrNeedsReviewerRecovery(pr, existingTask);
  let status = existingStatus || 'queued';
  if (pr.status === 'merged') {
    status = 'merged';
  } else if (reviewerHasStaleCommitView) {
    status = 'queued';
  } else if (pr.status === 'changes_requested' || pendingLinkedTasks.length > 0 || reviewerTaskIndicatesChangesRequested(existingTask)) {
    status = 'changes_requested';
  } else if ((pr.status === 'approved' || reviewerTaskIndicatesApproved(existingTask)) && needsReviewerRecovery) {
    status = 'queued';
  } else if (pr.status === 'approved' || reviewerTaskIndicatesApproved(existingTask)) {
    status = 'approved';
  }
  const record: TaskRecord = {
    id: `${getRoleLabel(AGENT_ROLES.REVIEW)}-${pr.id}`,
    title: `Review ${pr.title}`,
    description: `Review ${pr.id} for ${sourceTask.title}`,
    agentId: 'reviewer',
    type: TASK_TYPES.REVIEW,
    prId: pr.id,
    sourceTaskId: sourceTask.id,
    sourceAgentId: sourceTask.agentId,
    headBranch: pr.headBranch,
    baseBranch: pr.baseBranch,
    acceptance: pr.acceptance || [],
    reviewRound: reviewerHasStaleCommitView
      ? (pr.reviews || []).length + 1
      : existingTask && existingTask.reviewRound
        ? existingTask.reviewRound
        : (pr.reviews || []).length + 1,
    status,
    createdAt: existingTask && existingTask.createdAt ? existingTask.createdAt : now,
    updatedAt: now,
  };
  if (existingTask && existingTask.reviewedAt) {
    record.reviewedAt = existingTask.reviewedAt;
  }
  if (existingTask && existingTask.lastDecision) {
    record.lastDecision = existingTask.lastDecision;
  }
  if (existingTask && existingTask.lastError) {
    record.lastError = existingTask.lastError;
  }
  if (existingTask && Number.isFinite(Number(existingTask.reviewedCommitCount))) {
    record.reviewedCommitCount = Number(existingTask.reviewedCommitCount);
  }
  if (existingTask && existingTask.lastMergeFailureMessage) {
    record.lastMergeFailureMessage = existingTask.lastMergeFailureMessage;
  }
  if (existingTask && existingTask.dispatcher) {
    record.dispatcher = existingTask.dispatcher;
  }
  if (existingTask && existingTask.dispatchedAt) {
    record.dispatchedAt = existingTask.dispatchedAt;
  }
  return record;
}

function reviewedCommitCountIsStale(pr, existingTask) {
  const currentCommitCount = getPrCommitCount(pr);
  const reviewedCommitCount = Number(existingTask && existingTask.reviewedCommitCount);
  if (!Number.isFinite(currentCommitCount) || currentCommitCount <= 0) {
    return false;
  }
  if (!Number.isFinite(reviewedCommitCount) || reviewedCommitCount <= 0) {
    return false;
  }
  return currentCommitCount > reviewedCommitCount;
}

function approvedPrNeedsReviewerRecovery(pr, existingTask) {
  if (!prIsApprovedAndOpen(pr) || !existingTask) {
    return false;
  }
  return new RegExp(`${getRoleLabel(AGENT_ROLES.REVIEW)} worker exited before completion`, 'i')
    .test(String(existingTask.lastError || ''));
}

function prIsApprovedAndOpen(pr) {
  if (!pr) {
    return false;
  }
  if (String(pr.status || '') !== 'approved') {
    return false;
  }
  if (pr.remote && pr.remote.mergedAt) {
    return false;
  }
  return !pr.remote || String(pr.remote.state || 'open') === 'open';
}

function getPrCommitCount(pr) {
  const count = Number(pr && (pr.commitCount || (pr.remote && pr.remote.commitCount)));
  return Number.isFinite(count) ? count : 0;
}

function resolveDerivedPullRequestStatus(existingStatus, laneState, pendingTasks, pendingExtraTaskIds, existingPr, existingReviewerTask) {
  if (laneState && laneState.merged) {
    return 'merged';
  }
  if ((pendingTasks || []).length > 0) {
    return 'building';
  }
  if ((pendingExtraTaskIds || []).length > 0) {
    return 'changes_requested';
  }
  if (existingStatus === 'conflicted') {
    return 'conflicted';
  }
  if (existingStatus === 'changes_requested'
    || reviewDecisionIsChangesRequested(findLatestReview(existingPr))
    || reviewerTaskIndicatesChangesRequested(existingReviewerTask)) {
    return 'changes_requested';
  }
  if (existingStatus === 'approved'
    || reviewDecisionIsApproved(findLatestReview(existingPr))
    || reviewerTaskIndicatesApproved(existingReviewerTask)) {
    return 'approved';
  }
  if (['changes_requested', 'approved', 'conflicted', 'building', 'open'].includes(existingStatus)) {
    return existingStatus;
  }
  return 'open';
}

function findLatestReview(pr) {
  if (!pr || !Array.isArray(pr.reviews) || pr.reviews.length === 0) {
    return null;
  }
  return pr.reviews[pr.reviews.length - 1];
}



function stringListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function reviewDecisionIsChangesRequested(decisionRecord) {
  return Boolean(decisionRecord && decisionRecord.decision === 'changes_requested');
}

function reviewDecisionIsApproved(decisionRecord) {
  return Boolean(decisionRecord && decisionRecord.decision === 'approved');
}

function reviewerTaskIndicatesChangesRequested(task) {
  return Boolean(task && (task.status === 'changes_requested' || task.lastDecision === 'changes_requested'));
}

function reviewerTaskIndicatesApproved(task) {
  return Boolean(task && (task.status === 'approved' || task.lastDecision === 'approved'));
}

function countCompletedLaneTasks(branchLock, laneTaskIds, maxCount) {
  if (!branchLock || !Array.isArray(branchLock.completedTasks)) {
    return 0;
  }
  return Math.min(
    maxCount,
    branchLock.completedTasks.filter((task) => task && laneTaskIds.has(task.id)).length
  );
}

function countCompletedTaskIds(taskIds, laneTaskIds, maxCount) {
  if (!Array.isArray(taskIds)) {
    return 0;
  }
  return Math.min(
    maxCount,
    taskIds.filter((taskId) => laneTaskIds.has(taskId)).length
  );
}

function isPendingRuntimeTask(task) {
  if (!task) {
    return false;
  }
  return !['approved', 'merged'].includes(String(task.status || ''));
}

function prdStateChanged(currentPrd, nextPrd) {
  return JSON.stringify([
    currentPrd && currentPrd.title,
    currentPrd && currentPrd.status,
    currentPrd && currentPrd.completedTaskSpecIds || [],
    currentPrd && currentPrd.plannedTaskIds || [],
    currentPrd && currentPrd.remoteLaneStates || {},
    currentPrd && currentPrd.planningOnlySpec,
  ]) !== JSON.stringify([
    nextPrd.title,
    nextPrd.status,
    nextPrd.completedTaskSpecIds || [],
    nextPrd.plannedTaskIds || [],
    nextPrd.remoteLaneStates || {},
    nextPrd.planningOnlySpec,
  ]);
}

function groupLaneTasksByAgent(tasks: TaskRecord[]): Record<string, TaskRecord[]> {
  return (tasks || []).reduce<Record<string, TaskRecord[]>>((accumulator, task) => {
    const agentId = String(task && task.agentId || '').trim();
    if (!agentId) {
      return accumulator;
    }
    if (!accumulator[agentId]) {
      accumulator[agentId] = [];
    }
    accumulator[agentId].push(task);
    return accumulator;
  }, {});
}

function getAgentConfig(config, agentId) {
  return (config.agents || []).find((agent) => agent.id === agentId) || null;
}

function buildLaneWorktreePath(rootDir, config, prdId, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const laneSegment = slugify(`${prdId}:${task.agentId}`);
  return path.join(rootDir, config.worktreesRoot || '.autonomy/worktrees', task.agentId, `${sprintSegment}-${laneSegment}`);
}

function buildLaneSourceSummary(prdId, laneTasks) {
  if (!Array.isArray(laneTasks) || laneTasks.length === 0) {
    return {
      title: prdId,
      body: '',
    };
  }
  return {
    title: `${laneTasks[0].agentId.replace(/-agent$/, '')} lane work for ${prdId}`,
    body: `Lane task ids: ${laneTasks.map((task) => task.id).join(', ')}`,
  };
}




function isImportedPrdRecord(record, importedPrdIds) {
  const laneKey = normalizeLaneKey(record);
  if (record && record.prdId && importedPrdIds.has(record.prdId)) {
    return true;
  }
  if (!laneKey) {
    return false;
  }
  return importedPrdIds.has(laneKey.split(':')[0]);
}

function normalizeLaneKey(record) {
  if (!record) {
    return '';
  }
  if (record.laneKey) {
    return String(record.laneKey);
  }
  if (record.prdId && record.agentId) {
    return `${record.prdId}:${record.agentId}`;
  }
  return '';
}

function sortDerivedTasks(tasks) {
  return tasks.slice().sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

function uniqueStrings(values) {
  const seen = new Set();
  return (values || []).reduce((accumulator, value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      return accumulator;
    }
    seen.add(normalized);
    accumulator.push(normalized);
    return accumulator;
  }, []);
}

function buildPersonaPrTitle(agentId, title) {
  return `[${agentId}] ${String(title || '').trim()}`;
}

function remoteBranchExists(rootDir, branch) {
  try {
    const output = readGit(rootDir, gitAuthArgs().concat(['ls-remote', '--heads', 'origin', branch]), {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    return Boolean(output);
  } catch (_) {
    return false;
  }
}

function countRemoteBranchCommits(rootDir, baseBranch, branch) {
  const tempRef = `refs/autonomy-sync/${sanitizeFileSegment(branch)}`;
  const baseRef = gitRefExists(rootDir, `origin/${baseBranch}`)
    ? `origin/${baseBranch}`
    : baseBranch;
  try {
    runGit(rootDir, gitAuthArgs().concat(['fetch', '--no-tags', 'origin', `${branch}:${tempRef}`]), {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    return Number(readGit(rootDir, ['rev-list', '--count', `${baseRef}..${tempRef}`]) || '0');
  } finally {
    try {
      runGit(rootDir, ['update-ref', '-d', tempRef]);
    } catch (_) {
      // Best-effort cleanup of the temporary sync ref.
    }
  }
}

function readRemoteImplementationQueueState(rootDir, config, integrationBranch, branch, agentId) {
  const agent = getAgentConfig(config, agentId) || null;
  const relativePath = agent && agent.taskQueue;
  if (!relativePath) {
    return null;
  }
  if (path.isAbsolute(relativePath)) {
    return null;
  }
  const tempRef = `refs/autonomy-sync/${sanitizeFileSegment(agentId)}-${sanitizeFileSegment(branch)}`;
  const baseRef = gitRefExists(rootDir, `origin/${integrationBranch}`)
    ? `origin/${integrationBranch}`
    : integrationBranch;
  try {
    runGit(rootDir, gitAuthArgs().concat(['fetch', '--no-tags', 'origin', `${branch}:${tempRef}`]), {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    return {
      commitCount: Number(readGit(rootDir, ['rev-list', '--count', `${baseRef}..${tempRef}`]) || '0'),
      queueState: readJsonFromGitRef(rootDir, tempRef, relativePath, null),
    };
  } catch (_) {
    return null;
  } finally {
    try {
      runGit(rootDir, ['update-ref', '-d', tempRef]);
    } catch (_) {
      // Best-effort cleanup of the temporary sync ref.
    }
  }
}

function countCompletedRemoteLaneTasks(laneTasks: TaskRecord[], laneState: AnyRecord) {
  if (laneState && laneState.merged) {
    return laneTasks.length;
  }
  const queueTasksById = new Map<string, TaskRecord>(
    (((laneState && laneState.queueState) || {}).tasks || []).map((task) => [task.id, task])
  );
  if (queueTasksById.size > 0) {
    return laneTasks.filter((task) => {
      const queueTask = queueTasksById.get(task.id);
      return String((queueTask && (queueTask.state || queueTask.status)) || '') === 'done';
    }).length;
  }
  return Math.max(0, Math.min(Number((laneState && laneState.commitCount) || 0), laneTasks.length));
}

function getPullRequest(repo: AnyRecord, token: string, prNumber: number) {
  return githubRequest(repo, token, 'GET', `/pulls/${encodeURIComponent(String(prNumber))}`);
}

function compareBranchToBase(repo: AnyRecord, token: string, baseBranch: string, headBranch: string) {
  try {
    return githubRequest(
      repo,
      token,
      'GET',
      `/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}`
    );
  } catch (_) {
    return null;
  }
}


function buildImportedSpecState(remoteSpec, fetchedRef) {
  return {
    prdId: remoteSpec.spec.id,
    blobSha: remoteSpec.blobSha,
    fetchedRef: fetchedRef || null,
  };
}

function buildSourceMetadata(remoteSpec, fetchedRef, integrationBranch) {
  return {
    type: 'integration-branch',
    branch: integrationBranch,
    path: remoteSpec.relativePath,
    blobSha: remoteSpec.blobSha,
    fetchedRef: fetchedRef || null,
    syncedAt: new Date().toISOString(),
  };
}

function buildLaneBranchName(config, sprint, prdId, task) {
  const prefix = (config.branchPrefixes && config.branchPrefixes.task) || 'agent';
  const sprintSegment = slugify(task.sprintId || sprint.sprintId || 'shared');
  const agentSegment = slugify(task.agentId);
  const laneSegment = slugify(`${prdId}:${task.agentId}`);
  return `${prefix}/${sprintSegment}/${agentSegment}/${laneSegment}`;
}

function ensureControlWorktree(rootDir, integrationBranch, controlWorktree) {
  const fetchResult = fetchIntegrationBranch(rootDir, integrationBranch);
  const baseRef = fetchResult.ref || integrationBranch;
  const attachLocalBranch = fetchResult.ref === integrationBranch && !gitRemoteExists(rootDir, 'origin');
  ensureDir(path.dirname(controlWorktree));

  if (!fs.existsSync(controlWorktree)) {
    if (attachLocalBranch) {
      runGitWorktreeAdd(rootDir, [controlWorktree, integrationBranch], controlWorktree);
    } else {
      runGitWorktreeAdd(rootDir, ['--detach', controlWorktree, baseRef], controlWorktree);
    }
  } else {
    if (!isGitWorktree(controlWorktree)) {
      throw new Error(`Control worktree path "${controlWorktree}" exists but is not a git worktree.`);
    }
    runGit(controlWorktree, ['reset', '--hard', baseRef]);
    runGit(controlWorktree, ['clean', '-fd']);
  }

  return controlWorktree;
}

function fetchIntegrationBranch(rootDir: string, integrationBranch: string, options: AnyRecord = {}) {
  const result: AnyRecord = {
    ref: null,
    commitSha: null,
    message: '',
  };
  let remoteFetchSucceeded = false;

  if (gitRemoteExists(rootDir, 'origin')) {
    try {
      emitSyncProgress(options, 'sync:fetch:remote:start', {
        remote: 'origin',
        integrationBranch,
      });
      runGit(rootDir, gitAuthArgs().concat(['fetch', 'origin', integrationBranch]), {
        timeoutMs: GIT_NETWORK_TIMEOUT_MS,
      });
      remoteFetchSucceeded = true;
      emitSyncProgress(options, 'sync:fetch:remote:done', {
        remote: 'origin',
        integrationBranch,
      });
    } catch (error) {
      result.message = extractExecError(error);
      emitSyncProgress(options, 'sync:fetch:remote:error', {
        remote: 'origin',
        integrationBranch,
        message: result.message,
      });
    }
  }

  if (gitRefExists(rootDir, `origin/${integrationBranch}`)) {
    result.ref = `origin/${integrationBranch}`;
  } else if (gitRefExists(rootDir, integrationBranch)) {
    result.ref = integrationBranch;
  }

  if (result.ref) {
    result.commitSha = readGit(rootDir, ['rev-parse', result.ref]);
  }

  if (remoteFetchSucceeded && result.ref === `origin/${integrationBranch}`) {
    emitSyncProgress(options, 'sync:fetch:align:start', {
      integrationBranch,
      remoteRef: result.ref,
    });
    const alignment = alignLocalIntegrationBranch(rootDir, integrationBranch, result.ref);
    if (alignment.message) {
      result.message = result.message
        ? `${result.message}; ${alignment.message}`
        : alignment.message;
    }
    emitSyncProgress(options, 'sync:fetch:align:done', {
      integrationBranch,
      remoteRef: result.ref,
      message: alignment.message || '',
      changed: alignment.changed ? 'yes' : 'no',
    });
  }

  return result;
}

function alignLocalIntegrationBranch(rootDir, integrationBranch, remoteRef) {
  try {
    const remoteSha = readGit(rootDir, ['rev-parse', remoteRef]);
    const localExists = gitRefExists(rootDir, integrationBranch);

    if (!localExists) {
      runGit(rootDir, ['branch', integrationBranch, remoteRef]);
      return {
        changed: true,
        message: `created local ${integrationBranch} at ${remoteSha.slice(0, 12)}`,
      };
    }

    const localSha = readGit(rootDir, ['rev-parse', integrationBranch]);
    if (localSha === remoteSha) {
      return {
        changed: false,
        message: '',
      };
    }

    if (!gitIsAncestor(rootDir, integrationBranch, remoteRef)) {
      return {
        changed: false,
        message: '',
      };
    }

    const currentBranch = readGit(rootDir, ['branch', '--show-current']);
    if (currentBranch === integrationBranch) {
      if (!gitWorkingTreeClean(rootDir)) {
        return {
          changed: false,
          message: '',
        };
      }
      runGit(rootDir, ['merge', '--ff-only', remoteRef]);
      return {
        changed: true,
        message: `fast-forwarded local ${integrationBranch} to ${remoteSha.slice(0, 12)}`,
      };
    }

    runGit(rootDir, ['branch', '-f', integrationBranch, remoteRef]);
    return {
      changed: true,
      message: `updated local ${integrationBranch} to ${remoteSha.slice(0, 12)}`,
    };
  } catch (_) {
    return {
      changed: false,
      message: '',
    };
  }
}

function parsePrdSpec(rawContent: string, sourcePath: string): PrdSpecPayload {
  let parsed: AnyRecord;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourcePath}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`PRD spec ${sourcePath} must be a JSON object.`);
  }
  if (!parsed.id || !parsed.title) {
    throw new Error(`PRD spec ${sourcePath} must include id and title.`);
  }

  return buildPrdSpecPayload({
    id: parsed.id,
    title: parsed.title,
    tasks: parsed.tasks,
    createdAt: parsed.createdAt,
    specification: parsed.specification,
    requirements: parsed.requirements,
  });
}

function normalizeTaskSpecs(taskSpecs: AnyRecord[], options: AnyRecord = {}) {
  if (!Array.isArray(taskSpecs) || taskSpecs.length === 0) {
    if (options.allowEmpty === true) {
      return [];
    }
    throw new Error('PRD spec must include at least one task.');
  }

  return taskSpecs.map((task, index) => {
    if (!task || typeof task !== 'object') {
      throw new Error(`Task spec at index ${index} must be an object.`);
    }
    if (!task.id || !task.title || !task.agentId) {
      throw new Error(`Task spec at index ${index} must include id, title, and agentId.`);
    }
    return {
      id: String(task.id),
      title: String(task.title),
      agentId: String(task.agentId),
      description: typeof task.description === 'string' ? task.description : '',
      acceptance: sanitizeTaskAcceptance(task.acceptance, task.id),
      sprintId: task.sprintId ? String(task.sprintId) : undefined,
    };
  }).map((task) => {
    if (!task.sprintId) {
      delete task.sprintId;
    }
    return task;
  });
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function sanitizeTaskAcceptance(value, taskId) {
  const acceptance = normalizeStringList(value)
    .filter((entry) => !isProcessAcceptance(entry));
  if (acceptance.length > 0) {
    return acceptance;
  }
  return [`Task \`${taskId}\` is complete within the assigned agent scope.`];
}

function isProcessAcceptance(value) {
  return /(reflog|origin\/|merge-base|created from|branch|commit)/i.test(String(value || ''));
}

function requiresPmPlanning(spec, implementationTasks = []) {
  const hasPlanningInput = Boolean(spec && typeof spec.specification === 'string' && spec.specification.trim())
    || (Array.isArray(spec && spec.requirements) && spec.requirements.some((entry) => String(entry || '').trim()));
  if (Array.isArray(implementationTasks) && implementationTasks.length > 0) {
    return false;
  }
  return hasPlanningInput && (!Array.isArray(spec.tasks) || spec.tasks.length === 0);
}

function buildPrdSpecRelativePath(prdId: string, options: AnyRecord = {}) {
  const segments = [...AUTONOMY_SEGMENTS, 'specs', 'prds'];
  if (options.queue) {
    segments.push('queue');
  }
  segments.push(`${sanitizeFileSegment(prdId)}.json`);
  return path.join(...segments);
}

function buildPrdStateRelativePath(prdId) {
  return path.join(PRD_STATE_DIR, `${sanitizeFileSegment(prdId)}.json`);
}

function buildPrdStatePayload({ prdId, status, plannedTaskIds, lastError, createdAt, updatedAt }: AnyRecord): PrdStateRecord {
  const payload: PrdStateRecord = {
    schemaVersion: 1,
    prdId: String(prdId),
    status: String(status || '').trim(),
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: updatedAt || new Date().toISOString(),
  };
  const planned = normalizeStringList(plannedTaskIds);
  if (planned.length > 0) {
    payload.plannedTaskIds = planned;
  }
  if (typeof lastError === 'string' && lastError.trim()) {
    payload.lastError = lastError.trim();
  }
  return payload;
}

function parsePrdState(rawContent: string, sourcePath: string): PrdStateRecord {
  let parsed: AnyRecord;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourcePath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`PRD state ${sourcePath} must be a JSON object.`);
  }
  if (!parsed.prdId) {
    throw new Error(`PRD state ${sourcePath} must include prdId.`);
  }
  if (!['planning', 'planned', 'failed'].includes(String(parsed.status || ''))) {
    throw new Error(`PRD state ${sourcePath} must include a valid status.`);
  }
  return buildPrdStatePayload({
    prdId: parsed.prdId,
    status: parsed.status,
    plannedTaskIds: parsed.plannedTaskIds,
    lastError: parsed.lastError,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  });
}

function resolveTrackedRef(rootDir, integrationBranch) {
  const remoteRef = `origin/${integrationBranch}`;
  if (gitRefExists(rootDir, remoteRef)) {
    return remoteRef;
  }
  if (gitRefExists(rootDir, integrationBranch)) {
    return integrationBranch;
  }
  return null;
}

function listTrackedPrdSpecs(rootDir, integrationBranch) {
  const ref = resolveTrackedRef(rootDir, integrationBranch);
  if (!ref) {
    return [];
  }

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
  const specs = [];
  const seenPrdIds = new Set();
  allSpecCandidates.forEach((candidate) => {
    const spec = parsePrdSpec(readTreeFile(rootDir, ref, candidate.filePath), candidate.filePath);
    if (seenPrdIds.has(spec.id)) {
      return;
    }
    seenPrdIds.add(spec.id);
    specs.push({
      spec,
      isQueued: candidate.isQueued,
      relativePath: candidate.filePath,
      ref,
    });
  });
  return specs;
}

function readTrackedPrdStateMap(rootDir, integrationBranch) {
  const ref = resolveTrackedRef(rootDir, integrationBranch);
  const states = new Map();
  if (!ref) {
    return states;
  }
  const stateFiles = listTreeFiles(rootDir, ref, PRD_STATE_DIR)
    .filter((filePath) => filePath.endsWith('.json'));
  stateFiles.forEach((relativePath) => {
    const state = parsePrdState(readTreeFile(rootDir, ref, relativePath), relativePath);
    states.set(state.prdId, state);
  });
  return states;
}

function commitTrackedPrdStateToIntegrationBranch(rootDir, integrationBranch, prdState, options = {}) {
  const payload = buildPrdStatePayload(prdState);
  return commitTrackedFilesToIntegrationBranch(rootDir, integrationBranch, [{
    relativePath: buildPrdStateRelativePath(payload.prdId),
    content: payload,
  }], options);
}

function deleteTrackedPrdStateFromIntegrationBranch(rootDir, integrationBranch, prdId, options = {}) {
  return commitTrackedFilesToIntegrationBranch(rootDir, integrationBranch, [{
    relativePath: buildPrdStateRelativePath(prdId),
    delete: true,
  }], options);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function sanitizeFileSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function listTreeFiles(rootDir, ref, prefix) {
  try {
    const output = readGit(rootDir, ['ls-tree', '-r', '--name-only', ref, '--', prefix]);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function readTreeFile(rootDir, ref, relativePath) {
  return execFileSync('git', ['show', `${ref}:${relativePath}`], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitHasStagedChanges(cwd) {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], {
      cwd,
      stdio: 'ignore',
    });
    return false;
  } catch (_) {
    return true;
  }
}

function gitRemoteExists(rootDir, remoteName) {
  try {
    execFileSync('git', ['remote', 'get-url', remoteName], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function gitRefExists(rootDir, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function gitIsAncestor(rootDir, olderRef, newerRef) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', olderRef, newerRef], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function gitWorkingTreeClean(rootDir) {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trim().length === 0;
  } catch (_) {
    return false;
  }
}

function isGitWorktree(worktreePath) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function configureGitIdentity(cwd, gitIdentity) {
  if (!gitIdentity) {
    return;
  }
  runGit(cwd, ['config', 'extensions.worktreeConfig', 'true']);
  if (gitIdentity.name) {
    runGit(cwd, ['config', '--worktree', 'user.name', gitIdentity.name]);
  }
  if (gitIdentity.email) {
    runGit(cwd, ['config', '--worktree', 'user.email', gitIdentity.email]);
  }
}

function gitAuthArgs() {
  const githubToken = resolveGithubAuthToken();
  if (!githubToken) {
    return [];
  }
  const authHeader = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  return ['-c', `http.extraHeader=AUTHORIZATION: basic ${authHeader}`];
}

function runGit(rootDir: string, args: string[], options: AnyRecord = {}) {
  const execOptions: any = {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (options.timeoutMs) {
    execOptions.timeout = Number(options.timeoutMs);
  }
  execFileSync('git', args, execOptions);
}

function runGitWorktreeAdd(rootDir, args, worktreePath, options = {}) {
  try {
    runGit(rootDir, ['worktree', 'add', ...args], options);
  } catch (error) {
    const message = extractExecError(error);
    if (!fs.existsSync(worktreePath) && message.includes('missing but already registered worktree')) {
      pruneStaleWorktrees(rootDir);
      runGit(rootDir, ['worktree', 'add', ...args], options);
      return;
    }
    throw error;
  }
}

function pruneStaleWorktrees(rootDir) {
  try {
    runGit(rootDir, ['worktree', 'prune', '--expire', 'now']);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function readGit(rootDir: string, args: string[], options: AnyRecord = {}) {
  const execOptions: any = {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (options.timeoutMs) {
    execOptions.timeout = Number(options.timeoutMs);
  }
  return execFileSync('git', args, execOptions).trim();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson<T = any>(filePath: string, fallbackValue?: T): T {
  if (!fs.existsSync(filePath)) {
    return JSON.parse(JSON.stringify(fallbackValue)) as T;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function extractExecError(error) {
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return error.message;
}

function resolveGithubRepo(rootDir: string) {
  const remoteUrl = readGit(rootDir, ['config', '--get', 'remote.origin.url']);

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.hostname === 'github.com') {
      const trimmedPath = parsedUrl.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
      const segments = trimmedPath.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return {
          owner: segments[0],
          repo: segments.slice(1).join('/'),
        };
      }
    }
  } catch (error) {
    // Fall back to regex parsing for non-URL formats.
  }

  const httpsMatch = remoteUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
    };
  }

  throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
}

function listPullRequestsByHead(repo: AnyRecord, token: string, baseBranch: string, headBranch: string) {
  return githubRequest(
    repo,
    token,
    'GET',
    `/pulls?state=all&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(`${repo.owner}:${headBranch}`)}&per_page=100`
  );
}

function githubRequest(repo, token, method, endpoint) {
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo.owner}/${repo.repo}${endpoint}`,
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'autonomy-v2-sync',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };

  const response = execHttpRequest(options);
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return response.payload;
  }
  throw new Error(`GitHub API ${response.statusCode}: ${response.payload.message || response.raw}`);
}

function execHttpRequest(options: AnyRecord): HttpResponse {
  const result: HttpResponse = {
    statusCode: 0,
    payload: {},
    raw: '',
  };

  const response = execFileSync(process.execPath, ['-e', buildHttpClientScript()], {
    cwd: __dirname,
    env: {
      ...process.env,
      AUTONOMY_HTTP_OPTIONS: JSON.stringify(options),
      AUTONOMY_HTTP_BODY: '',
      AUTONOMY_HTTP_TIMEOUT_MS: String(HTTP_REQUEST_TIMEOUT_MS),
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: HTTP_REQUEST_TIMEOUT_MS + 2000,
  }).trim();

  if (response) {
    const parsed = JSON.parse(response) as AnyRecord;
    result.statusCode = parsed.statusCode;
    result.payload = parsed.payload;
    result.raw = parsed.raw;
  }
  return result;
}

function buildHttpClientScript() {
  return `
import https from 'https';
const options = JSON.parse(process.env.AUTONOMY_HTTP_OPTIONS) as AnyRecord;
const timeoutMs = Number(process.env.AUTONOMY_HTTP_TIMEOUT_MS || '15000');
const req = https.request(options, (res) => {
  let raw = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => {
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) as AnyRecord : {};
    } catch (_) {}
    process.stdout.write(JSON.stringify({ statusCode: res.statusCode, payload, raw }));
  });
});
req.on('error', (error) => {
  process.stderr.write(error.message);
  process.exit(1);
});
req.setTimeout(timeoutMs, () => {
  req.destroy(new Error(\`HTTP request timed out after \${timeoutMs}ms\`));
});
req.end();
`;
}


export { DEFAULT_SYNC_STATE };
export { PRD_SPECS_DIR };
export { buildPrdSpecPayload };
export { buildPrdStateRelativePath };
export { commitPrdSpecToIntegrationBranch };
export { commitTrackedPrdStateToIntegrationBranch };
export { commitTrackedFilesToIntegrationBranch };
export { deleteTrackedPrdStateFromIntegrationBranch };
export { getSyncPaths };
export { hasActivePrdSpecInIntegrationBranch };
export { hasPrdSpecInIntegrationBranch };
export { listTrackedPrdSpecs };
export { readTrackedPrdStateMap };
export { syncPrdSpecsFromIntegrationBranch };
export default {
  DEFAULT_SYNC_STATE,
  PRD_SPECS_DIR,
  buildPrdSpecPayload,
  buildPrdStateRelativePath,
  commitPrdSpecToIntegrationBranch,
  commitTrackedPrdStateToIntegrationBranch,
  commitTrackedFilesToIntegrationBranch,
  deleteTrackedPrdStateFromIntegrationBranch,
  getSyncPaths,
  hasActivePrdSpecInIntegrationBranch,
  hasPrdSpecInIntegrationBranch,
  listTrackedPrdSpecs,
  readTrackedPrdStateMap,
  syncPrdSpecsFromIntegrationBranch
};
