import {
  isImplementationRole,
  resolveGithubAuthToken,
} from './command-dependencies.js';
import { appendAgentLog, buildMergeCommitTitle, getAgent, getAutonomyPaths, getPr, printOutput, requireOption, ensureInitialized, writeJson, } from './shared-core.js';
import { archiveCompletedPrdSpecs, loadAllState, loadTrackedPrds } from './shared-prds.js';
import { evaluateMerge, findBranchLockByLane, isGitWorktree, runGit } from './shared-repo.js';
import { appendTrackedBranchFollowupTask, buildLaneConflictTaskId, enqueueLaneFollowupTask, getReviewerTask } from './shared-worktrees.js';
import { findTask, getImplementationTaskState, isTerminalTaskStatus, writeTaskQueues } from './shared-queues.js';
import { listImplementationLaneTasks, listLaneTasks } from './shared-lanes.js';
import { mergePullRequest, performLocalMerge, resolveGithubRepo } from './shared-github.js';

async function run(rootDir, options) {
  ensureInitialized(rootDir);
  const state = loadAllState(rootDir);
  const pr = getPr(state.prs, requireOption(options, 'pr'));
  const actorId = requireOption(options, 'actor');
  const actor = getAgent(state.config, actorId);
  const implementationAgent = getAgent(state.config, pr.agentId);
  const laneTasks = isImplementationRole(implementationAgent.role)
    ? listImplementationLaneTasks(rootDir, state, pr.agentId, pr.laneKey || pr.taskId, { pr }).tasks
    : listLaneTasks(state.taskQueues, pr.agentId, pr.laneKey || pr.taskId);
  const pendingLaneTasks = laneTasks.filter((candidate) => !isTerminalTaskStatus(getImplementationTaskState(candidate)));
  const reviewerTask = getReviewerTask(state.taskQueues, state.config, pr);

  const evaluation = evaluateMerge({
    config: state.config,
    pr,
    actor,
    reviewerTask,
  });
  if (!evaluation.ok || pendingLaneTasks.length > 0 || (pr.pendingTaskIds || []).length > 0) {
    process.exitCode = 1;
    printOutput(options, evaluation, () => {
      console.log('Merge blocked.');
      evaluation.reasons.forEach((reason) => console.log(`- ${reason}`));
      if (pendingLaneTasks.length > 0 || (pr.pendingTaskIds || []).length > 0) {
        console.log('- pending lane tasks must be completed before merge');
      }
    });
    return;
  }

  if (options.execute === true) {
    if (pr.remote && pr.remote.number) {
      const repo = resolveGithubRepo(rootDir);
      const token = resolveGithubAuthToken({ required: true });
      const mergeResponse = await mergePullRequest(repo, token, pr.remote.number, {
        merge_method: state.config.mergeStrategy || 'merge',
        commit_title: buildMergeCommitTitle(actor, pr),
      });
      pr.remote.mergeSha = mergeResponse.sha;
    } else {
      const mergeResponse = performLocalMerge(rootDir, state.config, pr, actor);
      if (!mergeResponse.ok) {
        const conflictedAt = new Date().toISOString();
        pr.status = 'conflicted';
        pr.updatedAt = conflictedAt;
        pr.conflict = {
          conflictedAt,
          message: mergeResponse.message,
        };
        pr.conflicts = Array.isArray(pr.conflicts) ? pr.conflicts : [];
        pr.conflicts.push({
          conflictedAt,
          message: mergeResponse.message,
        });
        const task = findTask(state.taskQueues, pr.taskId);
        const usesTrackedImplementationQueue = isImplementationRole(getAgent(state.config, pr.agentId).role);
        let conflictTask = null;
        if (usesTrackedImplementationQueue) {
          conflictTask = appendTrackedBranchFollowupTask(rootDir, state, pr, {
            id: buildLaneConflictTaskId(pr),
            title: `Resolve merge conflict for ${pr.title}`,
            description: mergeResponse.message,
            type: 'conflict_resolution',
            source: 'conflict_resolution',
            createdAt: conflictedAt,
            updatedAt: conflictedAt,
          });
        } else if (task) {
          task.status = 'conflicted';
          task.updatedAt = conflictedAt;
        } else {
          conflictTask = enqueueLaneFollowupTask(state.taskQueues, state.config, pr, {
            id: buildLaneConflictTaskId(pr),
            title: `Resolve merge conflict for ${pr.title}`,
            description: mergeResponse.message,
            type: 'conflict_resolution',
            createdAt: conflictedAt,
            updatedAt: conflictedAt,
          });
        }
        const reviewerTask = getReviewerTask(state.taskQueues, state.config, pr);
        if (reviewerTask) {
          reviewerTask.status = 'blocked_conflict';
          reviewerTask.updatedAt = conflictedAt;
        }

        const paths = getAutonomyPaths(rootDir);
        writeJson(paths.prsState, state.prs);
        writeTaskQueues(rootDir, state.config, state.taskQueues);
        appendAgentLog(rootDir, state.config, actor.id, 'merge:conflict', {
          input: {
            prId: pr.id,
            baseBranch: pr.baseBranch,
          },
          output: {
            status: pr.status,
            message: mergeResponse.message,
          },
        });
        appendAgentLog(rootDir, state.config, pr.agentId, 'merge:conflict-assigned', {
          input: {
            prId: pr.id,
            reviewerId: actor.id,
          },
          output: {
            status: conflictTask
              ? conflictTask.status
              : task
                ? task.status
                : 'queued_conflict_resolution',
            message: mergeResponse.message,
          },
        });
        throw new Error(`Merge conflict while merging ${pr.id}: ${mergeResponse.message}`);
      }

      pr.local = {
        mergeSha: mergeResponse.sha,
      };
    }
  }

  if (options.execute === true) {
    const mergedAt = new Date().toISOString();
    pr.status = 'merged';
    pr.mergeState = 'merged';
    pr.mergedAt = mergedAt;
    pr.updatedAt = mergedAt;
    delete pr.mergeBlockedCode;
    delete pr.mergeBlockedReason;
    const task = findTask(state.taskQueues, pr.taskId);
    if (task) {
      task.status = 'merged';
      task.updatedAt = mergedAt;
    }
    if (reviewerTask) {
      reviewerTask.status = 'merged';
      reviewerTask.mergedAt = mergedAt;
      delete reviewerTask.lastError;
      delete reviewerTask.lastMergeFailureCode;
      delete reviewerTask.lastMergeFailureMessage;
      reviewerTask.updatedAt = mergedAt;
    }

    const paths = getAutonomyPaths(rootDir);
    writeJson(paths.prsState, state.prs);
    writeTaskQueues(rootDir, state.config, state.taskQueues);
    const prds = loadTrackedPrds(rootDir, state.config, {
      taskQueues: state.taskQueues,
      prs: state.prs,
    });
    const archivedSpecs = archiveCompletedPrdSpecs(rootDir, {
      config: state.config,
      taskQueues: state.taskQueues,
      prs: state.prs,
      prds,
      gitIdentity: actor.gitIdentity,
    });
    appendAgentLog(rootDir, state.config, actor.id, 'merge:success', {
      input: {
        prId: pr.id,
        baseBranch: pr.baseBranch,
      },
      output: {
        status: pr.status,
        mergedAt,
        archivedSpecs: archivedSpecs.map((entry) => entry.id),
      },
    });
    appendAgentLog(rootDir, state.config, pr.agentId, 'merge:success', {
      input: {
        prId: pr.id,
        reviewerId: actor.id,
      },
      output: {
        status: task ? task.status : 'merged',
        mergedAt,
        archivedSpecs: archivedSpecs.map((entry) => entry.id),
      },
    });
    cleanupMergedLaneWorktree(state, pr);
  }

  printOutput(options, evaluation, () => {
    console.log(options.execute === true ? `Merged ${pr.id} into ${pr.baseBranch}` : `Merge check passed for ${pr.id}`);
  });
}

function cleanupMergedLaneWorktree(state, pr) {
  const branchLock = findBranchLockByLane(state.branchLocks, pr.agentId, pr.laneKey || pr.taskId);
  const worktreePath = String(branchLock && branchLock.worktreePath || '').trim();
  if (!worktreePath || !isGitWorktree(worktreePath)) {
    return;
  }
  try {
    runGit(worktreePath, ['reset', '--hard', 'HEAD']);
    runGit(worktreePath, ['clean', '-fd']);
  } catch (_) {
    // Best-effort cleanup only.
  }
}


export { run };
