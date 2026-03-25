async function runReviewFlow(params, deps) {
  const { rootDir, agentId, reviewTaskId, prId, sourceAgentId } = params;
  const {
    AGENT_ROLES,
    appendRunnerLog,
    buildRoleEventName,
    getPr,
    getPrCommitCount,
    getReviewTask,
    getRoleLabel,
    getRoleAgentLabel,
    hasGithubAuth,
    isScopeOnlyReviewFeedback,
    listBranchCommits,
    listReviewDiffFiles,
    loadState,
    logRunnerEvent,
    normalizeNonEmptyString,
    persistReviewerTaskState,
    publishMergeFollowupCommentIfNeeded,
    resolveGithubAuthToken,
    resolveGithubRepo,
    reviewPrWithCodex,
    runCheckCommands,
    shouldForceApproveAfterRepeatedReviews,
    shouldRetryApprovedPrMerge,
    summarizeText,
    ensureReviewContext,
    ensureCheckEnvironment,
    evaluateScope,
    getAgentConfig,
    tryMergeWithRetry,
    buildScopeSafeApprovalSummary,
    postIssueComment,
    execFileSync,
    CLI_PATH,
    useCodexStub,
  } = deps;

  if (useCodexStub()) {
    return runReviewStubFlow(params, deps);
  }

  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'start'), { agentId, reviewTaskId, prId, sourceAgentId });
  const state = loadState(rootDir);
  const agent = getAgentConfig(state.config, agentId);
  const reviewerTask = getReviewTask(state.queues, reviewTaskId);
  const pr = getPr(rootDir, prId);
  const reviewRound = Number(reviewerTask.reviewRound || 1);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'read-task'), {
    reviewTaskId,
    prId: pr.id,
    sourceAgentId,
    reviewRound,
    prStatus: pr.status,
    commitCount: getPrCommitCount(pr),
    lastDecision: reviewerTask.lastDecision || null,
  });
  if (shouldRetryApprovedPrMerge(pr, reviewerTask)) {
    logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'merge-retry'), {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
      commitCount: getPrCommitCount(pr),
    });
    const mergeResult = tryMergeWithRetry(rootDir, pr.id, agentId);
    const mergeCommentPublished = !mergeResult.merged
      ? publishMergeFollowupCommentIfNeeded(rootDir, pr, reviewerTask, mergeResult.message)
      : false;
    if (!mergeResult.merged) {
      persistReviewerTaskState(rootDir, state.config, reviewTaskId, {
        status: 'approved',
        updatedAt: new Date().toISOString(),
        lastError: null,
        lastMergeFailureMessage: normalizeNonEmptyString(mergeResult.message),
      });
    }
    logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'done'), {
      reviewTaskId,
      prId: pr.id,
      decision: 'approve',
      merged: mergeResult.merged,
      mergeMessage: mergeResult.message,
      followupOnly: true,
    });

    appendRunnerLog(rootDir, agentId, ['runner', getRoleLabel(AGENT_ROLES.REVIEW)].join(':'), {
      input: {
        reviewTaskId,
        prId: pr.id,
        reviewRound,
        followupOnly: true,
      },
      output: {
        decision: 'approve',
        merged: mergeResult.merged,
        mergeMessage: mergeResult.message,
        mergeCommentPublished,
      },
    });
    return;
  }

  const reviewContext = ensureReviewContext(rootDir, pr);
  const reviewCommits = listBranchCommits(reviewContext.worktreePath, pr.baseBranch);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'read-commits'), {
    reviewTaskId,
    prId: pr.id,
    baseBranch: pr.baseBranch,
    commitCount: reviewCommits.length,
    commits: reviewCommits,
  });
  const reviewDiffFiles = listReviewDiffFiles(reviewContext.worktreePath, pr.baseBranch);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'read-diff'), {
    reviewTaskId,
    prId: pr.id,
    baseBranch: pr.baseBranch,
    fileCount: reviewDiffFiles.length,
    files: reviewDiffFiles,
  });
  const scopeResult = evaluateScope({
    files: reviewDiffFiles,
    agent: getAgentConfig(state.config, sourceAgentId || pr.agentId),
    task: { id: pr.taskId },
  });
  ensureCheckEnvironment(reviewContext.worktreePath, pr.checks || []);
  const checkResults = runCheckCommands(reviewContext.worktreePath, pr.checks || []);
  const codexReview = await reviewPrWithCodex({
    rootDir,
    agent,
    reviewTask: reviewerTask,
    pr,
    branch: reviewContext.branch,
    worktreePath: reviewContext.worktreePath,
    checkResults,
    diffFiles: reviewDiffFiles,
    scopeResult,
  });
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'codex'), {
    reviewTaskId,
    decision: codexReview.decision,
    summary: summarizeText(codexReview.summary),
  });

  const failedChecks = checkResults.filter((entry) => entry.status === 'failed');
  const shouldForceApproveAfterThreeRounds = shouldForceApproveAfterRepeatedReviews(pr, checkResults, scopeResult);
  const scopeConcernOnly = scopeResult.ok && isScopeOnlyReviewFeedback(codexReview);
  const decision = shouldForceApproveAfterThreeRounds
    ? 'approve'
    : failedChecks.length > 0
      ? 'changes-requested'
      : !scopeResult.ok
        ? 'changes-requested'
        : scopeConcernOnly
          ? 'approve'
          : codexReview.decision === 'approved'
            ? 'approve'
            : 'changes-requested';
  const summaryParts = scopeConcernOnly
    ? [buildScopeSafeApprovalSummary(pr, reviewDiffFiles, checkResults)]
    : [codexReview.summary].concat(codexReview.concerns || []);
  if (shouldForceApproveAfterThreeRounds) {
    summaryParts.push('Auto-approval threshold reached: 4+ reviewer rounds with passing checks/scope.');
  }
  if (failedChecks.length > 0) {
    summaryParts.push(`Blocking checks failed: ${failedChecks.map((entry) => entry.command).join(', ')}`);
  }
  if (!scopeResult.ok) {
    summaryParts.push(`Blocking scope violations: ${scopeResult.violations.map((entry) => `${entry.file} (${entry.reason})`).join(', ')}`);
  }
  const summary = summaryParts.filter(Boolean).join('\n');

  const reviewArgs = [
    CLI_PATH,
    buildRoleEventName(AGENT_ROLES.REVIEW, 'record'),
    '--root',
    rootDir,
    '--pr',
    pr.id,
    '--reviewer',
    agentId,
    '--decision',
    decision,
    '--summary',
    summary,
  ];
  if (pr.remote && pr.remote.number && hasGithubAuth()) {
    reviewArgs.push('--publish');
  }
  execFileSync(process.execPath, reviewArgs, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let merged = false;
  let mergeMessage = null;
  let mergeCommentPublished = false;
  if (decision === 'approve') {
    logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'merge-attempt'), {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
    });
    const mergeResult = tryMergeWithRetry(rootDir, pr.id, agentId);
    merged = mergeResult.merged;
    mergeMessage = mergeResult.message;
    if (!merged) {
      mergeCommentPublished = publishMergeFollowupCommentIfNeeded(rootDir, pr, reviewerTask, mergeMessage);
      persistReviewerTaskState(rootDir, state.config, reviewTaskId, {
        status: 'approved',
        updatedAt: new Date().toISOString(),
        lastMergeFailureMessage: normalizeNonEmptyString(mergeMessage),
      });
    }
  }
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'done'), {
    reviewTaskId,
    prId: pr.id,
    decision,
    merged,
    mergeMessage,
  });

  appendRunnerLog(rootDir, agentId, ['runner', getRoleLabel(AGENT_ROLES.REVIEW)].join(':'), {
    input: {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
      branch: reviewContext.branch,
      worktreePath: reviewContext.worktreePath,
    },
    output: {
      codex: codexReview,
      diffFiles: reviewDiffFiles,
      scopeResult,
      checkResults,
      decision,
      scopeConcernOnly,
      summary,
      merged,
      mergeMessage,
      mergeCommentPublished,
    },
  });
}

