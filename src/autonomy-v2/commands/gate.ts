import {
  AGENT_ROLES,
  buildRoleEventName,
  getRoleLabel,
  isImplementationRole,
  isReviewRole,
  resolveGithubAuthToken,
} from './command-dependencies.js';
import { appendAgentLog, buildSignedReviewSummary, ensureInitialized, getAgent, getAutonomyPaths, getPr, getStringOption, printOutput, requireOption, writeJson, } from './shared-core.js';
import { loadAllState } from './shared-prds.js';
import { writeTaskQueues } from './shared-queues.js';
import { addIssueComment, isSelfPullRequestReviewError, publishReview, resolveGithubRepo } from './shared-github.js';
import { buildLaneFollowupTaskId } from './shared-worktrees.js';
import { appendTrackedBranchFollowupTask, ensureReviewerTask, enqueueLaneFollowupTask } from './shared-worktrees.js';
import { findTask } from './shared-queues.js';
import { normalizeReviewDecision } from './shared-repo.js';
import { uniqueStrings } from './shared-repo.js';
import {
  buildReviewerBlockersFromReview,
  collectCurrentReviewerBlockers,
  collectReviewerBlockerChecks,
  listUnresolvedReviewerBlockers,
} from './shared-review-blockers.js';
import {
  getAgentConversationId,
  setAgentConversationReference,
} from '../../agents/conversation-references.js';

