import fs from 'fs';
import path from 'path';
import { resolveGithubAuthToken } from './github.js';
import { isImplementationRole, isReviewRole } from '../agents/role-catalog.js';
import type { AnyRecord, AutonomyConfig, PullRequestRecord, QueueMap, TaskRecord } from './types.js';
import { GIT_NETWORK_TIMEOUT_MS } from './constants.js';
import { emitSyncProgress, readJson } from './core.js';
import { compareBranchToBase, getPullRequest, listPullRequestsByHead, resolveGithubRepo } from './github.js';
import { gitAuthArgs, gitRefExists, readGit, readJsonFromGitRef, runGit } from './git-shared.js';
import { slugify } from './prd.js';

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
    const queueState = path.isAbsolute(relativePath)
      ? fallbackQueue
      : readJsonFromGitRef(rootDir, ref, relativePath, fallbackQueue);
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
    const queueState = path.isAbsolute(relativePath)
      ? fallbackQueue
      : readJsonFromGitRef(rootDir, ref, relativePath, fallbackQueue);
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
  return Array.isArray(trackedTasks) && trackedTasks.length > 0
    ? trackedTasks.slice()
    : [];
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

function buildLaneBranchName(config, sprint, prdId, task) {
  const prefix = (config.branchPrefixes && config.branchPrefixes.task) || 'agent';
  const sprintSegment = slugify(task.sprintId || sprint.sprintId || 'shared');
  const agentSegment = slugify(task.agentId);
  const laneSegment = slugify(`${prdId}:${task.agentId}`);
  return `${prefix}/${sprintSegment}/${agentSegment}/${laneSegment}`;
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
    const groupedTasks = groupLaneTasksByAgent(getPlannedImplementationTasksForPrd(remoteSpec, trackedImplementationTasksByPrd));
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
  const tempRef = `refs/autonomy-sync/${slugify(branch)}`;
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
  if (!relativePath || path.isAbsolute(relativePath)) {
    return null;
  }
  const tempRef = `refs/autonomy-sync/${slugify(agentId)}-${slugify(branch)}`;
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

export {
  buildImportedSpecState,
  buildLaneBranchName,
  buildLaneSourceSummary,
  buildLaneWorktreePath,
  buildSourceMetadata,
  buildTrackedImplementationTaskIndex,
  countCompletedRemoteLaneTasks,
  getAgentConfig,
  getPlannedImplementationTasksForPrd,
  groupLaneTasksByAgent,
  readTrackedImplementationQueuesFromRef,
  readTrackedReviewerTasksFromRef,
  resolveRemoteLaneStates,
};
