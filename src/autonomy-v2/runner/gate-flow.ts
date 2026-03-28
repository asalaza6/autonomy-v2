import { execFileSync } from 'node:child_process';
import { getAgentDefinition } from '../../agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES, buildRoleEventName } from '../../agents/role-catalog.js';
import { appendRunnerLog } from './persistence.js';
import { logRunnerEvent, normalizeNonEmptyString, summarizeText, useCodexStub } from './runner-shared.js';
import {
  ensureCheckEnvironment,
  getPrCommitCount,
  publishMergeFollowupCommentIfNeeded,
  runCheckCommands,
} from './gate-support.js';
import { CLI_PATH } from './runner-constants.js';
import { postIssueComment, resolveGithubRepo } from './net.js';
import { evaluateScope } from '../scope/scope-main.js';
import { createReviewRunnerExecutionContext } from './runner-agent-context.js';
import { getAgentConfig, getPr, getReviewTask, loadState, persistReviewerTaskState } from './runner-state.js';
import { ensureReviewContext, listBranchCommits, listReviewDiffFiles, tryMergeWithRetry } from './workspace.js';
import { crossLayerRunnerDependencies } from './runner-dependencies.js';

const runnerDependencies = {
  ...crossLayerRunnerDependencies,
  AGENT_ROLES,
  appendRunnerLog,
  buildRoleEventName,
  ensureCheckEnvironment,
  evaluateScope,
  execFileSync,
  getAgentConfig,
  getPr,
  getPrCommitCount,
  getReviewTask,
  ensureReviewContext,
  listBranchCommits,
  listReviewDiffFiles,
  loadState,
  logRunnerEvent,
  normalizeNonEmptyString,
  persistReviewerTaskState,
  postIssueComment,
  publishMergeFollowupCommentIfNeeded,
  resolveGithubRepo,
  runCheckCommands,
  summarizeText,
  tryMergeWithRetry,
  useCodexStub,
  CLI_PATH,
};

async function runReviewFlow(params, deps) {
  const definition = getAgentDefinition(AGENT_ROLES.REVIEW);
  const context = createReviewRunnerExecutionContext(params, deps);
  return definition.execute(context, {
    kind: AGENT_ROLES.REVIEW,
    agentId: params.agentId,
    reason: 'runner',
    reviewTaskId: params.reviewTaskId,
    prId: params.prId,
    sourceAgentId: params.sourceAgentId || '',
  });
}

function runReview(params) {
  return runReviewFlow(params, runnerDependencies);
}

export { runReview };
