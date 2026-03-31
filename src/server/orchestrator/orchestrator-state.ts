import fs from 'fs';
import path from 'path';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { listTrackedPrdSpecs, readTrackedPrdStateMap } from '../../sync/sync-git.js';
import type { AnyRecord, AutonomyConfig, RuntimeState, TrackedPrdRecord } from '../server-types.js';
import { getAgent, listTasks } from './helpers.js';
import { ensureDir, getAgentLogPath, getPaths, readJson, writeJson } from './paths.js';
import { loadQueues } from './queues.js';

function loadConfig(rootDir: string): { config: AutonomyConfig; sprint: AnyRecord } {
  const paths = getPaths(rootDir);
  return {
    config: validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig),
    sprint: readJson(paths.sprintConfig, {}),
  };
}

function loadPrds(rootDir: string, config: AutonomyConfig, options: AnyRecord = {}): { prds: TrackedPrdRecord[] } {
  const specEntries = listTrackedPrdSpecs(rootDir, config.integrationBranch);
  const prdStateMap = readTrackedPrdStateMap(rootDir, config.integrationBranch);
  const queues = options.queues || loadQueues(rootDir, config);
  const tasksByPrdId = new Map();
  Object.values(queues).forEach((queue) => {
    listTasks(queue).forEach((task) => {
      if (!task || !task.prdId) {
        return;
      }
      const tasks = tasksByPrdId.get(task.prdId) || [];
      tasks.push(task);
      tasksByPrdId.set(task.prdId, tasks);
    });
  });

  return {
    prds: specEntries.map((entry) => {
      const trackedState = prdStateMap.get(entry.spec.id) || null;
      const plannedTaskIds = trackedState && Array.isArray(trackedState.plannedTaskIds) && trackedState.plannedTaskIds.length > 0
        ? trackedState.plannedTaskIds.slice()
        : ((tasksByPrdId.get(entry.spec.id) || []).map((task) => task.id));
      let status = 'queued';
      if (trackedState && (trackedState.status === 'planning' || trackedState.status === 'failed')) {
        status = trackedState.status;
      } else if ((trackedState && trackedState.status === 'planned') || plannedTaskIds.length > 0) {
        status = 'planned';
      } else if (entry.isQueued) {
        status = 'queued';
      }
      return {
        ...entry.spec,
        isQueued: entry.isQueued === true,
        status,
        plannedTaskIds,
        updatedAt: trackedState && trackedState.updatedAt ? trackedState.updatedAt : entry.spec.createdAt,
        lastError: trackedState && trackedState.lastError ? trackedState.lastError : undefined,
      };
    }),
  };
}

function loadRuntime(rootDir): RuntimeState {
  const paths = getPaths(rootDir);
  return readJson(paths.runtimeState, { workers: {} });
}

function loadBranchLocks(rootDir) {
  return readJson(getPaths(rootDir).branchLocksState, { locks: [] });
}

function writeRuntime(rootDir, runtime) {
  const paths = getPaths(rootDir);
  writeJson(paths.runtimeState, runtime);
}

function appendAgentLog(rootDir: string, config: AutonomyConfig, agentId: string, event: string, payload: AnyRecord = {}) {
  getAgent(config, agentId);
  const logPath = getAgentLogPath(rootDir, agentId);
  ensureDir(path.dirname(logPath));
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${agentId} Log\n`, 'utf8');
  }

  const lines = ['', `## ${new Date().toISOString()} ${event}`];
  if (typeof payload.input !== 'undefined') {
    lines.push('### Input', '```json', JSON.stringify(payload.input, null, 2), '```');
  }
  if (typeof payload.output !== 'undefined') {
    lines.push('### Output', '```json', JSON.stringify(payload.output, null, 2), '```');
  }
  fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
}

export {
  appendAgentLog,
  loadBranchLocks,
  loadConfig,
  loadPrds,
  loadRuntime,
  writeRuntime,
};
