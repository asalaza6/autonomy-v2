import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AnyRecord, PullRequestRecord, TaskRecord } from '../autonomy-types.js';
import { isReviewRole } from '../../agents/role-catalog.js';
import { acquireStateLock } from '../../lock/lock-main.js';
import { getAutonomyPaths, writeJson } from './shared-core.js';
import {
  buildBlockedMergeDiagnosis,
  classifyMergeFailureMessage,
  diagnoseApprovedPullRequestMerge,
  formatMergeFailureReason,
  summarizeText,
} from './merge-watchdog-diagnosis.js';
import { loadAllState } from './shared-prds.js';
import { getTaskQueue, writeTaskQueues } from './shared-queues.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.join(__dirname, '..', 'index.js');
const DEFAULT_APPROVED_MERGE_TIMEOUT_MS = 30 * 1000;
const DEFAULT_MERGE_WATCHDOG_RETRY_MS = 60 * 1000;
const DEFAULT_MERGE_WATCHDOG_IN_FLIGHT_LEASE_MS = 5 * 60 * 1000;

function runApprovedPrMergeWatchdog(rootDir: string, options: AnyRecord = {}) {
  const now = String(options.now || new Date().toISOString());
  const retryMs = resolvePositiveNumber(options.retryMs, DEFAULT_MERGE_WATCHDOG_RETRY_MS);
  const inFlightLeaseMs = resolvePositiveNumber(options.inFlightLeaseMs, DEFAULT_MERGE_WATCHDOG_IN_FLIGHT_LEASE_MS);
  const prepared = withWatchdogStateLock(rootDir, options, () => prepareApprovedPrMergeWatchdogAttempt(rootDir, {
    ...options,
    now,
    retryMs,
    inFlightLeaseMs,
  }));
  if (prepared.action !== 'attempt') {
    return prepared.result;
  }

  const attemptMergeFn = typeof options.attemptMerge === 'function'
    ? options.attemptMerge
    : attemptMerge;
  const mergeResult = attemptMergeFn(rootDir, prepared.prId, prepared.reviewerId);
  if (mergeResult.merged) {
    return {
      checked: 1,
      changed: true,
      merged: true,
      prId: prepared.prId,
      diagnosis: prepared.diagnosis,
    };
  }

  return withWatchdogStateLock(rootDir, options, () => finalizeApprovedPrMergeWatchdogAttempt(rootDir, {
    now,
    prId: prepared.prId,
    reviewerId: prepared.reviewerId,
    attemptKey: prepared.attemptKey,
    diagnosis: prepared.diagnosis,
    mergeResult,
  }));
}

