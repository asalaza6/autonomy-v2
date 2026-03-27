import fs from 'fs';
import path from 'path';
import type { AnyRecord } from './types.js';
import { AUTONOMY_SEGMENTS, RUNTIME_SEGMENTS } from './constants.js';

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

export {
  emitSyncProgress,
  ensureDir,
  getSyncPaths,
  readJson,
  writeJson,
};
