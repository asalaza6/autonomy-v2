import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES, TASK_TYPES, buildRoleEventName, getRoleLabel } from './role-catalog.js';
import {
  getAgentConversationId,
  resolveReturnedConversationId,
  setAgentConversationReference,
} from './conversation-references.js';
import type { AgentConfig, AutonomyConfig, PullRequestRecord, QueueState, TaskRecord, AnyRecord } from '../types.js';
import type { AgentExecutionContext, ClaimedTaskWork, ClaimedWork, ExecutionResult } from './AgentDefinition.js';

class ImplementationAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.IMPLEMENTATION);
  }

  validateConfig(agent?: AgentConfig, sourcePath = '', helpers: any = {}): void {
    this.validateTrackedQueueConfig(agent, sourcePath, helpers);
  }

  validateScaffoldConfig(agent?: AgentConfig, sourcePath = ''): void {
    const checks = Array.isArray(agent && agent.checks) ? agent.checks : [];
    if (checks.length === 0 || checks.some((check) => String(check || '').trim().length === 0)) {
      throw new Error(
        `Invalid autonomy config at ${sourcePath}: feature agent "${agent && agent.id || '(unknown)'}" must define a non-empty checks array.`
      );
    }
  }

  usesTrackedQueue(): boolean {
    return true;
  }

  buildQueueState(agent: AgentConfig, tasks: TaskRecord[] = []): QueueState {
    return {
      schemaVersion: 1,
      agentId: agent.id,
      role: this.roleId,
      tasks,
    };
  }

  buildSystemPrompt(agent: AgentConfig, config: AutonomyConfig): string {
    const agentLabel = this.getDisplayName(agent);
    const integrationBranch = config.integrationBranch || 'dev';
    const productionBranch = config.productionBranch || 'main';
    const projectName = config.projectName || 'this repository';
    const roleLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
    const scopeLines = Array.isArray(agent.include) && agent.include.length > 0
      ? agent.include.map((pattern) => `- Stay inside \`${pattern}\` unless the task explicitly expands scope.`)
      : ['- Stay inside your assigned scope.'];
    const checkLines = Array.isArray(agent.checks) && agent.checks.length > 0
      ? agent.checks.map((check) => `- ${check}`)
      : ['- Run the checks configured for your lane before publishing.'];
    const gateLabel = getRoleLabel(AGENT_ROLES.REVIEW);

    return [
      `# ${agentLabel} System`,
      '',
      `You are the ${agentLabel} ${roleLabel} agent for ${projectName}.`,
      '',
      '## Project Context Source',
      '',
      'Before implementing, read:',
      '',
      '- `prompts/autonomous/v2/project-context.md`',
      '',
      'Treat that file as the project-specific context pack. It exists so you do not need to rediscover the whole repo before every task.',
      '',
      '## Role',
      '',
      '- Implement only tasks assigned to you.',
      `- Work only from task branches based on \`${integrationBranch}\`.`,
      `- Open or update pull requests targeting \`${integrationBranch}\`.`,
      '',
      '## Hard Rules',
      '',
      '- Edit only files within your configured agent scope.',
      ...scopeLines,
      `- Do not merge to \`${productionBranch}\` or \`master\`.`,
      `- Do not merge directly to \`${integrationBranch}\`; publish changes for ${gateLabel}.`,
      '',
      '## Required Checks',
      '',
      ...checkLines,
      '',
      '## Required Workflow',
      '',
      '1. Read your current tracked queue task and acceptance criteria.',
      '2. Work inside the assigned worktree and branch.',
      '3. Run required checks before publishing.',
      '4. Keep the diff focused on your lane.',
      `5. Update the PR when ${gateLabel} asks for changes.`,
      '',
    ].join('\n');
  }

  canRun(context: AgentExecutionContext): boolean {
    if (context.phase !== 'schedule') {
      return false;
    }
    if (context.options && context.options.suppressNonPmDispatch === true) {
      return false;
    }
    const queue = context.current && context.current.queues ? context.current.queues[context.agent.id] : null;
    if (!queue || !context.current || !context.current.branchLocks || !context.queueStore.resolveImplementationQueueContext) {
      return false;
    }
    const queueContext = context.queueStore.resolveImplementationQueueContext(context.agent, queue, context.current.branchLocks);
    const tasks = context.queueStore.listTasks?.(queueContext.queue) || [];
    return tasks.some((task) => context.queueStore.implementationTaskNeedsDispatch?.(task) === true);
  }

  claimWork(context: AgentExecutionContext): ClaimedWork | null {
    if (context.phase !== 'worker') {
      return null;
    }
    const queues = context.current && context.current.queues
      ? context.current.queues
      : (context.queueStore.loadQueues ? context.queueStore.loadQueues() : {});
    const queue = queues[context.agent.id];
    const branchLocks = context.current && context.current.branchLocks
      ? context.current.branchLocks
      : (context.branchLockStore.loadBranchLocks ? context.branchLockStore.loadBranchLocks() : { locks: [] });
    const prds = context.current && context.current.prds
      ? context.current.prds
      : (context.prdStore.loadPrds ? context.prdStore.loadPrds({ queues }) : { prds: [] });
    if (!queue || !context.queueStore.resolveImplementationQueueContext || !context.queueStore.selectImplementationTask) {
      return null;
    }
    const queueContext = context.queueStore.resolveImplementationQueueContext(context.agent, queue, branchLocks);
    const task = context.queueStore.selectImplementationTask(
      context.queueStore.listTasks?.(queueContext.queue) || [],
      prds.prds || []
    );
    if (!task) {
      return null;
    }

    let branch = queueContext.branch || task.branch || null;
    let worktreePath = queueContext.worktreePath || null;
    let dispatchTask = task;
    if ((queueContext.source !== 'branch' || !worktreePath || !context.scm.fsExists?.(worktreePath)) && context.scm.prepareTaskWorktree) {
      const prepared = context.scm.prepareTaskWorktree(task.id);
      branch = prepared.branch;
      worktreePath = prepared.worktreePath;
    }
    if (queueContext.source !== 'branch' && branch && worktreePath && context.queueStore.claimImplementationTaskInWorktree) {
      const claim = context.queueStore.claimImplementationTaskInWorktree(context.agent, task, branch, worktreePath);
      branch = claim.branch;
      dispatchTask = claim.task;
    }

    return {
      kind: 'task',
      agentId: context.agent.id,
      reason: 'queued_task',
      taskId: dispatchTask.id,
      branch,
      worktreePath,
      task,
      dispatchTask,
      queueContext,
    };
  }

  execute(context: AgentExecutionContext, work: ClaimedWork): ExecutionResult | Promise<ExecutionResult> {
    if (work.kind !== 'task') {
      return super.execute(context, work);
    }
    if (context.phase === 'worker') {
      return this.executeWorkerDispatch(context, work);
    }
    if (context.phase === 'runner') {
      return this.executeRunnerTask(context, work);
    }
    return super.execute(context, work);
  }

  private executeWorkerDispatch(context: AgentExecutionContext, work: ClaimedTaskWork): ExecutionResult {
    if (!work.dispatchTask || !work.branch || !work.worktreePath || !context.runtimeStore.executeRunner) {
      return {
        ok: true,
        status: 'noop',
        reason: 'no_queued_task',
      };
    }
    let runner = null;
    try {
      runner = context.runtimeStore.executeRunner({
        AUTONOMY_ROOT: context.rootDir,
        AUTONOMY_AGENT_ID: context.agent.id,
        AUTONOMY_TASK_ID: work.dispatchTask.id,
        AUTONOMY_BRANCH: work.branch,
        AUTONOMY_WORKTREE: work.worktreePath,
      });
    } catch (error) {
      throw error;
    }

    context.logger.appendAgentLog?.(context.agent.id, 'worker:dispatch', {
      input: {
        taskId: work.dispatchTask.id,
      },
      output: {
        branch: work.branch,
        worktreePath: work.worktreePath,
        runner,
      },
    });

    return {
      ok: true,
      status: 'active',
      taskId: work.dispatchTask.id,
      branch: work.branch,
      worktreePath: work.worktreePath,
      runner,
    };
  }

  private async executeRunnerTask(context: AgentExecutionContext, work: ClaimedTaskWork): Promise<ExecutionResult> {
    const worktreePath = String(work.worktreePath || '');
    const branch = String(work.branch || '');
    const runnerState = context.runtimeStore.loadState
      ? context.runtimeStore.loadState({
          worktreePath,
          implementationAgentId: context.agent.id,
        })
      : { config: context.config, queues: context.current && context.current.queues ? context.current.queues : {} };
    const agent = context.agent;
    const task = context.queueStore.getTask
      ? context.queueStore.getTask(runnerState.queues, work.taskId)
      : work.task || work.dispatchTask;
    if (!task) {
      throw new Error(`Unknown task "${work.taskId}".`);
    }
    const laneKey = context.queueStore.buildTaskLaneKey ? context.queueStore.buildTaskLaneKey(task) : (task.laneKey || task.id);
    const laneTasks = context.queueStore.getLaneTasks
      ? context.queueStore.getLaneTasks(runnerState.queues, context.agent.id, laneKey)
      : [];
    const remainingLaneTasks = laneTasks.filter((candidate) => candidate.id !== task.id && context.queueStore.isPendingImplementationTask?.(candidate));
    const existingPr = context.prStore.getPrForLane ? context.prStore.getPrForLane(context.agent.id, laneKey) : null;
    const completedLaneTasks = context.branchLockStore.getCompletedLaneTasks
      ? context.branchLockStore.getCompletedLaneTasks(context.agent.id, laneKey)
      : [];

    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'start'), {
      agentId: context.agent.id,
      taskId: task.id,
      branch,
      worktreePath,
      stub: context.codex.useStub?.() === true,
    });
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'read-task'), {
      taskId: task.id,
      taskType: task.type || TASK_TYPES.DEFAULT,
      laneKey,
      laneTaskIds: laneTasks.map((candidate) => candidate.id),
      remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
      completedTaskIds: completedLaneTasks.map((candidate) => candidate.id),
      existingPrId: existingPr ? existingPr.id : null,
      stub: context.codex.useStub?.() === true,
    });
    if (existingPr) {
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'read-pr'), {
        taskId: task.id,
        prId: existingPr.id,
        status: existingPr.status,
        commitCount: this.getPrCommitCount(existingPr),
        pendingTaskIds: existingPr.pendingTaskIds || [],
        reviewDecisions: (existingPr.reviews || []).map((decisionRecord) => decisionRecord.decision),
        stub: context.codex.useStub?.() === true,
      });
    }

    if (context.codex.useStub?.() === true) {
      return this.executeRunnerStubTask(context, {
        task,
        agent,
        laneKey,
        laneTasks,
        remainingLaneTasks,
        completedLaneTasks,
        existingPr,
        branch,
        worktreePath,
      });
    }

    const checkCommands = this.resolveCheckCommands({
      task,
      existingPr,
      remainingLaneTasks,
      completedLaneTasks,
    });
    context.scm.ensureCheckEnvironment?.(worktreePath, checkCommands);
    const codexResult = await this.executeCodexTask(context, {
      rootDir: context.rootDir,
      agent,
      task,
      laneTasks,
      pr: existingPr,
      branch,
      worktreePath,
    });
    const implementationConversationId = this.resolveReturnedImplementationConversationId(codexResult);
    if (implementationConversationId) {
      setAgentConversationReference(task, {
        agentId: agent.id,
        role: AGENT_ROLES.IMPLEMENTATION,
      }, implementationConversationId, context.clock.now());
    }
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'codex'), {
      taskId: task.id,
      status: codexResult.status,
      summary: this.summarizeText(codexResult.summary || codexResult.notes),
      implementationConversationId: task.implementationConversationId || null,
    });

    const changedFiles = context.scm.listChangedFiles ? context.scm.listChangedFiles(worktreePath) : [];
    let scopeResult: AnyRecord = {
      ok: true,
      files: changedFiles,
      includeGlobs: [],
      excludeGlobs: [],
      violations: [],
    };
    if (changedFiles.length > 0 && context.scopeEvaluator.evaluate) {
      scopeResult = context.scopeEvaluator.evaluate({
        files: changedFiles,
        agent,
        task,
      });
      if (!scopeResult.ok) {
        context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'scope-warning'), {
          taskId: task.id,
          violations: scopeResult.violations,
        });
      }
    }

    const checkResults = context.scm.runCheckCommands ? context.scm.runCheckCommands(worktreePath, checkCommands) : [];
    const failedChecks = checkResults.filter((entry) => entry.status === 'failed');
    if (failedChecks.length > 0) {
      throw new Error(`Required checks failed: ${failedChecks.map((entry) => entry.command).join(', ')}`);
    }

    const completionMode = changedFiles.length > 0 ? 'code' : 'noop';
    const queueUpdate = context.queueStore.markImplementationTaskComplete
      ? context.queueStore.markImplementationTaskComplete(worktreePath, runnerState.config, task, branch, completionMode)
      : null;
    const filesToCommit = this.uniqueStrings(changedFiles.concat(queueUpdate ? [queueUpdate.relativePath] : []));
    const commitMessage = context.scm.buildCommitMessage
      ? context.scm.buildCommitMessage(context.agent.id, task, completedLaneTasks.length > 0 || Boolean(existingPr))
      : `auto(${context.agent.id}): draft ${task.id}`;
    context.scm.runGit?.(worktreePath, ['add', '.']);
    if (!context.scm.hasStagedGitChanges?.(worktreePath)) {
      const completedTaskIds = context.branchLockStore.recordLaneTaskCompletion
        ? context.branchLockStore.recordLaneTaskCompletion(task, branch, worktreePath, scopeResult).map((candidate) => candidate.id)
        : [];
      const shouldRecordPr = Boolean(existingPr) || remainingLaneTasks.length === 0;
      if (shouldRecordPr) {
        context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'record-pr'), {
          taskId: task.id,
          branch,
          existingPrId: existingPr ? existingPr.id : null,
          completedTaskIds,
          publish: false,
          reason: 'no_staged_changes',
        });
      }
      context.prStore.finalizeTaskRun?.({
        rootDir: context.rootDir,
        task,
        branch,
        completedTaskIds,
        publish: false,
        shouldRecordPr,
      });
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'done'), {
        taskId: task.id,
        changedFiles: changedFiles.length,
        pushed: false,
        published: false,
        prRecorded: shouldRecordPr,
        completionMode,
        reason: 'no_staged_changes',
      });
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'commit-skip'), {
        taskId: task.id,
        branch,
        reason: 'no staged changes after git add .',
        changedFiles: filesToCommit,
      });
      return {
        ok: true,
        status: 'noop',
        taskId: task.id,
        branch,
        worktreePath,
        completedTaskIds,
        prRecorded: shouldRecordPr,
        reason: 'no_staged_changes',
      };
    }
    context.scm.runGit?.(worktreePath, ['commit', '-m', commitMessage]);
    const commitSha = context.scm.readGit ? context.scm.readGit(worktreePath, ['rev-parse', 'HEAD']) : '';
    const queueCommitUpdate = context.queueStore.recordImplementationTaskCommitSha
      ? context.queueStore.recordImplementationTaskCommitSha(worktreePath, runnerState.config, task, commitSha)
      : { changed: false, relativePath: '' };
    if (queueCommitUpdate.changed) {
      context.scm.runGit?.(worktreePath, ['add', '--', queueCommitUpdate.relativePath]);
      context.scm.runGit?.(worktreePath, ['commit', '-m', context.scm.buildQueueMetadataCommitMessage
        ? context.scm.buildQueueMetadataCommitMessage(context.agent.id, task)
        : `auto(${context.agent.id}): record ${task.id}`]);
    }
    const queueMetadataCommitSha = context.scm.readGit ? context.scm.readGit(worktreePath, ['rev-parse', 'HEAD']) : '';
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'commit'), {
      taskId: task.id,
      branch,
      commitMessage,
      commitSha,
      queueMetadataCommitSha,
      changedFiles: filesToCommit,
      completionMode,
    });
    const completedTaskIds = context.branchLockStore.recordLaneTaskCompletion
      ? context.branchLockStore.recordLaneTaskCompletion(task, branch, worktreePath, scopeResult).map((candidate) => candidate.id)
      : [];
    const pushResult = context.scm.tryPushBranch ? context.scm.tryPushBranch(worktreePath, branch) : { ok: false, message: 'push unsupported' };
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'push'), {
      taskId: task.id,
      branch,
      pushed: pushResult.ok,
      message: pushResult.message,
    });
    if (Boolean(existingPr) || remainingLaneTasks.length === 0) {
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'record-pr'), {
        taskId: task.id,
        branch,
        existingPrId: existingPr ? existingPr.id : null,
        completedTaskIds,
        publish: Boolean(pushResult.ok && context.reviewClient.hasGithubAuth?.()),
      });
    }
    context.prStore.finalizeTaskRun?.({
      rootDir: context.rootDir,
      task,
      branch,
      completedTaskIds,
      publish: pushResult.ok && Boolean(context.reviewClient.hasGithubAuth?.()),
      shouldRecordPr: Boolean(existingPr) || remainingLaneTasks.length === 0,
    });
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'done'), {
      taskId: task.id,
      changedFiles: changedFiles.length,
      commitMessage,
      pushed: pushResult.ok,
      published: Boolean(pushResult.ok && context.reviewClient.hasGithubAuth?.()),
      prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
    });

    context.logger.appendRunnerLog?.(context.agent.id, ['runner', getRoleLabel(AGENT_ROLES.IMPLEMENTATION)].join(':'), {
      input: {
        taskId: task.id,
        laneKey,
        laneTaskIds: laneTasks.map((candidate) => candidate.id),
        remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
        branch,
        worktreePath,
      },
      output: {
        changedFiles,
        checkResults,
        codex: codexResult,
        scopeResult,
        commitMessage,
        commitSha,
        queueMetadataCommitSha,
        completionMode,
        completedTaskIds,
        prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
        pushed: pushResult.ok,
        published: Boolean(pushResult.ok && context.reviewClient.hasGithubAuth?.()),
        pushMessage: pushResult.message,
      },
    });

    return {
      ok: true,
      status: 'done',
      taskId: task.id,
      branch,
      worktreePath,
      changedFiles,
      completionMode,
      completedTaskIds,
      pushed: pushResult.ok,
      published: Boolean(pushResult.ok && context.reviewClient.hasGithubAuth?.()),
    };
  }

  private executeRunnerStubTask(context: AgentExecutionContext, input: {
    task: TaskRecord;
    agent: AgentConfig;
    laneKey: string;
    laneTasks: TaskRecord[];
    remainingLaneTasks: TaskRecord[];
    completedLaneTasks: TaskRecord[];
    existingPr: PullRequestRecord | null;
    branch: string;
    worktreePath: string;
  }): ExecutionResult {
    const { task, agent, laneKey, laneTasks, remainingLaneTasks, completedLaneTasks, existingPr, branch, worktreePath } = input;
    const targetFile = context.scm.resolveTargetFile
      ? context.scm.resolveTargetFile(worktreePath, task, agent)
      : '';
    if (!targetFile) {
      throw new Error(`Unable to resolve target file for task "${task.id}".`);
    }
    context.scm.ensureDir?.(targetFile);
    const alreadyExists = context.scm.fsExists ? context.scm.fsExists(targetFile) : false;
    const generatedAt = context.clock.now();
    const content = alreadyExists && context.scm.readFile
      ? `${context.scm.readFile(targetFile).trimEnd()}\n- Follow-up (${task.id}): ${generatedAt}\n`
      : [
          `# ${task.title}`,
          '',
          `- Agent: ${context.agent.id}`,
          `- Task: ${task.id}`,
          `- Lane: ${laneKey}`,
          `- Generated: ${generatedAt}`,
          task.description ? `- Description: ${task.description}` : null,
          '',
          '## Acceptance',
          ...(task.acceptance || []).map((entry) => `- ${entry}`),
          `- Automated ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} runner created this draft change.`,
          '',
        ].filter(Boolean).join('\n');
    context.scm.writeFile?.(targetFile, content);
    const queueUpdate = context.queueStore.markImplementationTaskComplete
      ? context.queueStore.markImplementationTaskComplete(worktreePath, context.config, task, branch, 'code')
      : null;
    const stagedFiles = this.uniqueStrings([context.scm.relativePath ? context.scm.relativePath(worktreePath, targetFile) : targetFile].concat(queueUpdate ? [queueUpdate.relativePath] : []));
    context.scm.runGit?.(worktreePath, ['add', '--', ...stagedFiles]);
    const commitMessage = context.scm.buildCommitMessage
      ? context.scm.buildCommitMessage(context.agent.id, task, completedLaneTasks.length > 0 || Boolean(existingPr))
      : `auto(${context.agent.id}): draft ${task.id}`;
    context.scm.runGit?.(worktreePath, ['commit', '-m', commitMessage]);
    const commitSha = context.scm.readGit ? context.scm.readGit(worktreePath, ['rev-parse', 'HEAD']) : '';
    const queueCommitUpdate = context.queueStore.recordImplementationTaskCommitSha
      ? context.queueStore.recordImplementationTaskCommitSha(worktreePath, context.config, task, commitSha)
      : { changed: false, relativePath: '' };
    if (queueCommitUpdate.changed) {
      context.scm.runGit?.(worktreePath, ['add', '--', queueCommitUpdate.relativePath]);
      context.scm.runGit?.(worktreePath, ['commit', '-m', context.scm.buildQueueMetadataCommitMessage
        ? context.scm.buildQueueMetadataCommitMessage(context.agent.id, task)
        : `auto(${context.agent.id}): record ${task.id}`]);
    }
    const queueMetadataCommitSha = context.scm.readGit ? context.scm.readGit(worktreePath, ['rev-parse', 'HEAD']) : '';
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'commit'), {
      taskId: task.id,
      branch,
      commitMessage,
      commitSha,
      queueMetadataCommitSha,
      changedFiles: stagedFiles,
      stub: true,
    });
    const completedTaskIds = context.branchLockStore.recordLaneTaskCompletion
      ? context.branchLockStore.recordLaneTaskCompletion(task, branch, worktreePath).map((candidate) => candidate.id)
      : [];
    const pushResult = context.scm.tryPushBranch ? context.scm.tryPushBranch(worktreePath, branch) : { ok: false, message: 'push unsupported' };
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'push'), {
      taskId: task.id,
      branch,
      pushed: pushResult.ok,
      message: pushResult.message,
      stub: true,
    });
    if (Boolean(existingPr) || remainingLaneTasks.length === 0) {
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'record-pr'), {
        taskId: task.id,
        branch,
        existingPrId: existingPr ? existingPr.id : null,
        completedTaskIds,
        publish: Boolean(pushResult.ok && context.reviewClient.hasGithubAuth?.()),
        stub: true,
      });
    }
    context.prStore.finalizeTaskRun?.({
      rootDir: context.rootDir,
      task,
      branch,
      completedTaskIds,
      publish: pushResult.ok && Boolean(context.reviewClient.hasGithubAuth?.()),
      shouldRecordPr: Boolean(existingPr) || remainingLaneTasks.length === 0,
    });
    context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'done'), {
      taskId: task.id,
      changedFiles: 1,
      commitMessage,
      pushed: pushResult.ok,
      published: Boolean(pushResult.ok && context.reviewClient.hasGithubAuth?.()),
      prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
      stub: true,
    });

    context.logger.appendRunnerLog?.(context.agent.id, ['runner', getRoleLabel(AGENT_ROLES.IMPLEMENTATION)].join(':'), {
      input: {
        taskId: task.id,
        laneKey,
        laneTaskIds: laneTasks.map((candidate) => candidate.id),
        remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
        branch,
        worktreePath,
      },
      output: {
        targetFiles: [context.scm.relativePath ? context.scm.relativePath(worktreePath, targetFile) : targetFile],
        commitMessages: commitMessage ? [commitMessage] : [],
        commitSha,
        queueMetadataCommitSha,
        completionMode: 'code',
        completedTaskIds,
        prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
        pushed: pushResult.ok,
        published: Boolean(pushResult.ok && context.reviewClient.hasGithubAuth?.()),
        pushMessage: pushResult.message,
      },
    });

    return {
      ok: true,
      status: 'done',
      taskId: task.id,
      branch,
      worktreePath,
      completedTaskIds,
      pushed: pushResult.ok,
      published: Boolean(pushResult.ok && context.reviewClient.hasGithubAuth?.()),
    };
  }

  private resolveCheckCommands({ task, existingPr, remainingLaneTasks, completedLaneTasks }: {
    task: TaskRecord;
    existingPr: PullRequestRecord | null;
    remainingLaneTasks: TaskRecord[];
    completedLaneTasks: TaskRecord[];
  }): string[] {
    if (existingPr) {
      return this.uniqueStrings([
        ...(existingPr.checks || []),
        ...(task.checks || []),
      ]);
    }
    if (remainingLaneTasks.length === 0) {
      return this.uniqueStrings([
        ...completedLaneTasks.flatMap((candidate) => candidate.checks || []),
        ...(task.checks || []),
      ]);
    }
    return this.uniqueStrings(task.checks || []);
  }

  private async executeCodexTask(context: AgentExecutionContext, input: AnyRecord): Promise<AnyRecord> {
    if (!context.codex.executeTask) {
      return { status: 'noop' };
    }

    const resumeConversationId = this.getTaskImplementationConversationId(input.task, input.agent || context.agent);
    if (!resumeConversationId) {
      return context.codex.executeTask(input);
    }

    try {
      return await context.codex.executeTask({
        ...input,
        resumeConversationId,
      });
    } catch (error) {
      context.logger.logRunnerEvent?.(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'resume-fallback'), {
        taskId: input.task.id,
        implementationConversationId: resumeConversationId,
        reason: this.summarizeText(error && error.message),
      });
      return context.codex.executeTask({
        ...input,
        resumeConversationId: '',
        disableConversationResume: true,
      });
    }
  }

  private getTaskImplementationConversationId(value: AnyRecord | null | undefined, agent?: AgentConfig): string {
    return getAgentConversationId(value, {
      agentId: agent && agent.id || value && value.agentId,
      role: AGENT_ROLES.IMPLEMENTATION,
    });
  }

  private resolveReturnedImplementationConversationId(value: AnyRecord | null | undefined): string {
    return resolveReturnedConversationId(value);
  }

  private summarizeText(value: unknown): string {
    const text = String(value || '').trim().replace(/\s+/g, ' ');
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }

  private uniqueStrings(values: unknown[]): string[] {
    return Array.from(new Set((Array.isArray(values) ? values : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)));
  }

  private getPrCommitCount(pr: PullRequestRecord): number {
    const count = Number(pr && (pr.commitCount || (pr.remote && pr.remote.commitCount)));
    return Number.isFinite(count) ? count : 0;
  }
}


export { ImplementationAgentDefinition };
