async function runImplementationFlow(params, deps) {
  const { rootDir, agentId, taskId, branch, worktreePath } = params;
  const {
    AGENT_ROLES,
    TASK_TYPES,
    buildRoleEventName,
    getRoleLabel,
    appendRunnerLog,
    buildCommitMessage,
    buildQueueMetadataCommitMessage,
    buildTaskLaneKey,
    ensureCheckEnvironment,
    evaluateScope,
    executeTaskWithCodex,
    finalizeTaskRun,
    getAgentConfig,
    getCompletedLaneTasks,
    getLaneTasks,
    getPrCommitCount,
    getPrForLane,
    getTask,
    hasGithubAuth,
    isPendingImplementationTask,
    listChangedFiles,
    loadState,
    logRunnerEvent,
    markImplementationTaskComplete,
    readGit,
    recordImplementationTaskCommitSha,
    recordLaneTaskCompletion,
    resolveCheckCommands,
    runCheckCommands,
    runGit,
    summarizeText,
    tryPushBranch,
    uniqueStrings,
    useCodexStub,
  } = deps;

  if (useCodexStub()) {
    return runImplementationStubFlow(params, deps);
  }

  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'start'), { agentId, taskId, branch, worktreePath });
  const state = loadState(rootDir, {
    worktreePath,
    implementationAgentId: agentId,
  });
  const agent = getAgentConfig(state.config, agentId);
  const task = getTask(state.queues, taskId);
  const laneKey = buildTaskLaneKey(task);
  const laneTasks = getLaneTasks(state.queues, agentId, laneKey);
  const remainingLaneTasks = laneTasks.filter((candidate) => candidate.id !== task.id && isPendingImplementationTask(candidate));
  const existingPr = getPrForLane(rootDir, agentId, laneKey);
  const completedLaneTasks = getCompletedLaneTasks(rootDir, agentId, laneKey);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'read-task'), {
    taskId: task.id,
    taskType: task.type || TASK_TYPES.DEFAULT,
    laneKey,
    laneTaskIds: laneTasks.map((candidate) => candidate.id),
    remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
    completedTaskIds: completedLaneTasks.map((candidate) => candidate.id),
    existingPrId: existingPr ? existingPr.id : null,
  });
  if (existingPr) {
    logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'read-pr'), {
      taskId: task.id,
      prId: existingPr.id,
      status: existingPr.status,
      commitCount: getPrCommitCount(existingPr),
      pendingTaskIds: existingPr.pendingTaskIds || [],
      reviewDecisions: (existingPr.reviews || []).map((decisionRecord) => decisionRecord.decision),
    });
  }
  const checkCommands = resolveCheckCommands({
    task,
    existingPr,
    remainingLaneTasks,
    completedLaneTasks,
  });
  ensureCheckEnvironment(worktreePath, checkCommands);
  const codexResult = await executeTaskWithCodex({
    rootDir,
    agent,
    task,
    laneTasks,
    pr: existingPr,
    branch,
    worktreePath,
  });
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'codex'), {
    taskId: task.id,
    status: codexResult.status,
    summary: summarizeText(codexResult.summary || codexResult.notes),
  });

  const changedFiles = listChangedFiles(worktreePath);
  let scopeResult = {
    ok: true,
    files: changedFiles,
    includeGlobs: [],
    excludeGlobs: [],
    violations: [],
  };
  if (changedFiles.length > 0) {
    scopeResult = evaluateScope({
      files: changedFiles,
      agent,
      task,
    });
    if (!scopeResult.ok) {
      logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'scope-warning'), {
        taskId: task.id,
        violations: scopeResult.violations,
      });
    }
  }

  const checkResults = runCheckCommands(worktreePath, checkCommands);
  const failedChecks = checkResults.filter((entry) => entry.status === 'failed');
  if (failedChecks.length > 0) {
    throw new Error(`Required checks failed: ${failedChecks.map((entry) => entry.command).join(', ')}`);
  }

  const completionMode = changedFiles.length > 0 ? 'code' : 'noop';
  const queueUpdate = markImplementationTaskComplete(worktreePath, state.config, task, branch, completionMode);
  const filesToCommit = uniqueStrings(changedFiles.concat([queueUpdate.relativePath]));
  const commitMessage = buildCommitMessage(agentId, task, completedLaneTasks.length > 0 || Boolean(existingPr));
  runGit(worktreePath, ['add', '--all', '--', ...filesToCommit]);
  runGit(worktreePath, ['commit', '-m', commitMessage]);
  const commitSha = readGit(worktreePath, ['rev-parse', 'HEAD']);
  const queueCommitUpdate = recordImplementationTaskCommitSha(worktreePath, state.config, task, commitSha);
  if (queueCommitUpdate.changed) {
    runGit(worktreePath, ['add', '--', queueCommitUpdate.relativePath]);
    runGit(worktreePath, ['commit', '-m', buildQueueMetadataCommitMessage(agentId, task)]);
  }
  const queueMetadataCommitSha = readGit(worktreePath, ['rev-parse', 'HEAD']);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'commit'), {
    taskId: task.id,
    branch,
    commitMessage,
    commitSha,
    queueMetadataCommitSha,
    changedFiles: filesToCommit,
    completionMode,
  });
  const completedTaskIds = recordLaneTaskCompletion(rootDir, task, branch, worktreePath, scopeResult)
    .map((candidate) => candidate.id);
  const pushResult = tryPushBranch(worktreePath, branch);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'push'), {
    taskId: task.id,
    branch,
    pushed: pushResult.ok,
    message: pushResult.message,
  });
  if (Boolean(existingPr) || remainingLaneTasks.length === 0) {
    logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'record-pr'), {
      taskId: task.id,
      branch,
      existingPrId: existingPr ? existingPr.id : null,
      completedTaskIds,
      publish: Boolean(pushResult.ok && hasGithubAuth()),
    });
  }
  finalizeTaskRun({
    rootDir,
    task,
    branch,
    completedTaskIds,
    publish: pushResult.ok && hasGithubAuth(),
    shouldRecordPr: Boolean(existingPr) || remainingLaneTasks.length === 0,
  });
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'done'), {
    taskId: task.id,
    changedFiles: changedFiles.length,
    commitMessage,
    pushed: pushResult.ok,
    published: Boolean(pushResult.ok && hasGithubAuth()),
    prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
  });

  appendRunnerLog(rootDir, agentId, ['runner', getRoleLabel(AGENT_ROLES.IMPLEMENTATION)].join(':'), {
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
      published: Boolean(pushResult.ok && hasGithubAuth()),
      pushMessage: pushResult.message,
    },
  });
}

