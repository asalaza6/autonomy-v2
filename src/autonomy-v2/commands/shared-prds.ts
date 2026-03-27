import fs from 'fs';
import path from 'path';
import { validateAutonomyConfig } from '../../config/index.js';
import { buildPrdStateRelativePath } from '../../sync/prd.js';
import { commitTrackedFilesToIntegrationBranch, listTrackedPrdSpecs, readTrackedPrdStateMap } from '../../sync/git.js';
import type { AnyRecord, AutonomyConfig, BranchLocksState, PrState, PrdSpecPayload, QueueMap, TrackedPrdRecord } from '../types.js';
import { getAutonomyPaths, readJson } from './shared-core.js';
import { isTerminalTaskStatus, listTasks, readTaskQueues } from './shared-queues.js';

const DEFAULT_AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const PRD_SPECS_SEGMENTS = [...DEFAULT_AUTONOMY_SEGMENTS, 'specs', 'prds'];
const PRD_QUEUE_SEGMENTS = [...PRD_SPECS_SEGMENTS, 'queue'];
const PRD_ARCHIVE_SEGMENTS = [...PRD_SPECS_SEGMENTS, 'archived'];

function getPrdSpecsDir(rootDir) {
  return path.join(rootDir, ...PRD_SPECS_SEGMENTS);
}

function getArchivedPrdSpecsDir(rootDir) {
  return path.join(rootDir, ...PRD_ARCHIVE_SEGMENTS);
}

function listCurrentPrdSpecEntries(rootDir) {
  const specsDir = getPrdSpecsDir(rootDir);
  return listPrdSpecEntriesInDir(specsDir);
}

function listQueuedPrdSpecEntries(rootDir) {
  const queueDir = path.join(rootDir, ...PRD_QUEUE_SEGMENTS);
  return listPrdSpecEntriesInDir(queueDir);
}

function listPrdSpecEntriesInDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(dirPath, entry.name);
      try {
        const spec = readJson(filePath);
        return {
          id: String(spec.id || entry.name.replace(/\.json$/i, '')),
          fileName: entry.name,
          filePath,
        };
      } catch (_) {
        return {
          id: entry.name.replace(/\.json$/i, ''),
          fileName: entry.name,
          filePath,
        };
      }
    });
}

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
      return linkedPullRequests.every((pr) => String(pr.status || '') === 'merged');
    }

    const linkedTasks = tasksByPrdId.get(prdId) || [];
    if (linkedTasks.some((task) => !isTerminalTaskStatus(task.status))) {
      return false;
    }

    const prd = prdById.get(prdId);
    return Boolean(prd && prd.status === 'completed');
  });
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
      let status = 'queued';
      if (trackedState && (trackedState.status === 'planning' || trackedState.status === 'failed')) {
        status = trackedState.status;
      } else if (linkedPullRequests.length > 0 && linkedPullRequests.every((pr) => String(pr.status || '') === 'merged')) {
        status = 'completed';
      } else if ((trackedState && trackedState.status === 'planned') || plannedTaskIds.length > 0) {
        status = 'planned';
      } else if (entry.isQueued) {
        status = 'queued';
      }
      return {
        ...entry.spec,
        status,
        plannedTaskIds: plannedTaskIds.length > 0 ? plannedTaskIds : undefined,
        lastError: trackedState && trackedState.lastError ? trackedState.lastError : undefined,
        updatedAt: trackedState && trackedState.updatedAt ? trackedState.updatedAt : entry.spec.createdAt,
      };
    }),
  };
}

function archiveCompletedPrdSpecs(rootDir, state) {
  const currentSpecs = state && state.config && state.config.integrationBranch
    ? listTrackedPrdSpecs(rootDir, state.config.integrationBranch).map((entry) => ({
      id: entry.spec.id,
      fileName: path.basename(entry.relativePath),
      filePath: path.join(rootDir, entry.relativePath),
      relativePath: entry.relativePath,
      spec: entry.spec,
    }))
    : [
      ...listCurrentPrdSpecEntries(rootDir),
      ...listQueuedPrdSpecEntries(rootDir),
    ].map((entry) => ({
      ...entry,
      relativePath: path.relative(rootDir, entry.filePath),
      spec: readJson<PrdSpecPayload>(entry.filePath, {} as PrdSpecPayload),
    }));
  const archivableIds = new Set(findArchivablePrdIds(
    currentSpecs.map((entry) => entry.id),
    state
  ));

  if (archivableIds.size === 0) {
    return [];
  }

  fs.mkdirSync(getArchivedPrdSpecsDir(rootDir), { recursive: true });
  const archivableEntries = currentSpecs.filter((entry) => archivableIds.has(entry.id));
  if (state && state.config && state.config.integrationBranch) {
    const trackedUpdates = [];
    archivableEntries.forEach((entry) => {
      const destinationPath = path.join(getArchivedPrdSpecsDir(rootDir), entry.fileName);
      trackedUpdates.push({
        relativePath: path.relative(rootDir, destinationPath),
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
    });
  }

  const archived = [];
  archivableEntries.forEach((entry) => {
    const destinationPath = path.join(getArchivedPrdSpecsDir(rootDir), entry.fileName);
    if (fs.existsSync(entry.filePath)) {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.renameSync(entry.filePath, destinationPath);
    }
    const prdStatePath = path.join(rootDir, buildPrdStateRelativePath(entry.id));
    fs.rmSync(prdStatePath, { force: true });
    archived.push({
      id: entry.id,
      from: entry.relativePath,
      to: path.relative(rootDir, destinationPath),
    });
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
  loadTrackedPrds,
};
