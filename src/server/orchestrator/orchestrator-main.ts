import {
  extractExecError as extractExecErrorFromGit,
} from './orchestrator-git.js';
import {
  getPaths as getPathsFromPaths,
  resolveRootDir as resolveRootDirFromPaths,
  writeJson as writeJsonFromPaths,
} from './paths.js';
import { loadRuntime as loadRuntimeFromState } from './orchestrator-state.js';
import { runSchedulerTick as runSchedulerTickFromScheduler } from './scheduler.js';

function extractExecError(error: unknown) {
  return extractExecErrorFromGit(error);
}

function getPaths(rootDir: string) {
  return getPathsFromPaths(rootDir);
}

function resolveRootDir(rootDir: string) {
  return resolveRootDirFromPaths(rootDir);
}

function writeJson(filePath, payload) {
  return writeJsonFromPaths(filePath, payload);
}

function loadRuntime(rootDir: string) {
  return loadRuntimeFromState(rootDir);
}

function runSchedulerTick(rootDir: string, options = {}) {
  return runSchedulerTickFromScheduler(rootDir, options);
}

export {
  extractExecError,
  getPaths,
  resolveRootDir,
  runSchedulerTick,
  writeJson,
};
export { loadRuntime };