async function run(rootDir, options) {
  ensureInitialized(rootDir);
  const state = loadAllState(rootDir);
  const pr = getPr(state.prs, requireOption(options, 'pr'));
  const reviewerId = requireOption(options, 'reviewer');
  const reviewer = getAgent(state.config, reviewerId);
  if (!isReviewRole(reviewer.role)) {
    throw new Error(`Agent "${reviewerId}" is not a ${getRoleLabel(AGENT_ROLES.REVIEW)}er.`);
  }
  if (reviewerId === pr.agentId) {
    throw new Error(`${getRoleLabel(AGENT_ROLES.REVIEW)[0].toUpperCase()}${getRoleLabel(AGENT_ROLES.REVIEW).slice(1)}er cannot ${getRoleLabel(AGENT_ROLES.REVIEW)} their own PR.`);
  }

  const decision = normalizeReviewDecision(requireOption(options, 'decision'));
  const rawSummary = getStringOption(options, 'summary', '');
  const reviewConversationId = String(getStringOption(options, 'conversation-id', '')).trim();
  const reviewRound = (pr.reviews || []).length + 1;
  const decisionRecord: any = {
    reviewerId,
    decision,
    summary: rawSummary,
    publishedSummary: buildSignedReviewSummary(reviewer, rawSummary),
    reviewedAt: new Date().toISOString(),
    reviewRound,
  };
  if (reviewConversationId) {
    decisionRecord.conversationId = reviewConversationId;
  }
  if (decision === 'changes_requested') {
    decisionRecord.reviewerBlockers = buildReviewerBlockersFromReview(pr, decisionRecord);
  }
  const preDecisionBlockers = collectCurrentReviewerBlockers(pr);
  const unresolvedBlockers = listUnresolvedReviewerBlockers(preDecisionBlockers);
  if (decision === 'approved' && unresolvedBlockers.length > 0) {
    throw new Error(`Cannot approve ${pr.id} while structured reviewer blockers remain unresolved: ${unresolvedBlockers.map((blocker) => blocker.id).join(', ')}`);
  }
  pr.reviews.push(decisionRecord);
  pr.updatedAt = decisionRecord.reviewedAt;
  pr.status = decision === 'approved' ? 'approved' : 'changes_requested';
  pr.reviewerBlockers = decision === 'changes_requested'
    ? (decisionRecord.reviewerBlockers || [])
    : preDecisionBlockers;
  delete pr.mergeState;
  delete pr.mergeBlockedCode;
  delete pr.mergeBlockedReason;
  delete pr.mergeWatchdog;

  const task = findTask(state.taskQueues, pr.taskId);
  const implementationAgent = getAgent(state.config, pr.agentId);
  const usesTrackedImplementationQueue = isImplementationRole(implementationAgent.role);
  const implementationConversationId = getAgentConversationId(task, {
    agentId: pr.agentId,
    role: AGENT_ROLES.IMPLEMENTATION,
  }) || getAgentConversationId(pr, {
    agentId: pr.agentId,
    role: AGENT_ROLES.IMPLEMENTATION,
  });
  let followupTask = null;
  const followupPatch = decision === 'changes_requested'
    ? {
        id: buildLaneFollowupTaskId(pr),
        title: `Address ${getRoleLabel(AGENT_ROLES.REVIEW)} for ${pr.title}`,
        description: rawSummary || `Address ${getRoleLabel(AGENT_ROLES.REVIEW)}er feedback for ${pr.title}`,
        type: 'review_followup',
        source: 'review_followup',
        createdAt: decisionRecord.reviewedAt,
        updatedAt: decisionRecord.reviewedAt,
        checks: collectReviewerBlockerChecks(decisionRecord.reviewerBlockers || []),
        reviewerBlockers: decisionRecord.reviewerBlockers || [],
        implementationConversationId: implementationConversationId || undefined,
        conversationReferences: task && task.conversationReferences || undefined,
      }
    : null;
  if (decision === 'changes_requested' && usesTrackedImplementationQueue) {
    followupTask = appendTrackedBranchFollowupTask(rootDir, state, pr, followupPatch);
  }
  if (task && !followupTask && (!usesTrackedImplementationQueue || decision === 'approved')) {
    task.status = decision === 'approved' ? 'approved' : 'changes_requested';
    task.updatedAt = decisionRecord.reviewedAt;
    if (decision === 'changes_requested') {
      task.title = `Address ${getRoleLabel(AGENT_ROLES.REVIEW)} for ${pr.title}`;
      task.description = rawSummary || `Address ${getRoleLabel(AGENT_ROLES.REVIEW)}er feedback for ${pr.title}`;
      task.acceptance = [task.description];
      task.checks = uniqueStrings([...(task.checks || []), ...collectReviewerBlockerChecks(decisionRecord.reviewerBlockers || [])]);
      task.type = task.type || 'review_followup';
      task.reviewerBlockers = decisionRecord.reviewerBlockers || [];
      task.prId = pr.id;
      pr.pendingTaskIds = uniqueStrings([...(pr.pendingTaskIds || []), task.id]);
    }
  } else if (decision === 'changes_requested') {
    followupTask = followupTask || enqueueLaneFollowupTask(state.taskQueues, state.config, pr, followupPatch);
  }
  if (followupTask) {
    pr.taskIds = uniqueStrings([...(pr.taskIds || []), followupTask.id]);
    pr.pendingTaskIds = uniqueStrings([...(pr.pendingTaskIds || []), followupTask.id]);
  }
  const reviewerTask = ensureReviewerTask(state.taskQueues, state.config, pr, {
    id: pr.taskId,
    title: pr.sourceTitle,
    acceptance: pr.acceptance || [],
    agentId: pr.agentId,
  }, decisionRecord.reviewedAt);
  if (reviewConversationId) {
    setAgentConversationReference(pr, {
      agentId: reviewerId,
      role: AGENT_ROLES.REVIEW,
    }, reviewConversationId, decisionRecord.reviewedAt);
    setAgentConversationReference(reviewerTask, {
      agentId: reviewerId,
      role: AGENT_ROLES.REVIEW,
    }, reviewConversationId, decisionRecord.reviewedAt);
  }
  reviewerTask.status = decision === 'approved' ? 'approved' : 'changes_requested';
  reviewerTask.reviewedAt = decisionRecord.reviewedAt;
  reviewerTask.lastDecision = decision;
  const reviewedCommitCount = Number(pr.commitCount || (pr.remote && pr.remote.commitCount) || 0);
  if (Number.isFinite(reviewedCommitCount) && reviewedCommitCount > 0) {
    reviewerTask.reviewedCommitCount = reviewedCommitCount;
  } else {
    delete reviewerTask.reviewedCommitCount;
  }
  delete reviewerTask.lastError;
  delete reviewerTask.lastMergeFailureCode;
  delete reviewerTask.lastMergeFailureMessage;
  reviewerTask.updatedAt = decisionRecord.reviewedAt;

  if (options.publish === true) {
    if (!pr.remote || !pr.remote.number) {
      throw new Error(`Cannot publish ${getRoleLabel(AGENT_ROLES.REVIEW)} without a remote PR number.`);
    }
    const repo = resolveGithubRepo(rootDir);
    const token = resolveGithubAuthToken({ required: true });
    try {
      await publishReview(repo, token, pr.remote.number, decisionRecord);
    } catch (error) {
      if (!isSelfPullRequestReviewError(error)) {
        throw error;
      }
      await addIssueComment(repo, token, pr.remote.number, decisionRecord.publishedSummary || decisionRecord.summary || '');
      decisionRecord.remotePublishFallback = 'issue_comment';
    }
  }

  const paths = getAutonomyPaths(rootDir);
  writeJson(paths.prsState, state.prs);
  writeTaskQueues(rootDir, state.config, state.taskQueues);
  appendAgentLog(rootDir, state.config, reviewerId, buildRoleEventName(AGENT_ROLES.REVIEW, 'record'), {
    input: {
      prId: pr.id,
      decision,
      summary: decisionRecord.summary,
    },
    output: {
      reviewerTaskId: reviewerTask.id,
      status: reviewerTask.status,
    },
  });
  appendAgentLog(rootDir, state.config, pr.agentId, buildRoleEventName(AGENT_ROLES.REVIEW, 'feedback'), {
    input: {
      prId: pr.id,
      reviewerId,
    },
    output: {
      decision,
      taskStatus: followupTask
        ? followupTask.status
        : task
          ? task.status
          : decision === 'approved'
            ? 'approved'
            : 'queued_followup',
    },
  });

  printOutput(options, { pr, [getRoleLabel(AGENT_ROLES.REVIEW)]: decisionRecord }, () => {
    console.log(`Recorded ${decision} ${getRoleLabel(AGENT_ROLES.REVIEW)} on ${pr.id}`);
  });
}


export { run };