function runImplementationStubFlow(params, deps) {
  const { rootDir, agentId, taskId, branch, worktreePath } = params;
  const {
    AGENT_ROLES,
    TASK_TYPES,
    appendRunnerLog,
    buildCommitMessage,
    buildQueueMetadataCommitMessage,
    buildRoleEventName,
    buildTaskLaneKey,
    ensureDir,
    fs,
    getAgentConfig,
    getCompletedLaneTasks,
    getLaneTasks,
    getPrCommitCount,
    getPrForLane,
    getRoleLabel,
    getTask,
    hasGithubAuth,
    isPendingImplementationTask,
    loadState,
    logRunnerEvent,
    markImplementationTaskComplete,
    path,
    readGit,
    recordImplementationTaskCommitSha,
    recordLaneTaskCompletion,
    resolveTargetFile,
    runGit,
    tryPushBranch,
  } = deps;

  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'start'), { agentId, taskId, branch, worktreePath, stub: true });
  const state = loadState(rootDir, {
    worktreePath,
    implementationAgentId: agentId,
  });
  const agent = getAgentConfig(state.config, agentId);
  const task = getTask(state.queues, taskId);
  const laneKey = buildTaskLaneKey(task);
  const laneTasks = getLaneTasks(state.queues, agentId, laneKey);
  const remainingLaneTasks = laneTasks.filter((candidate) => candidate.id !== task.id && isPendingImplementationTask(candidate));
  const existingPr = getPrForLane(rootDir, agentId, laneKey);
  const completedLaneTasks = getCompletedLaneTasks(rootDir, agentId, laneKey);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'read-task'), {
    taskId: task.id,
    taskType: task.type || TASK_TYPES.DEFAULT,
    laneKey,
    laneTaskIds: laneTasks.map((candidate) => candidate.id),
    remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
    completedTaskIds: completedLaneTasks.map((candidate) => candidate.id),
    existingPrId: existingPr ? existingPr.id : null,
    stub: true,
  });
  if (existingPr) {
    logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'read-pr'), {
      taskId: task.id,
      prId: existingPr.id,
      status: existingPr.status,
      commitCount: getPrCommitCount(existingPr),
      pendingTaskIds: existingPr.pendingTaskIds || [],
      reviewDecisions: (existingPr.reviews || []).map((decisionRecord) => decisionRecord.decision),
      stub: true,
    });
  }
  const targetFile = resolveTargetFile(worktreePath, task, agent);
  ensureDir(path.dirname(targetFile));
  const alreadyExists = fs.existsSync(targetFile);
  const generatedAt = new Date().toISOString();
  const content = alreadyExists
    ? `${fs.readFileSync(targetFile, 'utf8').trimEnd()}\n- Follow-up (${task.id}): ${generatedAt}\n`
    : [
      `# ${task.title}`,
      '',
      `- Agent: ${agentId}`,
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

  fs.writeFileSync(targetFile, content, 'utf8');
  const queueUpdate = markImplementationTaskComplete(worktreePath, state.config, task, branch, 'code');
  const stagedFiles = [path.relative(worktreePath, targetFile), queueUpdate.relativePath];
  runGit(worktreePath, ['add', '--', ...stagedFiles]);
  const commitMessage = buildCommitMessage(agentId, task, completedLaneTasks.length > 0 || Boolean(existingPr));
  runGit(worktreePath, ['commit', '-m', commitMessage]);
  const commitSha = readGit(worktreePath, ['rev-parse', 'HEAD']);
  const queueCommitUpdate = recordImplementationTaskCommitSha(worktreePath, state.config, task, commitSha);
  if (queueCommitUpdate.changed) {
    runGit(worktreePath, ['add', '--', queueCommitUpdate.relativePath]);
    runGit(worktreePath, ['commit', '-m', buildQueueMetadataCommitMessage(agentId, task)]);
  }
  const queueMetadataCommitSha = readGit(worktreePath, ['rev-parse', 'HEAD']);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'commit'), {
    taskId: task.id,
    branch,
    commitMessage,
    commitSha,
    queueMetadataCommitSha,
    changedFiles: stagedFiles,
    stub: true,
  });
  const completedTaskIds = recordLaneTaskCompletion(rootDir, task, branch, worktreePath)
    .map((candidate) => candidate.id);
  const pushResult = tryPushBranch(worktreePath, branch);
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'push'), {
    taskId: task.id,
    branch,
    pushed: pushResult.ok,
    message: pushResult.message,
    stub: true,
  });
  if (Boolean(existingPr) || remainingLaneTasks.length === 0) {
    logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'record-pr'), {
      taskId: task.id,
      branch,
      existingPrId: existingPr ? existingPr.id : null,
      completedTaskIds,
      publish: Boolean(pushResult.ok && hasGithubAuth()),
      stub: true,
    });
  }
  deps.finalizeTaskRun({
    rootDir,
    task,
    branch,
    completedTaskIds,
    publish: pushResult.ok && hasGithubAuth(),
    shouldRecordPr: Boolean(existingPr) || remainingLaneTasks.length === 0,
  });
  logRunnerEvent(buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'done'), {
    taskId: task.id,
    changedFiles: 1,
    commitMessage,
    pushed: pushResult.ok,
    published: Boolean(pushResult.ok && hasGithubAuth()),
    prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
    stub: true,
  });

  appendRunnerLog(rootDir, agentId, ['runner', getRoleLabel(AGENT_ROLES.IMPLEMENTATION)].join(':'), {
    input: {
      taskId: task.id,
      laneKey,
      laneTaskIds: laneTasks.map((candidate) => candidate.id),
      remainingLaneTaskIds: remainingLaneTasks.map((candidate) => candidate.id),
      branch,
      worktreePath,
    },
    output: {
      targetFiles: [path.relative(worktreePath, targetFile)],
      commitMessages: commitMessage ? [commitMessage] : [],
      commitSha,
      queueMetadataCommitSha,
      completionMode: 'code',
      completedTaskIds,
      prRecorded: Boolean(existingPr) || remainingLaneTasks.length === 0,
      pushed: pushResult.ok,
      published: Boolean(pushResult.ok && hasGithubAuth()),
      pushMessage: pushResult.message,
    },
  });
}


export { runImplementationFlow };
;
