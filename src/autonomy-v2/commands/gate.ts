import { AGENT_ROLES, buildRoleEventName, getRoleLabel, isImplementationRole, isReviewRole, } from '../../agents/role-catalog.js';
import { addIssueComment, appendAgentLog, appendTrackedBranchFollowupTask, buildLaneFollowupTaskId, buildSignedReviewSummary, ensureInitialized, ensureReviewerTask, enqueueLaneFollowupTask, findTask, getAgent, getAutonomyPaths, getPr, getStringOption, isSelfPullRequestReviewError, loadAllState, normalizeReviewDecision, printOutput, publishReview, requireOption, resolveGithubAuthToken, resolveGithubRepo, uniqueStrings, writeJson, writeTaskQueues, } from './shared.js';

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
  const decisionRecord: any = {
    reviewerId,
    decision,
    summary: rawSummary,
    publishedSummary: buildSignedReviewSummary(reviewer, rawSummary),
    reviewedAt: new Date().toISOString(),
  };
  pr.reviews.push(decisionRecord);
  pr.updatedAt = decisionRecord.reviewedAt;
  pr.status = decision === 'approved' ? 'approved' : 'changes_requested';

  const task = findTask(state.taskQueues, pr.taskId);
  const implementationAgent = getAgent(state.config, pr.agentId);
  const usesTrackedImplementationQueue = isImplementationRole(implementationAgent.role);
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
      task.type = task.type || 'review_followup';
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
