import fs from 'fs';
import path from 'path';
import type { AnyRecord } from '../autonomy-types.js';
import type { AgentExecutionContext } from '../../agents/AgentDefinition.js';

function nowIso() {
  return new Date().toISOString();
}

function bindArgs(fn, ...leadingArgs) {
  return (...trailingArgs) => fn(...leadingArgs, ...trailingArgs);
}

function createRunnerBaseContext(rootDir, agent, config, queues) {
  return {
    phase: 'runner' as const,
    rootDir,
    agent,
    config,
    current: {
      queues,
    },
    prdStore: {},
    clock: {
      now: nowIso,
    },
  };
}

function createRunnerLogger(rootDir, deps) {
  const appendRunnerLog = typeof deps.appendRunnerLog === 'function'
    ? bindArgs(deps.appendRunnerLog, rootDir)
    : undefined;
  return {
    appendRunnerLog,
    logRunnerEvent: deps.logRunnerEvent,
  };
}

function createImplementationRunnerExecutionContext(params: AnyRecord, deps: AnyRecord): AgentExecutionContext {
  const { rootDir, agentId, worktreePath } = params;
  const state = deps.loadState(rootDir, {
    worktreePath,
    implementationAgentId: agentId,
  });
  const agent = deps.getAgentConfig(state.config, agentId);
  const getCompletedLaneTasks = bindArgs(deps.getCompletedLaneTasks, rootDir);
  const recordLaneTaskCompletion = bindArgs(deps.recordLaneTaskCompletion, rootDir);

  return {
    ...createRunnerBaseContext(rootDir, agent, state.config, state.queues),
    queueStore: {
      getTask: deps.getTask,
      getLaneTasks: deps.getLaneTasks,
      getCompletedLaneTasks,
      buildTaskLaneKey: deps.buildTaskLaneKey,
      isPendingImplementationTask: deps.isPendingImplementationTask,
      markImplementationTaskComplete: deps.markImplementationTaskComplete,
      recordImplementationTaskCommitSha: deps.recordImplementationTaskCommitSha,
      recordLaneTaskCompletion,
    },
    prStore: {
      getPrForLane: bindArgs(deps.getPrForLane, rootDir),
      finalizeTaskRun: deps.finalizeTaskRun,
    },
    branchLockStore: {
      getCompletedLaneTasks,
      recordLaneTaskCompletion,
    },
    runtimeStore: {
      loadState(options = {}) {
        return deps.loadState(rootDir, {
          worktreePath: options.worktreePath || worktreePath,
          implementationAgentId: options.implementationAgentId || agentId,
        });
      },
    },
    scm: {
      ensureDir(targetPath) {
        return deps.ensureDir(path.dirname(targetPath));
      },
      fsExists: fs.existsSync,
      readFile(filePath) {
        return fs.readFileSync(filePath, 'utf8');
      },
      writeFile(filePath, content) {
        fs.writeFileSync(filePath, content, 'utf8');
      },
      relativePath: path.relative,
      resolveTargetFile: deps.resolveTargetFile,
      ensureCheckEnvironment: deps.ensureCheckEnvironment,
      runCheckCommands: deps.runCheckCommands,
      listChangedFiles: deps.listChangedFiles,
      buildCommitMessage: deps.buildCommitMessage,
      buildQueueMetadataCommitMessage: deps.buildQueueMetadataCommitMessage,
      runGit: deps.runGit,
      readGit: deps.readGit,
      tryPushBranch: deps.tryPushBranch,
    },
    reviewClient: {
      hasGithubAuth: deps.hasGithubAuth,
    },
    codex: {
      useStub: deps.useCodexStub,
      executeTask: deps.executeTaskWithCodex,
    },
    scopeEvaluator: {
      evaluate: deps.evaluateScope,
    },
    logger: createRunnerLogger(rootDir, deps),
  };
}

function createReviewRunnerExecutionContext(params: AnyRecord, deps: AnyRecord): AgentExecutionContext {
  const { rootDir, agentId } = params;
  const state = deps.loadState(rootDir);
  const agent = deps.getAgentConfig(state.config, agentId);

  return {
    ...createRunnerBaseContext(rootDir, agent, state.config, state.queues),
    queueStore: {
      getReviewTask: deps.getReviewTask,
      persistReviewerTaskState: bindArgs(deps.persistReviewerTaskState, rootDir, state.config),
    },
    prStore: {
      getPr: bindArgs(deps.getPr, rootDir),
      recordReviewDecision({ prId, reviewerId, decision, summary, publish }) {
        const args = [
          deps.CLI_PATH,
          deps.buildRoleEventName(deps.AGENT_ROLES.REVIEW, 'record'),
          '--root',
          rootDir,
          '--pr',
          prId,
          '--reviewer',
          reviewerId,
          '--decision',
          decision,
          '--summary',
          summary,
        ];
        if (publish) {
          args.push('--publish');
        }
        deps.execFileSync(process.execPath, args, {
          cwd: rootDir,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      },
    },
    branchLockStore: {},
    runtimeStore: {
      loadState: bindArgs(deps.loadState, rootDir),
    },
    scm: {
      ensureReviewContext: bindArgs(deps.ensureReviewContext, rootDir),
      ensureCheckEnvironment: deps.ensureCheckEnvironment,
      runCheckCommands: deps.runCheckCommands,
      listReviewDiffFiles: deps.listReviewDiffFiles,
      listBranchCommits: deps.listBranchCommits,
      tryMergeWithRetry: bindArgs(deps.tryMergeWithRetry, rootDir),
    },
    reviewClient: {
      hasGithubAuth: deps.hasGithubAuth,
      publishMergeFollowupCommentIfNeeded: bindArgs(deps.publishMergeFollowupCommentIfNeeded, rootDir),
      resolveGithubRepo: bindArgs(deps.resolveGithubRepo, rootDir),
      resolveGithubAuthToken: deps.resolveGithubAuthToken,
      postIssueComment: deps.postIssueComment,
    },
    codex: {
      useStub: deps.useCodexStub,
      reviewPr: deps.reviewPrWithCodex,
    },
    scopeEvaluator: {
      evaluate: deps.evaluateScope,
    },
    logger: createRunnerLogger(rootDir, deps),
  };
}

export {
  createImplementationRunnerExecutionContext,
  createReviewRunnerExecutionContext,
};
