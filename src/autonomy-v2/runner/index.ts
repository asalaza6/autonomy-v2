#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { evaluateScope } from '../scope/index.js';
import { hasGithubAuth, resolveGithubAuthToken } from '../../github/index.js';
import { executeTaskWithCodex, reviewPrWithCodex } from '../../codex/index.js';
import { loadAutonomyEnv } from '../../env/index.js';
import {
  AGENT_ROLES,
  TASK_TYPES,
  buildRoleEventName,
  getRoleAgentLabel,
  getRoleLabel,
} from '../../agents/role-catalog.js';
import { runImplementationFlow } from './task-flow.js';
import { runReviewFlow } from './gate-flow.js';
import {
  ensureDir,
  logRunnerEvent,
  normalizeNonEmptyString,
  readJson,
  requireEnv,
  summarizeText,
  uniqueStrings,
} from './shared.js';
import { postIssueComment, resolveGithubRepo } from './net.js';
import { CLI_PATH } from './constants.js';
import {
  buildTaskLaneKey,
  getAgentConfig,
  getCompletedLaneTasks,
  getLaneTasks,
  getPr,
  getPrForLane,
  getReviewTask,
  getTask,
  isPendingImplementationTask,
  loadState,
  persistReviewerTaskState,
  recordLaneTaskCompletion,
} from './state.js';
import {
  buildScopeSafeApprovalSummary,
  ensureCheckEnvironment,
  getPrCommitCount,
  isScopeOnlyReviewFeedback,
  publishMergeFollowupCommentIfNeeded,
  resolveCheckCommands,
  runCheckCommands,
  shouldForceApproveAfterRepeatedReviews,
  shouldRetryApprovedPrMerge,
} from './gate-support.js';
import { appendRunnerLog, publishRunnerFailure } from './persistence.js';
import {
  buildCommitMessage,
  buildQueueMetadataCommitMessage,
  ensureReviewContext,
  finalizeTaskRun,
  listBranchCommits,
  listChangedFiles,
  listReviewDiffFiles,
  markImplementationTaskComplete,
  readGit,
  recordImplementationTaskCommitSha,
  resolveTargetFile,
  runGit,
  tryMergeWithRetry,
  tryPushBranch,
} from './workspace.js';

async function main() {
  const rootDir = requireEnv('AUTONOMY_ROOT');
  loadAutonomyEnv(rootDir);
  const agentId = requireEnv('AUTONOMY_AGENT_ID');

  if (process.env.AUTONOMY_TASK_ID) {
    await runImplementation({
      rootDir,
      agentId,
      taskId: process.env.AUTONOMY_TASK_ID,
      branch: requireEnv('AUTONOMY_BRANCH'),
      worktreePath: requireEnv('AUTONOMY_WORKTREE'),
    });
    return;
  }

  if (process.env.AUTONOMY_REVIEW_TASK_ID) {
    await runReviewer({
      rootDir,
      agentId,
      reviewTaskId: process.env.AUTONOMY_REVIEW_TASK_ID,
      prId: requireEnv('AUTONOMY_PR_ID'),
      sourceAgentId: process.env.AUTONOMY_SOURCE_AGENT_ID || '',
    });
    return;
  }

  throw new Error(`No supported runner context for agent "${agentId}".`);
}

async function runImplementation(params) {
  return runImplementationFlow(params, runnerDependencies);
}

async function runReviewer(params) {
  return runReviewFlow(params, runnerDependencies);
}

const runnerDependencies = {
  AGENT_ROLES,
  CLI_PATH,
  TASK_TYPES,
  appendRunnerLog,
  buildCommitMessage,
  buildQueueMetadataCommitMessage,
  buildRoleEventName,
  buildScopeSafeApprovalSummary,
  buildTaskLaneKey,
  ensureCheckEnvironment,
  ensureDir,
  ensureReviewContext,
  evaluateScope,
  execFileSync,
  executeTaskWithCodex,
  finalizeTaskRun,
  fs,
  getAgentConfig,
  getCompletedLaneTasks,
  getLaneTasks,
  getPr,
  getPrCommitCount,
  getPrForLane,
  getReviewTask,
  getRoleAgentLabel,
  getRoleLabel,
  getTask,
  hasGithubAuth,
  isPendingImplementationTask,
  isScopeOnlyReviewFeedback,
  listBranchCommits,
  listChangedFiles,
  listReviewDiffFiles,
  loadState,
  logRunnerEvent,
  markImplementationTaskComplete,
  normalizeNonEmptyString,
  path,
  persistReviewerTaskState,
  postIssueComment,
  publishMergeFollowupCommentIfNeeded,
  readGit,
  recordImplementationTaskCommitSha,
  recordLaneTaskCompletion,
  resolveCheckCommands,
  resolveGithubAuthToken,
  resolveGithubRepo,
  resolveTargetFile,
  reviewPrWithCodex,
  runCheckCommands,
  runGit,
  shouldForceApproveAfterRepeatedReviews,
  shouldRetryApprovedPrMerge,
  summarizeText,
  tryMergeWithRetry,
  tryPushBranch,
  uniqueStrings,
  useCodexStub,
};

function useCodexStub() {
  return process.env.AUTONOMY_CODEX_STUB === '1';
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const summary = publishRunnerFailure(error);
    console.error(`ERROR: ${summary}`);
    process.exit(1);
  });
}

export { main };
export { publishRunnerFailure };
export { shouldForceApproveAfterRepeatedReviews };
