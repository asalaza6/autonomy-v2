import fs from 'fs';
import path from 'path';
import { AUTONOMY_SEGMENTS, RUNTIME_SEGMENTS } from './orchestrator-constants.js';

function resolveRootDir(rootOption: string) {
  if (!rootOption) {
    return process.cwd();
  }

  return path.isAbsolute(rootOption)
    ? rootOption
    : path.resolve(process.cwd(), rootOption);
}

function getPaths(rootDir) {
  const repoAutonomyDir = path.join(rootDir, ...AUTONOMY_SEGMENTS);
  const runtimeAutonomyDir = path.join(rootDir, ...RUNTIME_SEGMENTS);
  const configDir = path.join(repoAutonomyDir, 'config');
  const stateDir = path.join(runtimeAutonomyDir, 'state');
  return {
    repoAutonomyDir,
    runtimeAutonomyDir,
    configDir,
    stateDir,
    agentsConfig: path.join(configDir, 'agents.json'),
    sprintConfig: path.join(configDir, 'sprint.json'),
    runtimeState: path.join(stateDir, 'runtime.json'),
    prsState: path.join(stateDir, 'prs.json'),
    branchLocksState: path.join(stateDir, 'branch-locks.json'),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson<T = any>(filePath: string, fallbackValue?: T): T {
  if (!fs.existsSync(filePath)) {
    return fallbackValue as T;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function resolveRuntimeManagedPath(rootDir, relativePath) {
  const normalized = path.normalize(relativePath);
  const trackedStatePrefix = path.join(...AUTONOMY_SEGMENTS, 'state');
  const runtimeStateDir = path.join(rootDir, ...RUNTIME_SEGMENTS, 'state');
  if (normalized === trackedStatePrefix || normalized.startsWith(`${trackedStatePrefix}${path.sep}`)) {
    return path.join(runtimeStateDir, trimLeadingSeparator(normalized.slice(trackedStatePrefix.length)));
  }
  return path.join(rootDir, normalized);
}

function trimLeadingSeparator(value) {
  let normalized = String(value || '');
  while (normalized.startsWith('/') || normalized.startsWith('\\')) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function getAgentLogPath(rootDir, agentId) {
  return path.join(rootDir, ...RUNTIME_SEGMENTS, 'agents', agentId, 'log.md');
}

function getRunnerErrorReportPath(rootDir, agentId) {
  return path.join(rootDir, ...RUNTIME_SEGMENTS, 'agents', agentId, 'last-runner-error.json');
}

export {
  ensureDir,
  getAgentLogPath,
  getPaths,
  getRunnerErrorReportPath,
  readJson,
  resolveRootDir,
  resolveRuntimeManagedPath,
  
  writeJson,
};
