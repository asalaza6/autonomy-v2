import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AgentConfig, AutonomyConfig, AnyRecord, BranchLocksState, QueueMap, QueueState, RuntimeState, TaskRecord, TrackedPrdRecord } from '../server-types.js';
import type { AgentExecutionContext } from '../../agents/AgentDefinition.js';
import { acquireStateLock } from '../../lock/lock-main.js';
import { CLI_PATH, DEFAULT_RUNNER_PATH } from './orchestrator-constants.js';
import { executeRunnerCommand } from './orchestrator-git.js';
import { buildTaskLaneKey, buildTaskQueueState, getAgent, implementationTaskNeedsDispatch, listPrds, listTasks, selectImplementationTask } from './helpers.js';
import { getRunnerErrorReportPath, readJson, writeJson } from './paths.js';
import { loadBranchLocks, loadPrds } from './orchestrator-state.js';
import { loadQueues, resolveImplementationQueueContext, writeQueueAndAggregate } from './queues.js';
import { commitPrdSpecToIntegrationBranch, commitTrackedFilesToIntegrationBranch, commitTrackedPrdStateToIntegrationBranch, readTrackedPrdStateMap } from '../../sync/sync-git.js';

function nowIso() {
  return new Date().toISOString();
}

function bindArgs(fn, ...leadingArgs) {
  return (...trailingArgs) => fn(...leadingArgs, ...trailingArgs);
}

function createClockCapability() {
  return {
    now: nowIso,
  };
}

function createQueueContextResolver(rootDir: string, config: AutonomyConfig) {
  return (currentAgent, queue, branchLocks) => resolveImplementationQueueContext(rootDir, config, branchLocks, currentAgent, queue);
}

function createScheduleAgentExecutionContext(rootDir: string, config: AutonomyConfig, agent: AgentConfig, current: {
  queues: QueueMap;
  branchLocks: BranchLocksState;
  prds: { prds: TrackedPrdRecord[] };
  runtime: RuntimeState;
}, options: AnyRecord = {}): AgentExecutionContext {
  const resolveQueueContext = createQueueContextResolver(rootDir, config);
  return {
    phase: 'schedule',
    rootDir,
    agent,
    config,
    options,
    current,
    queueStore: {
      listTasks,
      resolveImplementationQueueContext: resolveQueueContext,
      implementationTaskNeedsDispatch,
      selectImplementationTask,
      buildTaskLaneKey,
    },
    prdStore: {
      listPrds,
    },
    prStore: {},
    branchLockStore: {
      loadBranchLocks() {
        return current.branchLocks;
      },
    },
    runtimeStore: {
      loadRuntime() {
        return current.runtime;
      },
    },
    scm: {},
    reviewClient: {},
    codex: {},
    scopeEvaluator: {},
    clock: createClockCapability(),
    logger: {},
  };
}

function createWorkerAgentExecutionContext(rootDir: string, config: AutonomyConfig, sprint: AnyRecord, agent: AgentConfig, current: AnyRecord = {}): AgentExecutionContext {
  const resolveQueueContext = createQueueContextResolver(rootDir, config);
  const appendAgentLog = typeof current.appendAgentLog === 'function'
    ? bindArgs(current.appendAgentLog, rootDir, config)
    : null;
  return {
    phase: 'worker',
    rootDir,
    agent,
    config,
    sprint,
    current,
    queueStore: {
      listTasks,
      buildQueueState: buildTaskQueueState,
      loadQueues: bindArgs(loadQueues, rootDir, config),
      resolveImplementationQueueContext: resolveQueueContext,
      selectImplementationTask,
      implementationTaskNeedsDispatch,
      claimQueuedReviewTask: bindArgs(claimQueuedReviewTask, rootDir, config),
      markReviewDispatchFailure: bindArgs(markReviewDispatchFailure, rootDir, config),
      claimImplementationTaskInWorktree: bindArgs(claimImplementationTaskInWorktree, config),
      writeQueueAndAggregate: bindArgs(writeQueueAndAggregate, rootDir, config),
      buildTaskLaneKey,
    },
    prdStore: {
      loadPrds: bindArgs(loadPrds, rootDir, config),
      listPrds,
      readTrackedPrdStateMap: bindArgs(readTrackedPrdStateMap, rootDir, config.integrationBranch),
      commitPrdSpec: bindArgs(commitPrdSpecToIntegrationBranch, rootDir, config.integrationBranch),
      commitTrackedFiles: bindArgs(commitTrackedFilesToIntegrationBranch, rootDir, config.integrationBranch),
      commitPrdState: bindArgs(commitTrackedPrdStateToIntegrationBranch, rootDir, config.integrationBranch),
    },
    prStore: {},
    branchLockStore: {
      loadBranchLocks: bindArgs(loadBranchLocks, rootDir),
    },
    runtimeStore: {
      executeRunner(env) {
        return executeRunnerCommand([process.execPath, DEFAULT_RUNNER_PATH], {
          ...env,
          AUTONOMY_ERROR_REPORT: getRunnerErrorReportPath(rootDir, agent.id),
        });
      },
    },
    scm: {
      fsExists: fs.existsSync,
      prepareTaskWorktree(taskId) {
        return JSON.parse(
          execFileSync(process.execPath, [CLI_PATH, 'worktree:prepare', '--root', rootDir, '--task', taskId, '--create', '--json'], {
            cwd: rootDir,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          }).trim()
        );
      },
    },
    reviewClient: {},
    codex: {
      useStub() {
        return process.env.AUTONOMY_CODEX_STUB === '1';
      },
      planPrdTasks: current.planPrdTasksWithCodex,
    },
    scopeEvaluator: {},
    clock: createClockCapability(),
    logger: {
      appendAgentLog(agentId, event, payload = {}) {
        if (appendAgentLog) {
          appendAgentLog(agentId, event, payload);
        }
      },
    },
  };
}

