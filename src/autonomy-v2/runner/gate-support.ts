import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  AGENT_ROLES,
  getRoleAgentLabel,
  getRoleLabel,
} from '../../agents/role-catalog.js';
import { hasGithubAuth, resolveGithubAuthToken } from '../../github/github-main.js';
import { resolveGithubRepo, postIssueComment } from './net.js';
import { REVIEW_AUTO_APPROVAL_THRESHOLD } from './runner-constants.js';
import { extractExecError, normalizeNonEmptyString, uniqueStrings } from './runner-shared.js';

function runCheckCommands(worktreePath, commands) {
  return uniqueStrings(commands).map((command) => {
    try {
      execFileSync(command, {
        cwd: worktreePath,
        encoding: 'utf8',
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { command, status: 'passed' };
    } catch (error) {
      return {
        command,
        status: 'failed',
        output: [String(error.stdout || '').trim(), String(error.stderr || '').trim()].filter(Boolean).join('\n').trim(),
      };
    }
  });
}

function ensureCheckEnvironment(worktreePath, commands) {
  if (!requiresNodeInstall(commands)) {
    return;
  }
  if (!fs.existsSync(path.join(worktreePath, 'package.json'))) {
    return;
  }
  if (fs.existsSync(path.join(worktreePath, 'node_modules'))) {
    return;
  }

  const npmArgs = fs.existsSync(path.join(worktreePath, 'package-lock.json'))
    ? ['ci', '--ignore-scripts']
    : ['install', '--ignore-scripts'];
  execFileSync('npm', npmArgs, {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function requiresNodeInstall(commands) {
  return uniqueStrings(commands).some((command) => /(^|\s)(npm|npx)\s/.test(command));
}

function isScopeOnlyReviewFeedback(codexReview) {
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

function buildScopeSafeApprovalSummary(pr, diffFiles, checkResults) {
  const changed = diffFiles.length > 0 ? diffFiles.join(', ') : 'no file changes';
  const passedChecks = checkResults
    .filter((entry) => entry.status === 'passed')
    .map((entry) => entry.command)
    .join(', ');
  const checksText = passedChecks ? ` The provided required checks passed: ${passedChecks}.` : '';
  return `Approved. Compared against origin/${pr.baseBranch}, the diff stays within the lane agent scope (${changed}).${checksText}`;
}

function resolveCheckCommands({ task, existingPr, remainingLaneTasks, completedLaneTasks }) {
  if (existingPr) {
    return uniqueStrings([
      ...(existingPr.checks || []),
      ...(task.checks || []),
    ]);
  }
  if (remainingLaneTasks.length === 0) {
    return uniqueStrings([
      ...completedLaneTasks.flatMap((candidate) => candidate.checks || []),
      ...(task.checks || []),
    ]);
  }
  return uniqueStrings(task.checks || []);
}

function shouldRetryApprovedPrMerge(pr, reviewerTask) {
  if (latestReviewDecision(pr) !== 'approved') {
    return false;
  }
  if (pr && pr.remote && pr.remote.mergedAt) {
    return false;
  }
  const reviewedCommitCount = Number(reviewerTask && reviewerTask.reviewedCommitCount);
  const currentCommitCount = getPrCommitCount(pr);
  if (Number.isFinite(reviewedCommitCount) && reviewedCommitCount > 0) {
    return currentCommitCount <= reviewedCommitCount;
  }
  return true;
}

function shouldForceApproveAfterRepeatedReviews(pr, _checkResults, _scopeResult) {
  const normalizedPr = pr || {};
  const reviewCount = Number.isFinite(Number(normalizedPr.reviews && normalizedPr.reviews.length))
    ? Number(normalizedPr.reviews.length)
    : 0;
  return reviewCount >= REVIEW_AUTO_APPROVAL_THRESHOLD;
}

function latestReviewDecision(pr) {
  if (!pr || !Array.isArray(pr.reviews) || pr.reviews.length === 0) {
    return '';
  }
  return String(pr.reviews[pr.reviews.length - 1].decision || '');
}

function getPrCommitCount(pr) {
  const count = Number(pr && (pr.commitCount || (pr.remote && pr.remote.commitCount)));
  return Number.isFinite(count) ? count : 0;
}

function publishMergeFollowupCommentIfNeeded(rootDir, pr, reviewerTask, mergeMessage) {
  const normalizedMessage = normalizeNonEmptyString(mergeMessage) || 'Automatic merge did not complete.';
  if (normalizedMessage === reviewerTask.lastMergeFailureMessage) {
    return false;
  }
  if (!pr.remote || !pr.remote.number || !hasGithubAuth()) {
    return false;
  }
  const repo = resolveGithubRepo(rootDir);
  const token = resolveGithubAuthToken({ required: true });
  postIssueComment(
    repo,
    token,
    pr.remote.number,
    buildMergeFollowupComment(normalizedMessage)
  );
  return true;
}

function buildMergeFollowupComment(mergeMessage) {
  return [
    `${getRoleAgentLabel(AGENT_ROLES.REVIEW).replace(/\s+/g, '-')}:`,
    '',
    'I approved this PR, but the automatic merge did not complete.',
    `Latest merge result: ${mergeMessage}`,
    `If new commits land, I will ${getRoleLabel(AGENT_ROLES.REVIEW)} the updated diff again; otherwise this PR is waiting on merge conditions to clear.`,
  ].join('\n');
}

export {
  buildScopeSafeApprovalSummary,
  ensureCheckEnvironment,
  getPrCommitCount,
  isScopeOnlyReviewFeedback,
  publishMergeFollowupCommentIfNeeded,
  resolveCheckCommands,
  runCheckCommands,
  shouldForceApproveAfterRepeatedReviews,
  shouldRetryApprovedPrMerge,
};