function prepareApprovedPrMergeWatchdogAttempt(rootDir: string, options: AnyRecord = {}) {
  const now = String(options.now || new Date().toISOString());
  const retryMs = resolvePositiveNumber(options.retryMs, DEFAULT_MERGE_WATCHDOG_RETRY_MS);
  const inFlightLeaseMs = resolvePositiveNumber(options.inFlightLeaseMs, DEFAULT_MERGE_WATCHDOG_IN_FLIGHT_LEASE_MS);
  const state = loadAllState(rootDir);
  const reviewer = (state.config.agents || []).find((agent) => isReviewRole(agent.role));
  if (!reviewer) {
    return {
      action: 'return',
      result: { checked: 0, changed: false, merged: false, reason: 'no_reviewer' },
    };
  }

  const reviewerQueue = getTaskQueue(state.taskQueues, state.config, reviewer.id);
  const candidate = selectApprovedMergeWatchdogCandidate({
    pullRequests: state.prs.pullRequests || [],
    reviewTasks: reviewerQueue.tasks || [],
    now,
    timeoutMs: resolvePositiveNumber(options.timeoutMs, DEFAULT_APPROVED_MERGE_TIMEOUT_MS),
    retryMs,
  });
  if (!candidate) {
    return {
      action: 'return',
      result: { checked: 0, changed: false, merged: false, reason: 'no_due_approved_pr' },
    };
  }

  let diagnosis;
  try {
    diagnosis = diagnoseApprovedPullRequestMerge(rootDir, candidate.pr);
  } catch (error) {
    diagnosis = {
      mergeState: 'blocked',
      canMerge: false,
      code: 'github_unavailable',
      reason: `unable to inspect GitHub merge state: ${summarizeText(extractExecError(error))}`,
      headSha: candidate.pr.remote && candidate.pr.remote.sha || null,
    };
  }
  if (diagnosis.mergeState === 'merged') {
    applyMergedState(candidate.pr, candidate.reviewTask, diagnosis, now);
    persistWatchdogState(rootDir, state, true);
    return {
      action: 'return',
      result: { checked: 1, changed: true, merged: true, prId: candidate.pr.id, diagnosis },
    };
  }

  const unreviewedHeadDiagnosis = buildUnreviewedHeadMergeDiagnosis(candidate.pr, candidate.reviewTask, diagnosis);
  if (unreviewedHeadDiagnosis) {
    const changed = applyMergeDiagnosis(candidate.pr, candidate.reviewTask, unreviewedHeadDiagnosis, now);
    persistWatchdogState(rootDir, state, changed);
    return {
      action: 'return',
      result: { checked: 1, changed, merged: false, prId: candidate.pr.id, diagnosis: unreviewedHeadDiagnosis },
    };
  }

  if (diagnosis.canMerge) {
    const attemptKey = buildMergeAttemptKey(candidate.pr, diagnosis);
    if (mergeAttemptIsFresh(candidate.pr, attemptKey, now, retryMs, inFlightLeaseMs)) {
      const changed = applyMergeDiagnosis(candidate.pr, candidate.reviewTask, {
        ...diagnosis,
        mergeState: 'waiting',
        code: 'merge_retry_wait',
        reason: mergeAttemptIsInFlight(candidate.pr, attemptKey, now, inFlightLeaseMs)
          ? 'approved, automatic merge attempt is already in progress'
          : 'approved, waiting for merge retry window',
        preserveInFlightAttempt: true,
      }, now);
      persistWatchdogState(rootDir, state, changed);
      return {
        action: 'return',
        result: { checked: 1, changed, merged: false, prId: candidate.pr.id, diagnosis },
      };
    }

    const changed = applyMergeAttemptClaim(candidate.pr, diagnosis, attemptKey, now);
    persistWatchdogState(rootDir, state, changed);
    return {
      action: 'attempt',
      prId: candidate.pr.id,
      reviewerId: reviewer.id,
      attemptKey,
      diagnosis,
    };
  }

  const changed = applyMergeDiagnosis(candidate.pr, candidate.reviewTask, diagnosis, now);
  persistWatchdogState(rootDir, state, changed);
  return {
    action: 'return',
    result: { checked: 1, changed, merged: false, prId: candidate.pr.id, diagnosis },
  };
}

function finalizeApprovedPrMergeWatchdogAttempt(rootDir: string, options: AnyRecord = {}) {
  const state = loadAllState(rootDir);
  const reviewer = (state.config.agents || []).find((agent) => isReviewRole(agent.role));
  if (!reviewer) {
    return { checked: 0, changed: false, merged: false, reason: 'no_reviewer' };
  }

  const pr = ((state.prs && state.prs.pullRequests) || [])
    .find((candidate) => candidate && candidate.id === options.prId);
  const reviewerQueue = getTaskQueue(state.taskQueues, state.config, reviewer.id);
  const reviewTask = ((reviewerQueue && reviewerQueue.tasks) || [])
    .find((task) => task && task.prId === options.prId) || null;
  if (!pr) {
    return { checked: 1, changed: false, merged: false, prId: options.prId, reason: 'pr_not_found' };
  }
  if (pr.status === 'merged' || pr.mergedAt || (pr.remote && (pr.remote.mergedAt || pr.remote.merged_at))) {
    clearMergeAttemptClaim(pr, String(options.attemptKey || ''));
    persistWatchdogState(rootDir, state, false);
    return { checked: 1, changed: true, merged: true, prId: pr.id, diagnosis: options.diagnosis };
  }

  const blocked: AnyRecord = buildBlockedMergeDiagnosis(options.mergeResult && options.mergeResult.message, options.diagnosis);
  blocked.attemptKey = options.attemptKey;
  const changed = applyMergeDiagnosis(pr, reviewTask, blocked, String(options.now || new Date().toISOString()));
  persistWatchdogState(rootDir, state, changed);
  return { checked: 1, changed, merged: false, prId: pr.id, diagnosis: blocked };
}

function selectApprovedMergeWatchdogCandidate({
  pullRequests,
  reviewTasks,
  now,
  timeoutMs,
  retryMs,
}: {
  pullRequests: PullRequestRecord[];
  reviewTasks: TaskRecord[];
  now: string;
  timeoutMs: number;
  retryMs: number;
}) {
  const reviewTaskByPrId = new Map(
    (reviewTasks || [])
      .filter((task) => task && task.prId)
      .map((task) => [String(task.prId), task])
  );
  return (pullRequests || [])
    .map((pr) => ({ pr, reviewTask: reviewTaskByPrId.get(String(pr && pr.id || '')) || null }))
    .filter((entry) => entry.reviewTask && approvedPullRequestIsDue(entry.pr, entry.reviewTask, now, timeoutMs, retryMs))
    .sort((left, right) => compareApprovedMergeCandidates(left.pr, right.pr))[0] || null;
}