function runReviewStubFlow(params, deps) {
  const { rootDir, agentId, reviewTaskId, prId, sourceAgentId } = params;
  const {
    AGENT_ROLES,
    appendRunnerLog,
    buildRoleEventName,
    getPr,
    getPrCommitCount,
    getReviewTask,
    getRoleLabel,
    hasGithubAuth,
    loadState,
    logRunnerEvent,
    postIssueComment,
    resolveGithubAuthToken,
    resolveGithubRepo,
    tryMergeWithRetry,
    execFileSync,
    CLI_PATH,
  } = deps;

  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'start'), { agentId, reviewTaskId, prId, sourceAgentId, stub: true });
  const state = loadState(rootDir);
  const reviewerTask = getReviewTask(state.queues, reviewTaskId);
  const pr = getPr(rootDir, prId);
  const reviewRound = Number(reviewerTask.reviewRound || 1);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'read-task'), {
    reviewTaskId,
    prId: pr.id,
    sourceAgentId,
    reviewRound,
    prStatus: pr.status,
    commitCount: getPrCommitCount(pr),
    lastDecision: reviewerTask.lastDecision || null,
    stub: true,
  });
  const decision = reviewRound === 1 ? 'changes-requested' : 'approve';
  const summary = reviewRound === 1
    ? `Add one more ${sourceAgentId.replace(/-agent$/, '') || 'feature'} follow-up line before merge.`
    : `Ready to merge ${pr.title}.`;

  if (pr.remote && pr.remote.number && hasGithubAuth()) {
    const repo = resolveGithubRepo(rootDir);
    postIssueComment(repo, resolveGithubAuthToken({ required: true }), pr.remote.number, `${getRoleAgentLabel(AGENT_ROLES.REVIEW).replace(/\s+/g, '-')}:\n\n${summary}`);
  }

  execFileSync(process.execPath, [
    CLI_PATH,
    buildRoleEventName(AGENT_ROLES.REVIEW, 'record'),
    '--root',
    rootDir,
    '--pr',
    pr.id,
    '--reviewer',
    agentId,
    '--decision',
    decision,
    '--summary',
    summary,
  ], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let merged = false;
  let mergeMessage = null;
  if (decision === 'approve') {
    logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'merge-attempt'), {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
      stub: true,
    });
    const mergeResult = tryMergeWithRetry(rootDir, pr.id, agentId);
    merged = mergeResult.merged;
    mergeMessage = mergeResult.message;
  }
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.REVIEW, 'done'), {
    reviewTaskId,
    prId: pr.id,
    decision,
    merged,
    mergeMessage,
    stub: true,
  });

  appendRunnerLog(rootDir, agentId, ['runner', getRoleLabel(AGENT_ROLES.REVIEW)].join(':'), {
    input: {
      reviewTaskId,
      prId: pr.id,
      reviewRound,
    },
    output: {
      decision,
      summary,
      merged,
      mergeMessage,
    },
  });
}


export { runReviewFlow };
export { runReviewStubFlow };
export default {
  runReviewFlow,
  runReviewStubFlow
};