function claimQueuedReviewTask(rootDir: string, config: AutonomyConfig, agentId: string): TaskRecord | null {
  const release = acquireStateLock(rootDir);
  try {
    const queues = loadQueues(rootDir, config);
    const reviewerQueue = queues[agentId];
    const reviewTask = listTasks(reviewerQueue).find((task) => task.status === 'queued');
    if (!reviewTask) {
      return null;
    }
    reviewTask.status = 'assigned';
    reviewTask.dispatchedAt = new Date().toISOString();
    reviewTask.dispatcher = 'scheduler';
    writeQueueAndAggregate(rootDir, config, agentId, reviewerQueue, {
      commitMessage: `autonomy(queue): assign ${reviewTask.id}`,
      gitIdentity: getAgent(config, agentId).gitIdentity,
    });
    return JSON.parse(JSON.stringify(reviewTask));
  } finally {
    release();
  }
}

function markReviewDispatchFailure(rootDir: string, config: AutonomyConfig, agentId: string, taskId: string, message: string): void {
  const release = acquireStateLock(rootDir);
  try {
    const queues = loadQueues(rootDir, config);
    const queue = queues[agentId];
    const task = listTasks(queue).find((candidate) => candidate.id === taskId);
    if (!task) {
      return;
    }
    task.status = 'failed';
    task.updatedAt = new Date().toISOString();
    task.lastError = message;
    delete task.dispatchedAt;
    delete task.dispatcher;
    writeQueueAndAggregate(rootDir, config, agentId, queue, {
      commitMessage: `autonomy(queue): fail ${taskId}`,
      gitIdentity: getAgent(config, agentId).gitIdentity,
    });
  } finally {
    release();
  }
}

function claimImplementationTaskInWorktree(config: AutonomyConfig, agent: AgentConfig, task: TaskRecord, branch: string, worktreePath: string): { task: TaskRecord; branch: string; } {
  const relativePath = agent.taskQueue;
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Implementation queue for "${agent.id}" must be repo-relative inside the worktree.`);
  }
  const queuePath = path.join(worktreePath, relativePath);
  const queueState = fs.existsSync(queuePath)
    ? readJson(queuePath, buildTaskQueueState(agent, []))
    : buildTaskQueueState(agent, []);
  const tasks = listTasks(queueState).map((candidate) => ({ ...candidate }));
  const nextTask = tasks.find((candidate) => candidate.id === task.id);
  if (!nextTask) {
    throw new Error(`Task "${task.id}" disappeared before branch-local claim.`);
  }
  const claimedAt = new Date().toISOString();
  nextTask.state = 'active';
  nextTask.status = 'active';
  nextTask.branch = branch;
  nextTask.startedAt = nextTask.startedAt || claimedAt;
  nextTask.updatedAt = claimedAt;
  delete nextTask.completedAt;
  delete nextTask.commitSha;
  delete nextTask.completionMode;
  delete nextTask.lastError;

  writeJson(queuePath, buildTaskQueueState(agent, tasks));

  return {
    task: nextTask,
    branch,
  };
}
export {
  createScheduleAgentExecutionContext,
  createWorkerAgentExecutionContext,
};