function approvedPullRequestIsDue(
  pr: PullRequestRecord,
  reviewTask: TaskRecord,
  now: string,
  timeoutMs: number,
  retryMs: number
) {
  if (!pr || !reviewTask || !pullRequestIsApprovedAndOpen(pr, reviewTask)) {
    return false;
  }
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return false;
  }
  const approvedAtMs = resolveApprovedAtMs(pr, reviewTask);
  if (Number.isFinite(approvedAtMs) && nowMs - approvedAtMs < timeoutMs) {
    return false;
  }
  const lastCheckedAtMs = Date.parse(String(pr.mergeWatchdog && pr.mergeWatchdog.lastCheckedAt || ''));
  if (Number.isFinite(lastCheckedAtMs) && nowMs - lastCheckedAtMs < retryMs) {
    return false;
  }
  return true;
}

function pullRequestIsApprovedAndOpen(pr: PullRequestRecord, reviewTask: TaskRecord) {
  if (String(pr.status || '') !== 'approved' && String(reviewTask.status || '') !== 'approved') {
    return false;
  }
  if (pr.mergedAt || (pr.remote && (pr.remote.mergedAt || pr.remote.merged_at))) {
    return false;
  }
  if (pr.remote && String(pr.remote.state || 'open') !== 'open') {
    return false;
  }
  const latestDecision = latestReviewDecision(pr);
  return latestDecision === 'approved' || String(reviewTask.lastDecision || reviewTask.status || '') === 'approved';
}

function resolveApprovedAtMs(pr: PullRequestRecord, reviewTask: TaskRecord) {
  const review = latestReview(pr);
  return Date.parse(String(
    (review && review.reviewedAt)
      || reviewTask.reviewedAt
      || reviewTask.updatedAt
      || pr.updatedAt
      || pr.createdAt
      || ''
  ));
}

function compareApprovedMergeCandidates(left: PullRequestRecord, right: PullRequestRecord) {
  const leftTime = Date.parse(String(left.updatedAt || left.createdAt || '')) || 0;
  const rightTime = Date.parse(String(right.updatedAt || right.createdAt || '')) || 0;
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left.id || '').localeCompare(String(right.id || ''));
}

