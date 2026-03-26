import { validateAutonomyConfig } from '../../config/index.js';
import { buildPrdSpecPayload, commitPrdSpecToIntegrationBranch, commitTrackedFilesToIntegrationBranch, hasActivePrdSpecInIntegrationBranch, hasPrdSpecInIntegrationBranch } from '../../sync/index.js';
import { resolveGithubAuthToken } from '../../github/index.js';

export {
  BASE_TEMPLATE_FILES,
  GENERATED_TEMPLATE_FILES,
  TEMPLATE_ROOT,
  appendAgentLog,
  buildMergeCommitTitle,
  buildPersonaPrBody,
  buildPersonaPrTitle,
  buildPullRequestLabels,
  buildSignedReviewSummary,
  countBy,
  ensureDir,
  ensureInitialized,
  formatCountSummary,
  getAgent,
  getAgentLogPath,
  getAutonomyPaths,
  getListOption,
  getPr,
  getStringOption,
  normalizeLaneKey,
  printOutput,
  readJson,
  requireOption,
  slugify,
  syncIntegrationSpecs,
  writeJson,
} from './shared-core.js';
export {
  buildLaneSourceSummary,
  buildReviewFollowupAcceptance,
  buildStablePullRequestId,
  buildTaskBranchName,
  buildTaskLaneKey,
  buildWorktreePath,
  collectTaskScopeViolations,
  evaluateMerge,
  extractExecError,
  findBranchLockByLane,
  findPullRequestByLane,
  gitRefExists,
  isGitWorktree,
  normalizeReviewDecision,
  resolveBaseRef,
  runGit,
  runGitWorktreeAdd,
  uniqueScopeViolations,
  uniqueStrings,
} from './shared-repo.js';
export {
  addIssueComment,
  addIssueLabels,
  createOrFindPullRequest,
  isSelfPullRequestReviewError,
  mergePullRequest,
  performLocalMerge,
  publishReview,
  resolveGithubRepo,
} from './shared-github.js';
export {
  archiveCompletedPrdSpecs,
  loadAllState,
  loadTrackedPrds,
} from './shared-prds.js';
export {
  buildFallbackAcceptance,
  buildTaskQueueState,
  buildTrackedImplementationQueueUpdates,
  commitTrackedImplementationQueue,
  findTask,
  getImplementationTaskState,
  getTask,
  getTaskQueue,
  isTerminalTaskStatus,
  listTasks,
  readTaskQueues,
  resolveTaskQueuePath,
  sanitizePlannedTaskSpecs,
  writeTaskQueues,
} from './shared-queues.js';
export {
  buildImplementationLaneSeedTask,
  listCompletedLaneTasks,
  listImplementationLaneTasks,
  listLaneTasks,
  resolveImplementationBranchRef,
  resolvePrRecordTask,
  resolveTaskForWorktreePreparation,
} from './shared-lanes.js';
export {
  appendTrackedBranchFollowupTask,
  buildLaneConflictTaskId,
  buildLaneFollowupTaskId,
  ensureImplementationLaneWorktree,
  ensureReviewerTask,
  enqueueLaneFollowupTask,
  getReviewerTask,
  prepareTaskWorktree,
  queueReviewerTask,
} from './shared-worktrees.js';
export { collectFilesForValidation, evaluateScope } from './shared-scope.js';
export { buildAgentStatusSummaries, formatAgentStatusLine } from './shared-agent-status.js';
export { buildPullRequestStatusSummaries, formatPullRequestStatusLine } from './shared-pr-status.js';

export {
  buildPrdSpecPayload,
  commitPrdSpecToIntegrationBranch,
  commitTrackedFilesToIntegrationBranch,
  hasActivePrdSpecInIntegrationBranch,
  hasPrdSpecInIntegrationBranch,
  resolveGithubAuthToken,
  validateAutonomyConfig,
};
