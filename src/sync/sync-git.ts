import fs from 'fs';
import path from 'path';
import type { AnyRecord } from './sync-types.js';
import { GIT_NETWORK_TIMEOUT_MS, PRD_ARCHIVE_DIR, PRD_QUEUE_DIR, PRD_SPECS_DIR, PRD_STATE_DIR } from './sync-constants.js';
import { emitSyncProgress, ensureDir, getSyncPaths } from './core.js';
import {
  configureGitIdentity,
  extractExecError,
  gitAuthArgs,
  gitHasStagedChanges,
  gitIsAncestor,
  gitRefExists,
  gitRemoteExists,
  gitWorkingTreeClean,
  isGitWorktree,
  listTreeFiles,
  readGit,
  readTreeFile,
  runGit,
  runGitWorktreeAdd,
} from './git-shared.js';
import {
  buildPrdSpecPayload,
  buildPrdSpecRelativePath,
  buildPrdStatePayload,
  buildPrdStateRelativePath,
  parsePrdSpec,
  parsePrdState,
} from './sync-prd.js';

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
      path.posix.join(...PRD_SPECS_DIR.split('/').slice(0, -1), 'prds'),
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

function ensureControlWorktree(rootDir, integrationBranch, controlWorktree) {
  const fetchResult = fetchIntegrationBranch(rootDir, integrationBranch);
  const baseRef = fetchResult.ref || integrationBranch;
  ensureDir(path.dirname(controlWorktree));

  if (!fs.existsSync(controlWorktree)) {
    runGitWorktreeAdd(rootDir, ['--detach', controlWorktree, baseRef], controlWorktree);
  } else {
    if (!isGitWorktree(controlWorktree)) {
      throw new Error(`Control worktree path "${controlWorktree}" exists but is not a git worktree.`);
    }
    runGit(controlWorktree, ['reset', '--hard', baseRef]);
    runGit(controlWorktree, ['clean', '-fd']);
  }

  return controlWorktree;
}

function updateLocalIntegrationBranchRef(rootDir, integrationBranch, commitSha) {
  runGit(rootDir, ['update-ref', `refs/heads/${integrationBranch}`, commitSha]);
}

function commitPrdSpecToIntegrationBranch(rootDir: string, integrationBranch: string, prdSpec: AnyRecord, options: AnyRecord = {}) {
  const normalizedSpec = buildPrdSpecPayload(prdSpec);
  const relativeSpecPath = buildPrdSpecRelativePath(normalizedSpec.id, {
    queue: Boolean(options.queueSpec),
  });
  const paths = getSyncPaths(rootDir);
  const controlWorktree = ensureControlWorktree(rootDir, integrationBranch, paths.controlWorktree);
  configureGitIdentity(controlWorktree, options.gitIdentity);
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
    updateLocalIntegrationBranchRef(rootDir, integrationBranch, commitSha);
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

  const pathsToAdd = normalizedUpdates
    .map((entry) => {
      if (entry.delete !== true) {
        return entry.relativePath;
      }
      try {
        const tracked = readGit(controlWorktree, ['ls-files', '--error-unmatch', '--', entry.relativePath]).trim();
        return tracked.length > 0 ? entry.relativePath : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (pathsToAdd.length === 0) {
    return {
      integrationBranch,
      controlWorktree,
      paths: [],
      committed: false,
      pushed: false,
      commitSha: readGit(controlWorktree, ['rev-parse', 'HEAD']),
    };
  }

  runGit(controlWorktree, ['add', '--all', '--', ...pathsToAdd]);
  if (!gitHasStagedChanges(controlWorktree)) {
    return {
      integrationBranch,
      controlWorktree,
      paths: pathsToAdd,
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
    updateLocalIntegrationBranchRef(rootDir, integrationBranch, commitSha);
    pushMessage = 'origin remote not configured; committed locally only';
  }

  return {
    integrationBranch,
    controlWorktree,
    paths: pathsToAdd,
    committed: true,
    pushed,
    pushMessage,
    commitSha,
  };
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
      return { changed: true, message: `created local ${integrationBranch} at ${remoteSha.slice(0, 12)}` };
    }

    const localSha = readGit(rootDir, ['rev-parse', integrationBranch]);
    if (localSha === remoteSha) {
      return { changed: false, message: '' };
    }
    if (!gitIsAncestor(rootDir, integrationBranch, remoteRef)) {
      return { changed: false, message: '' };
    }

    const currentBranch = readGit(rootDir, ['branch', '--show-current']);
    if (currentBranch === integrationBranch) {
      if (!gitWorkingTreeClean(rootDir)) {
        return { changed: false, message: '' };
      }
      runGit(rootDir, ['merge', '--ff-only', remoteRef]);
      return { changed: true, message: `fast-forwarded local ${integrationBranch} to ${remoteSha.slice(0, 12)}` };
    }

    runGit(rootDir, ['branch', '-f', integrationBranch, remoteRef]);
    return { changed: true, message: `updated local ${integrationBranch} to ${remoteSha.slice(0, 12)}` };
  } catch (_) {
    return { changed: false, message: '' };
  }
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

function listArchivedPrdSpecs(rootDir, integrationBranch) {
  const ref = resolveTrackedRef(rootDir, integrationBranch);
  if (!ref) {
    return [];
  }

  const archiveSpecFiles = listTreeFiles(rootDir, ref, PRD_ARCHIVE_DIR)
    .filter((filePath) => filePath.endsWith('.json'));
  const specs = [];
  const seenPrdIds = new Set();
  archiveSpecFiles.forEach((filePath) => {
    const spec = parsePrdSpec(readTreeFile(rootDir, ref, filePath), filePath);
    if (seenPrdIds.has(spec.id)) {
      return;
    }
    seenPrdIds.add(spec.id);
    specs.push({
      spec,
      isQueued: false,
      relativePath: filePath,
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

export {
  
  commitPrdSpecToIntegrationBranch,
  commitTrackedFilesToIntegrationBranch,
  commitTrackedPrdStateToIntegrationBranch,
  
  fetchIntegrationBranch,
  hasActivePrdSpecInIntegrationBranch,
  hasPrdSpecInIntegrationBranch,
  listArchivedPrdSpecs,
  listTrackedPrdSpecs,
  readTrackedPrdStateMap,
  
};
