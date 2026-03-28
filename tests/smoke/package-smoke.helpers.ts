import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AnyRecord } from '../../src/types.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..', '..');
const CLI_BIN = path.join(PROJECT_ROOT, 'bin', 'autonomy-v2');
const SERVER_BIN = path.join(PROJECT_ROOT, 'bin', 'autonomy-v2-server');

function createFixtureRepo(prefix) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(repoDir, 'src', 'apps', 'fixture'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'apps', 'fixture', 'index.js'), 'export const value = 1;\n', 'utf8');
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'autonomy-test@example.com']);
  git(repoDir, ['config', 'user.name', 'Autonomy Test']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  git(repoDir, ['branch', 'dev']);
  return repoDir;
}

function initAutonomyRepo(repoDir) {
  runNode(CLI_BIN, ['init', '--root', repoDir]);
}

function addPrdWithTasks(repoDir, prdId, title, taskSpecs) {
  const args = ['prd:add', '--root', repoDir, '--id', prdId, '--title', title];
  taskSpecs.forEach((taskSpec) => {
    args.push('--task-spec', JSON.stringify(taskSpec));
  });
  runNode(CLI_BIN, args);
}

function runTick(repoDir) {
  return JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));
}

function readGitJson(cwd, revisionPath) {
  return JSON.parse(git(cwd, ['show', revisionPath]));
}

function findTaskInQueue(queueState, taskId) {
  return (queueState.tasks || []).find((task) => task.id === taskId) || null;
}

function runNode(scriptPath, args, options: AnyRecord = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fileExistsInGitRevision(cwd, revisionPath) {
  try {
    git(cwd, ['show', revisionPath]);
    return true;
  } catch (_) {
    return false;
  }
}

function getAutonomyPathsForTest(rootDir) {
  const runtimeAutonomyDir = path.join(rootDir, '.autonomy', 'runtime');
  const stateDir = path.join(runtimeAutonomyDir, 'state');
  return {
    prsState: path.join(stateDir, 'prs.json'),
    branchLocksState: path.join(stateDir, 'branch-locks.json'),
  };
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export {
  addPrdWithTasks,
  CLI_BIN,
  createFixtureRepo,
  fileExistsInGitRevision,
  findTaskInQueue,
  getAutonomyPathsForTest,
  git,
  initAutonomyRepo,
  
  readGitJson,
  runNode,
  runTick,
  SERVER_BIN,
};