function attemptMerge(rootDir: string, prId: string, reviewerId: string) {
  try {
    execFileSync(process.execPath, [
      CLI_PATH,
      'merge',
      '--root',
      rootDir,
      '--pr',
      prId,
      '--actor',
      reviewerId,
      '--execute',
    ], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { merged: true, message: 'merged', code: null };
  } catch (error) {
    const message = extractExecError(error);
    return {
      merged: false,
      message,
      code: classifyMergeFailureMessage(message),
    };
  }
}

function applyMergedState(pr: PullRequestRecord, reviewTask: TaskRecord, diagnosis: AnyRecord, now: string) {
  pr.status = 'merged';
  pr.mergeState = 'merged';
  pr.mergedAt = diagnosis.mergedAt || pr.mergedAt || now;
  pr.updatedAt = now;
  delete pr.mergeBlockedCode;
  delete pr.mergeBlockedReason;
  if (reviewTask) {
    reviewTask.status = 'merged';
    reviewTask.mergedAt = pr.mergedAt;
    reviewTask.updatedAt = now;
    delete reviewTask.lastError;
    delete reviewTask.lastMergeFailureCode;
    delete reviewTask.lastMergeFailureMessage;
  }
}

function applyMergeDiagnosis(pr: PullRequestRecord, reviewTask: TaskRecord, diagnosis: AnyRecord, now: string) {
  const nextMergeState = diagnosis.mergeState || 'blocked';
  const nextCode = diagnosis.code || 'merge_rejected';
  const nextReason = diagnosis.reason || 'automatic merge did not complete';
  const prior = JSON.stringify({
    mergeState: pr.mergeState || null,
    mergeBlockedCode: pr.mergeBlockedCode || null,
    mergeBlockedReason: pr.mergeBlockedReason || null,
    reviewTaskStatus: reviewTask && reviewTask.status || null,
    reviewTaskCode: reviewTask && reviewTask.lastMergeFailureCode || null,
    reviewTaskMessage: reviewTask && reviewTask.lastMergeFailureMessage || null,
  });

  pr.mergeState = nextMergeState;
  pr.mergeBlockedCode = nextCode;
  pr.mergeBlockedReason = nextReason;
  pr.mergeWatchdog = {
    ...(pr.mergeWatchdog || {}),
    lastCheckedAt: now,
    lastCode: nextCode,
    lastReason: nextReason,
  };
  if (diagnosis.headSha) {
    pr.mergeWatchdog.headSha = diagnosis.headSha;
  }
  if (diagnosis.attemptKey) {
    pr.mergeWatchdog.lastAttemptKey = diagnosis.attemptKey;
    pr.mergeWatchdog.lastAttemptAt = now;
  }
  if (diagnosis.preserveInFlightAttempt !== true) {
    clearMergeAttemptClaim(pr, String(diagnosis.attemptKey || ''));
  }
  pr.updatedAt = now;

  if (reviewTask) {
    reviewTask.status = diagnosis.requeueReview === true ? 'queued' : 'approved';
    if (diagnosis.requeueReview === true) {
      reviewTask.reviewRound = Array.isArray(pr.reviews)
        ? pr.reviews.length + 1
        : Number(reviewTask.reviewRound || 1);
    }
    reviewTask.updatedAt = now;
    reviewTask.lastError = null;
    reviewTask.lastMergeFailureCode = nextCode;
    reviewTask.lastMergeFailureMessage = nextReason;
  }

  const next = JSON.stringify({
    mergeState: pr.mergeState || null,
    mergeBlockedCode: pr.mergeBlockedCode || null,
    mergeBlockedReason: pr.mergeBlockedReason || null,
    reviewTaskStatus: reviewTask && reviewTask.status || null,
    reviewTaskCode: reviewTask && reviewTask.lastMergeFailureCode || null,
    reviewTaskMessage: reviewTask && reviewTask.lastMergeFailureMessage || null,
  });
  return prior !== next;
}

function applyMergeAttemptClaim(pr: PullRequestRecord, diagnosis: AnyRecord, attemptKey: string, now: string) {
  const prior = JSON.stringify({
    mergeState: pr.mergeState || null,
    mergeWatchdog: pr.mergeWatchdog || null,
  });
  pr.mergeState = 'waiting';
  pr.mergeWatchdog = {
    ...(pr.mergeWatchdog || {}),
    lastCheckedAt: now,
    lastCode: 'merge_in_progress',
    lastReason: 'approved, automatic merge attempt in progress',
    lastAttemptKey: attemptKey,
    lastAttemptAt: now,
    inFlightAttemptKey: attemptKey,
    inFlightAttemptAt: now,
  };
  if (diagnosis.headSha) {
    pr.mergeWatchdog.headSha = diagnosis.headSha;
  }
  pr.updatedAt = now;
  const next = JSON.stringify({
    mergeState: pr.mergeState || null,
    mergeWatchdog: pr.mergeWatchdog || null,
  });
  return prior !== next;
}

function clearMergeAttemptClaim(pr: PullRequestRecord, attemptKey: string) {
  if (!pr || !pr.mergeWatchdog) {
    return;
  }
  if (attemptKey && pr.mergeWatchdog.inFlightAttemptKey && pr.mergeWatchdog.inFlightAttemptKey !== attemptKey) {
    return;
  }
  delete pr.mergeWatchdog.inFlightAttemptKey;
  delete pr.mergeWatchdog.inFlightAttemptAt;
}

function persistWatchdogState(rootDir: string, state: AnyRecord, queueChanged: boolean) {
  const paths = getAutonomyPaths(rootDir);
  writeJson(paths.prsState, state.prs);
  if (queueChanged) {
    const reviewer = (state.config.agents || []).find((agent) => isReviewRole(agent.role));
    writeTaskQueues(rootDir, state.config, state.taskQueues, {
      reviewCommitMessage: 'autonomy(queue): update merge watchdog',
      reviewGitIdentity: reviewer ? reviewer.gitIdentity : undefined,
    });
  }
}

function buildMergeAttemptKey(pr: PullRequestRecord, diagnosis: AnyRecord) {
  return [
    pr.id,
    diagnosis.headSha || (pr.remote && pr.remote.sha) || pr.commitCount || 'unknown-head',
    diagnosis.code || 'mergeable',
  ].join(':');
}

function mergeAttemptIsFresh(
  pr: PullRequestRecord,
  attemptKey: string,
  now: string,
  retryMs: number,
  inFlightLeaseMs = DEFAULT_MERGE_WATCHDOG_IN_FLIGHT_LEASE_MS
) {
  if (mergeAttemptIsInFlight(pr, attemptKey, now, inFlightLeaseMs)) {
    return true;
  }
  if (!pr.mergeWatchdog || pr.mergeWatchdog.lastAttemptKey !== attemptKey) {
    return false;
  }
  const lastAttemptAtMs = Date.parse(String(pr.mergeWatchdog.lastAttemptAt || ''));
  const nowMs = Date.parse(now);
  return Number.isFinite(lastAttemptAtMs) && Number.isFinite(nowMs) && nowMs - lastAttemptAtMs < retryMs;
}

function mergeAttemptIsInFlight(pr: PullRequestRecord, attemptKey: string, now: string, inFlightLeaseMs: number) {
  if (!pr.mergeWatchdog || pr.mergeWatchdog.inFlightAttemptKey !== attemptKey) {
    return false;
  }
  const inFlightAttemptAtMs = Date.parse(String(pr.mergeWatchdog.inFlightAttemptAt || ''));
  const nowMs = Date.parse(now);
  return Number.isFinite(inFlightAttemptAtMs)
    && Number.isFinite(nowMs)
    && nowMs - inFlightAttemptAtMs < inFlightLeaseMs;
}

function withWatchdogStateLock(rootDir: string, options: AnyRecord, callback: () => any) {
  if (options.stateLockHeld === true) {
    return callback();
  }
  const release = acquireStateLock(rootDir);
  try {
    return callback();
  } finally {
    release();
  }
}

function latestReview(pr: PullRequestRecord) {
  return Array.isArray(pr && pr.reviews) && pr.reviews.length > 0
    ? pr.reviews[pr.reviews.length - 1]
    : null;
}

function latestReviewDecision(pr: PullRequestRecord) {
  const review = latestReview(pr);
  return String(review && review.decision || '');
}

function getPullRequestCommitCount(pr: PullRequestRecord) {
  const counts = [
    Number(pr && pr.commitCount),
    Number(pr && pr.remote && pr.remote.commitCount),
  ].filter((count) => Number.isFinite(count) && count > 0);
  return counts.length > 0 ? Math.max(...counts) : 0;
}

function reviewedCommitCountCoversPullRequestHead(pr: PullRequestRecord, reviewTask: TaskRecord) {
  const reviewedCommitCount = Number(reviewTask && reviewTask.reviewedCommitCount);
  const currentCommitCount = getPullRequestCommitCount(pr);
  if (Number.isFinite(reviewedCommitCount) && reviewedCommitCount > 0) {
    return currentCommitCount <= reviewedCommitCount;
  }
  return true;
}

function shouldRetryApprovedPrMerge(pr: PullRequestRecord, reviewTask: TaskRecord) {
  if (latestReviewDecision(pr) !== 'approved') {
    return false;
  }
  if (pr && pr.mergedAt) {
    return false;
  }
  if (pr && pr.remote && pr.remote.mergedAt) {
    return false;
  }
  return reviewedCommitCountCoversPullRequestHead(pr, reviewTask);
}

function buildUnreviewedHeadMergeDiagnosis(
  pr: PullRequestRecord,
  reviewTask: TaskRecord,
  baseDiagnosis: AnyRecord = {}
) {
  if (reviewedCommitCountCoversPullRequestHead(pr, reviewTask)) {
    return null;
  }
  const currentCommitCount = getPullRequestCommitCount(pr);
  const reviewedCommitCount = Number(reviewTask && reviewTask.reviewedCommitCount);
  return {
    mergeState: 'blocked',
    canMerge: false,
    code: 'unreviewed_head',
    reason: `PR head has ${currentCommitCount} commits, but approval reviewed ${reviewedCommitCount}; review must cover the latest head before merge`,
    headSha: baseDiagnosis.headSha || (pr.remote && pr.remote.sha) || null,
    commitCount: currentCommitCount,
    reviewedCommitCount,
    requeueReview: true,
  };
}

function extractExecError(error) {
  if (error && error.stderr) {
    return String(error.stderr).trim();
  }
  if (error && error.stdout) {
    return String(error.stdout).trim();
  }
  return error && error.message ? String(error.message) : String(error || '');
}

function resolvePositiveNumber(value: unknown, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

export {
  approvedPullRequestIsDue,
  buildUnreviewedHeadMergeDiagnosis,
  classifyMergeFailureMessage,
  diagnoseApprovedPullRequestMerge,
  formatMergeFailureReason,
  getPullRequestCommitCount,
  reviewedCommitCountCoversPullRequestHead,
  runApprovedPrMergeWatchdog,
  selectApprovedMergeWatchdogCandidate,
  shouldRetryApprovedPrMerge,
};
