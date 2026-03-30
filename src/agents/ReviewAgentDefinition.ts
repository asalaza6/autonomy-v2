import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES, buildRoleEventName, getRoleAgentLabel, getRoleLabel } from './role-catalog.js';
import type { AgentConfig, AutonomyConfig, PullRequestRecord, TaskRecord, AnyRecord } from '../types.js';
import type { AgentExecutionContext, ClaimedReviewWork, ClaimedWork, ExecutionResult } from './AgentDefinition.js';

class ReviewAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.REVIEW);
  }

  usesTrackedQueue(): boolean {
    return true;
  }

  validateConfig(agent?: AgentConfig, sourcePath = '', helpers: any = {}): void {
    this.validateTrackedQueueConfig(agent, sourcePath, helpers);
  }

  buildSystemPrompt(agent: AgentConfig, config: AutonomyConfig): string {
    const agentLabel = this.getDisplayName(agent);
    const integrationBranch = config.integrationBranch || 'dev';
    const productionBranch = config.productionBranch || 'main';
    const projectName = config.projectName || 'this repository';

    return [
      `# ${agentLabel} System`,
      '',
      `You are the gate and integration agent for ${projectName}.`,
      '',
      '## Role',
      '',
      '- Evaluate pull requests created by feature agents.',
      '- Focus on correctness, regressions, missing tests, scope violations, and unsafe merges.',
      '- Approve or request changes.',
      `- Merge approved PRs into \`${integrationBranch}\`.`,
      '',
      '## Hard Rules',
      '',
      '- Never gate your own authored work.',
      '- Do not implement feature changes while gating.',
      '- Treat missing required checks as blocking.',
      `- Never target \`${productionBranch}\` or \`master\`.`,
      '',
      '## Review Priorities',
      '',
      '1. Behavioral regressions',
      '2. Scope violations',
      '3. Missing or weak verification',
      '4. Merge safety',
      '5. Maintainability issues that materially affect delivery',
      '',
    ].join('\n');
  }

  canRun(context: AgentExecutionContext): boolean {
    if (context.phase !== 'schedule') {
      return false;
    }
    if (context.options && (context.options.suppressNonPmDispatch === true || context.options.hasPlanningPrd === true)) {
      return false;
    }
    const queue = context.current && context.current.queues ? context.current.queues[context.agent.id] : null;
    if (!queue) {
      return false;
    }
    return (context.queueStore.listTasks?.(queue) || []).some((task) => task.status === 'queued');
  }

  claimWork(context: AgentExecutionContext): ClaimedWork | null {
    if (context.phase !== 'worker' || !context.queueStore.claimQueuedReviewTask) {
      return null;
    }
    const reviewTask = context.queueStore.claimQueuedReviewTask(context.agent.id);
    if (!reviewTask) {
      return null;
    }
    return {
      kind: AGENT_ROLES.REVIEW,
      agentId: context.agent.id,
      reason: 'review_queue',
      reviewTaskId: reviewTask.id,
      prId: String(reviewTask.prId || ''),
      sourceAgentId: String(reviewTask.sourceAgentId || ''),
      reviewTask,
    };
  }

  execute(context: AgentExecutionContext, work: ClaimedWork): ExecutionResult | Promise<ExecutionResult> {
    if (work.kind !== AGENT_ROLES.REVIEW) {
      return super.execute(context, work);
    }
    if (context.phase === 'worker') {
      return this.executeWorkerDispatch(context, work);
    }
    if (context.phase === 'runner') {
      return this.executeRunnerReview(context, work);
    }
    return super.execute(context, work);
  }

  private executeWorkerDispatch(context: AgentExecutionContext, work: ClaimedReviewWork): ExecutionResult {
    if (!work.reviewTask || !work.prId || !context.runtimeStore.executeRunner) {
      return {
        ok: true,
        status: 'noop',
        reason: 'no_queued_review',
      };
    }
    let runner = null;
    try {
      runner = context.runtimeStore.executeRunner({
        AUTONOMY_ROOT: context.rootDir,
        AUTONOMY_AGENT_ID: context.agent.id,
        AUTONOMY_REVIEW_TASK_ID: work.reviewTask.id,
        AUTONOMY_PR_ID: work.prId,
        AUTONOMY_SOURCE_AGENT_ID: work.sourceAgentId || '',
      });
    } catch (error) {
      context.queueStore.markReviewDispatchFailure?.(context.agent.id, work.reviewTask.id, this.extractErrorMessage(error));
      throw error;
    }
    context.logger.appendAgentLog?.(context.agent.id, 'worker:dispatch', {
      input: {
        taskId: work.reviewTask.id,
        prId: work.reviewTask.prId,
      },
      output: {
        status: work.reviewTask.status,
        runner,
      },
    });

    return {
      ok: true,
      status: 'assigned',
      taskId: work.reviewTask.id,
      prId: work.prId,
      runner,
    };
  }

  private async executeRunnerReview(context: AgentExecutionContext, work: ClaimedReviewWork): Promise<ExecutionResult> {
    const runnerState = context.runtimeStore.loadState
      ? context.runtimeStore.loadState()
      : { config: context.config, queues: context.current && context.current.queues ? context.current.queues : {} };
    const reviewerTask = context.queueStore.getReviewTask
      ? context.queueStore.getReviewTask(runnerState.queues, work.reviewTaskId)
      : work.reviewTask;
    const pr = context.prStore.getPr ? context.prStore.getPr(work.prId) : null;
    if (!reviewerTask || !pr) {
      throw new Error(`Unable to resolve gate context for "${work.reviewTaskId}".`);
    }
    const reviewRound = Number(reviewerTask.reviewRound || 1);

    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'start'), {
      agentId: context.agent.id,
      reviewTaskId: work.reviewTaskId,
      prId: pr.id,
      sourceAgentId: work.sourceAgentId,
      stub: context.codex.useStub?.() === true,
    });
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'read-task'), {
      reviewTaskId: work.reviewTaskId,
      prId: pr.id,
      sourceAgentId: work.sourceAgentId,
      reviewRound,
      prStatus: pr.status,
      commitCount: this.getPrCommitCount(pr),
      lastDecision: reviewerTask.lastDecision || null,
      stub: context.codex.useStub?.() === true,
    });

    if (context.codex.useStub?.() === true) {
      return this.executeRunnerStubReview(context, {
        reviewerTask,
        pr,
        reviewRound,
        sourceAgentId: work.sourceAgentId || '',
      });
    }

    if (this.shouldRetryApprovedPrMerge(pr, reviewerTask)) {
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'merge-retry'), {
        reviewTaskId: work.reviewTaskId,
        prId: pr.id,
        reviewRound,
        commitCount: this.getPrCommitCount(pr),
      });
      const mergeResult = context.scm.tryMergeWithRetry
        ? context.scm.tryMergeWithRetry(pr.id, context.agent.id)
        : { merged: false, message: 'merge retry unavailable' };
      const mergeCommentPublished = !mergeResult.merged
        ? Boolean(context.reviewClient.publishMergeFollowupCommentIfNeeded?.(pr, reviewerTask, mergeResult.message))
        : false;
      if (!mergeResult.merged) {
        context.queueStore.persistReviewerTaskState?.(work.reviewTaskId, {
          status: 'approved',
          updatedAt: context.clock.now(),
          lastError: null,
          lastMergeFailureMessage: this.normalizeNonEmptyString(mergeResult.message),
        });
      }
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'done'), {
        reviewTaskId: work.reviewTaskId,
        prId: pr.id,
        decision: 'approve',
        merged: mergeResult.merged,
        mergeMessage: mergeResult.message,
        followupOnly: true,
      });
      context.logger.appendRunnerLog?.(context.agent.id, ['runner', getRoleLabel(AGENT_ROLES.REVIEW)].join(':'), {
        input: {
          reviewTaskId: work.reviewTaskId,
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
      return {
        ok: true,
        status: 'approved',
        prId: pr.id,
        merged: mergeResult.merged,
        mergeMessage: mergeResult.message,
      };
    }

    const reviewContext = context.scm.ensureReviewContext ? context.scm.ensureReviewContext(pr) : { branch: pr.headBranch, worktreePath: '' };
    const reviewCommits = context.scm.listBranchCommits ? context.scm.listBranchCommits(reviewContext.worktreePath, pr.baseBranch) : [];
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'read-commits'), {
      reviewTaskId: work.reviewTaskId,
      prId: pr.id,
      baseBranch: pr.baseBranch,
      commitCount: reviewCommits.length,
      commits: reviewCommits,
    });
    const reviewDiffFiles = context.scm.listReviewDiffFiles ? context.scm.listReviewDiffFiles(reviewContext.worktreePath, pr.baseBranch) : [];
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'read-diff'), {
      reviewTaskId: work.reviewTaskId,
      prId: pr.id,
      baseBranch: pr.baseBranch,
      fileCount: reviewDiffFiles.length,
      files: reviewDiffFiles,
    });
    const sourceAgentId = work.sourceAgentId || pr.agentId;
    const sourceAgent = (runnerState.config.agents || []).find((candidate) => candidate.id === sourceAgentId);
    const scopeResult = context.scopeEvaluator.evaluate
      ? context.scopeEvaluator.evaluate({
          files: reviewDiffFiles,
          agent: sourceAgent,
          task: { id: pr.taskId },
        })
      : { ok: true, violations: [] };
    context.scm.ensureCheckEnvironment?.(reviewContext.worktreePath, pr.checks || []);
    const checkResults = context.scm.runCheckCommands ? context.scm.runCheckCommands(reviewContext.worktreePath, pr.checks || []) : [];
    const codexReview = context.codex.reviewPr
      ? await context.codex.reviewPr({
          rootDir: context.rootDir,
          agent: context.agent,
          reviewTask: reviewerTask,
          pr,
          branch: reviewContext.branch,
          worktreePath: reviewContext.worktreePath,
          checkResults,
          diffFiles: reviewDiffFiles,
          scopeResult,
        })
      : { decision: 'changes_requested', summary: '', concerns: [] };
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'codex'), {
      reviewTaskId: work.reviewTaskId,
      decision: codexReview.decision,
      summary: this.summarizeText(codexReview.summary),
    });

    const failedChecks = checkResults.filter((entry) => entry.status === 'failed');
    const shouldForceApproveAfterThreeRounds = this.shouldForceApproveAfterRepeatedReviews(pr);
    const scopeConcernOnly = scopeResult.ok && this.isScopeOnlyReviewFeedback(codexReview);
    const checkExpectationOnly = failedChecks.length === 0
      && this.isCheckExpectationOnlyReviewFeedback(codexReview, checkResults, pr.checks || []);
    const decision = shouldForceApproveAfterThreeRounds
      ? 'approve'
      : failedChecks.length > 0
        ? 'changes-requested'
        : !scopeResult.ok
          ? 'changes-requested'
          : scopeConcernOnly
            ? 'approve'
            : checkExpectationOnly
              ? 'approve'
            : codexReview.decision === 'approved'
              ? 'approve'
              : 'changes-requested';
    const summaryParts = scopeConcernOnly
      ? [this.buildScopeSafeApprovalSummary(pr, reviewDiffFiles, checkResults)]
      : checkExpectationOnly
        ? [this.buildScopeSafeApprovalSummary(pr, reviewDiffFiles, checkResults)]
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

    context.prStore.recordReviewDecision?.({
      prId: pr.id,
      reviewerId: context.agent.id,
      decision,
      summary,
      publish: Boolean(pr.remote && pr.remote.number && context.reviewClient.hasGithubAuth?.()),
    });

    let merged = false;
    let mergeMessage = null;
    let mergeCommentPublished = false;
    if (decision === 'approve') {
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'merge-attempt'), {
        reviewTaskId: work.reviewTaskId,
        prId: pr.id,
        reviewRound,
      });
      const mergeResult = context.scm.tryMergeWithRetry
        ? context.scm.tryMergeWithRetry(pr.id, context.agent.id)
        : { merged: false, message: 'merge unavailable' };
      merged = mergeResult.merged;
      mergeMessage = mergeResult.message;
      if (!merged) {
        mergeCommentPublished = Boolean(context.reviewClient.publishMergeFollowupCommentIfNeeded?.(pr, reviewerTask, mergeMessage));
        context.queueStore.persistReviewerTaskState?.(work.reviewTaskId, {
          status: 'approved',
          updatedAt: context.clock.now(),
          lastMergeFailureMessage: this.normalizeNonEmptyString(mergeMessage),
        });
      }
    }
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'done'), {
      reviewTaskId: work.reviewTaskId,
      prId: pr.id,
      decision,
      merged,
      mergeMessage,
    });
    context.logger.appendRunnerLog?.(context.agent.id, ['runner', getRoleLabel(AGENT_ROLES.REVIEW)].join(':'), {
      input: {
        reviewTaskId: work.reviewTaskId,
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
        checkExpectationOnly,
        summary,
        merged,
        mergeMessage,
        mergeCommentPublished,
      },
    });

    return {
      ok: true,
      status: decision === 'approve' ? 'approved' : 'changes-requested',
      prId: pr.id,
      merged,
      mergeMessage,
      decision,
    };
  }

  private executeRunnerStubReview(context: AgentExecutionContext, input: {
    reviewerTask: TaskRecord;
    pr: PullRequestRecord;
    reviewRound: number;
    sourceAgentId: string;
  }): ExecutionResult {
    const { reviewerTask, pr, reviewRound, sourceAgentId } = input;
    const decision = reviewRound === 1 ? 'changes-requested' : 'approve';
    const summary = reviewRound === 1
      ? `Add one more ${sourceAgentId.replace(/-agent$/, '') || 'feature'} follow-up line before merge.`
      : `Ready to merge ${pr.title}.`;

    if (pr.remote && pr.remote.number && context.reviewClient.hasGithubAuth?.()) {
      const repo = context.reviewClient.resolveGithubRepo?.();
      const token = context.reviewClient.resolveGithubAuthToken?.({ required: true }) || '';
      context.reviewClient.postIssueComment?.(
        repo,
        token,
        pr.remote.number,
        `${getRoleAgentLabel(AGENT_ROLES.REVIEW).replace(/\s+/g, '-')}:\n\n${summary}`
      );
    }

    context.prStore.recordReviewDecision?.({
      prId: pr.id,
      reviewerId: context.agent.id,
      decision,
      summary,
      publish: false,
    });

    let merged = false;
    let mergeMessage = null;
    if (decision === 'approve') {
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'merge-attempt'), {
        reviewTaskId: reviewerTask.id,
        prId: pr.id,
        reviewRound,
        stub: true,
      });
      const mergeResult = context.scm.tryMergeWithRetry
        ? context.scm.tryMergeWithRetry(pr.id, context.agent.id)
        : { merged: false, message: 'merge unavailable' };
      merged = mergeResult.merged;
      mergeMessage = mergeResult.message;
    }
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.REVIEW, 'done'), {
      reviewTaskId: reviewerTask.id,
      prId: pr.id,
      decision,
      merged,
      mergeMessage,
      stub: true,
    });
    context.logger.appendRunnerLog?.(context.agent.id, ['runner', getRoleLabel(AGENT_ROLES.REVIEW)].join(':'), {
      input: {
        reviewTaskId: reviewerTask.id,
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

    return {
      ok: true,
      status: decision === 'approve' ? 'approved' : 'changes-requested',
      prId: pr.id,
      merged,
      mergeMessage,
      decision,
    };
  }

  private latestReviewDecision(pr: PullRequestRecord): string {
    if (!pr || !Array.isArray(pr.reviews) || pr.reviews.length === 0) {
      return '';
    }
    return String(pr.reviews[pr.reviews.length - 1].decision || '');
  }

  private getPrCommitCount(pr: PullRequestRecord): number {
    const count = Number(pr && (pr.commitCount || (pr.remote && pr.remote.commitCount)));
    return Number.isFinite(count) ? count : 0;
  }

  private shouldRetryApprovedPrMerge(pr: PullRequestRecord, reviewerTask: TaskRecord): boolean {
    if (this.latestReviewDecision(pr) !== 'approved') {
      return false;
    }
    if (pr && pr.mergedAt) {
      return false;
    }
    if (pr && pr.remote && pr.remote.mergedAt) {
      return false;
    }
    const reviewedCommitCount = Number(reviewerTask && reviewerTask.reviewedCommitCount);
    const currentCommitCount = this.getPrCommitCount(pr);
    if (Number.isFinite(reviewedCommitCount) && reviewedCommitCount > 0) {
      return currentCommitCount <= reviewedCommitCount;
    }
    return true;
  }

  private shouldForceApproveAfterRepeatedReviews(pr: PullRequestRecord): boolean {
    const reviewCount = Number.isFinite(Number(pr && pr.reviews && pr.reviews.length))
      ? Number(pr.reviews.length)
      : 0;
    return reviewCount >= 4;
  }

  private isScopeOnlyReviewFeedback(codexReview: AnyRecord): boolean {
    if (!codexReview || codexReview.decision !== 'changes_requested') {
      return false;
    }
    const summaryText = String(codexReview.summary || '').trim().toLowerCase();
    const concerns = Array.isArray(codexReview.concerns)
      ? codexReview.concerns.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
      : [];
    const scopeOnlyTexts = concerns.length > 0 ? concerns : (summaryText ? [summaryText] : []);
    if (scopeOnlyTexts.length === 0) {
      return false;
    }
    const scopeSignals = [
      /out-of-scope/,
      /outside (?:the )?(?:agent|lane) scope/,
      /agent scope/,
      /scope violation/,
      /extra file/,
      /unexpected file/,
      /unreviewed file/,
      /unreviewed diff/,
      /git diff --name-status/,
    ];
    const blockingSignals = [
      /blocking/,
      /not safe to merge/,
      /unimplemented/,
      /missing/,
      /absent/,
      /not present/,
      /placeholder/,
      /does not/,
      /never /,
      /still has/,
      /still lacks/,
      /gap/,
      /fails?/,
    ];
    if ([summaryText].concat(scopeOnlyTexts).some((entry) => blockingSignals.some((pattern) => pattern.test(entry)))) {
      return false;
    }
    return scopeOnlyTexts.every((entry) => scopeSignals.some((pattern) => pattern.test(entry)));
  }

  private buildScopeSafeApprovalSummary(pr: PullRequestRecord, diffFiles: string[], checkResults: AnyRecord[]): string {
    const changed = diffFiles.length > 0 ? diffFiles.join(', ') : 'no file changes';
    const passedChecks = checkResults
      .filter((entry) => entry.status === 'passed')
      .map((entry) => entry.command)
      .join(', ');
    const checksText = passedChecks ? ` The provided required checks passed: ${passedChecks}.` : '';
    return `Approved. Compared against origin/${pr.baseBranch}, the diff stays within the lane agent scope (${changed}).${checksText}`;
  }

  private summarizeText(value: unknown): string {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }

  private normalizeNonEmptyString(value: unknown): string {
    const normalized = String(value || '').trim();
    return normalized || '';
  }

  private extractErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
      const maybeError = error as { stderr?: string; stdout?: string; message?: string; };
      if (typeof maybeError.stderr === 'string' && maybeError.stderr.trim()) {
        return maybeError.stderr.trim();
      }
      if (typeof maybeError.stdout === 'string' && maybeError.stdout.trim()) {
        return maybeError.stdout.trim();
      }
      if (typeof maybeError.message === 'string' && maybeError.message.trim()) {
        return maybeError.message.trim();
      }
    }
    return String(error || 'Command failed without stderr/stdout output.').trim();
  }

  private isCheckExpectationOnlyReviewFeedback(codexReview: AnyRecord, checkResults: AnyRecord[], configuredChecks: string[]): boolean {
    if (!codexReview || codexReview.decision !== 'changes_requested') {
      return false;
    }

    const texts = [codexReview.summary].concat(codexReview.concerns || [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    if (texts.length === 0) {
      return false;
    }

    const normalizedTexts = texts.map((entry) => entry.toLowerCase());
    const verificationSignals = [
      /missing required checks?/,
      /required deterministic verification/,
      /wrapper only reports/,
      /wrapper-reported pass/,
      /deterministic wrapper results/,
      /deterministic checks are missing/,
    ];
    const nonCheckBlockingSignals = [
      /scope violation/,
      /out-of-scope/,
      /regression/,
      /incorrect/,
      /bug/,
      /broken/,
      /fail(?:s|ed|ing)?\b/,
      /error/,
      /unsafe/,
      /merge conflict/,
      /documentation issue/,
    ];

    if (!normalizedTexts.every((entry) => verificationSignals.some((pattern) => pattern.test(entry)))) {
      return false;
    }
    if (normalizedTexts.some((entry) => nonCheckBlockingSignals.some((pattern) => pattern.test(entry)))) {
      return false;
    }

    const passedChecks = new Set(
      (Array.isArray(checkResults) ? checkResults : [])
        .filter((entry) => entry && entry.status === 'passed')
        .map((entry) => String(entry.command || '').trim())
        .filter(Boolean)
    );
    const requiredChecks = new Set(
      (Array.isArray(configuredChecks) ? configuredChecks : [])
        .map((entry) => String(entry || '').trim())
        .filter(Boolean)
    );
    const mentionedCommands = new Set<string>();
    texts.forEach((entry) => {
      const literalMatches = entry.match(/`([^`]+)`/g) || [];
      literalMatches.forEach((match) => {
        mentionedCommands.add(match.slice(1, -1).trim());
      });
      const commandMatches = entry.match(/npm run [a-z0-9:_-]+/gi) || [];
      commandMatches.forEach((match) => {
        mentionedCommands.add(match.trim());
      });
    });

    const inventedCommands = Array.from(mentionedCommands)
      .filter((command) => command.startsWith('npm run '))
      .filter((command) => !requiredChecks.has(command))
      .filter((command) => !passedChecks.has(command));

    return inventedCommands.length > 0;
  }
}


export { ReviewAgentDefinition };
