import fs from 'node:fs';
import path from 'node:path';

export function customLifecycleDir(root) {
  return path.join(root, '.autonomy', 'runtime', 'custom-lifecycle');
}

export function customQueueDir(root) {
  return path.join(customLifecycleDir(root), 'queues');
}

export function customQueuePath(root, agentId) {
  return path.join(customQueueDir(root), `${agentId}.json`);
}

export function customPrdStateDir(root) {
  return path.join(customLifecycleDir(root), 'prd-state');
}

export function customPrdStatePath(root, prdId) {
  return path.join(customPrdStateDir(root), `${prdId}.json`);
}

export function customPrsPath(root) {
  return path.join(customLifecycleDir(root), 'state', 'prs.json');
}

export function prdRootDir(root) {
  return path.join(root, 'prompts', 'autonomous', 'v2', 'specs', 'prds');
}

export function activePrdPath(root, prdId) {
  return path.join(prdRootDir(root), `${prdId}.json`);
}

export function queuedPrdPath(root, prdId) {
  return path.join(prdRootDir(root), 'queue', `${prdId}.json`);
}

export function archivedPrdPath(root, prdId) {
  return path.join(prdRootDir(root), 'archived', `${prdId}.json`);
}

export function taskPrdStatus(root, task) {
  const prdId = String(task && (task.prdId || task.sourcePrdId) || '').trim();
  if (!prdId) {
    return { prdId: '', state: 'unscoped', runnable: true, reason: '' };
  }
  if (fs.existsSync(activePrdPath(root, prdId))) {
    return { prdId, state: 'active', runnable: true, reason: '' };
  }
  if (fs.existsSync(archivedPrdPath(root, prdId))) {
    return {
      prdId,
      state: 'archived',
      runnable: false,
      reason: `prd ${prdId} is archived`,
    };
  }
  return {
    prdId,
    state: 'missing',
    runnable: false,
    reason: `prd ${prdId} is not active`,
  };
}

export function isTaskPrdRunnable(root, task) {
  return taskPrdStatus(root, task).runnable;
}

export function terminalPrdTaskPatch(root, task) {
  const status = taskPrdStatus(root, task);
  return {
    status: 'archived',
    staleReason: status.reason || 'prd is not runnable',
    stalePrdState: status.state,
    archivedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
