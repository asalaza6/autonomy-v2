import { TASK_TYPES } from '../agents/role-catalog.js';
import type { AnyRecord, TaskRecord } from './sync-types.js';
import { normalizeStringList, requiresPmPlanning } from './sync-prd.js';
import {
  buildLaneSourceSummary,
  buildLaneWorktreePath,
  buildSourceMetadata,
  countCompletedRemoteLaneTasks,
  getAgentConfig,
  getPlannedImplementationTasksForPrd,
  groupLaneTasksByAgent,
} from './lanes.js';
import {
  buildDerivedPullRequestRecord,
  buildDerivedReviewerTask,
  buildStablePullRequestId,
  countCompletedLaneTasks,
  countCompletedTaskIds,
  sortDerivedTasks,
  uniqueStrings,
} from './derived-pr.js';

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

function isImportedPrdRecord(record, importedPrdIds) {
  const laneKey = normalizeLaneKey(record);
  if (record && record.prdId && importedPrdIds.has(record.prdId)) {
    return true;
  }
  return Boolean(laneKey) && importedPrdIds.has(laneKey.split(':')[0]);
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

function buildDerivedPrdRecord({ integrationBranch, remoteSpec, implementationTasks, laneStates, now, fetchedRef }: AnyRecord) {
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

function buildDerivedImportedRuntimeState({
  rootDir,
  integrationBranch,
  config,
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
  const currentTasksByPrId = new Map<string, TaskRecord[]>();
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
  const currentBranchLockByLane = new Map<string, AnyRecord>(
    (currentBranchLocks || [])
      .filter((lock) => lock && (lock.laneKey || (lock.prdId && lock.agentId)))
      .map((lock) => [normalizeLaneKey(lock), lock])
  );
  const currentPrByLane = new Map<string, AnyRecord>();
  const currentPrByRemoteNumber = new Map<number, AnyRecord>();
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
  const derivedTasks: TaskRecord[] = [];
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
        branch: '',
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
      const branch = laneState.branch || '';
      const linkedRuntimeTasks = currentTasksByPrId.get(prId) || [];
      const existingReviewerTask = currentReviewerTaskByPrId.get(prId) || null;

      laneTasks.forEach((task) => reconciledTaskIds.add(task.id));

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
        const source = buildLaneSourceSummary(remoteSpec.spec.id, laneTasks);
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
          source,
        });
        derivedPullRequests.push(derivedPr);
        linkedRuntimeTasks.forEach((task) => {
          if (task && task.type !== TASK_TYPES.REVIEW) {
            reconciledTaskIds.add(task.id);
          }
        });
        uniqueStrings(((existingPr && existingPr.pendingTaskIds) || []).filter((taskId) => !laneTaskIds.has(taskId)))
          .forEach((taskId) => reconciledTaskIds.add(taskId));
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

export {
  buildDerivedImportedRuntimeState,
  isImportedPrdRecord,
};
