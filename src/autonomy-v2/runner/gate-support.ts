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
import { normalizeNonEmptyString, uniqueStrings } from './runner-shared.js';

const REVIEW_MERGE_BLOCKING_SCRIPTS = ['typecheck', 'lint'];

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

function readPackageScripts(worktreePath) {
  const manifestPath = path.join(worktreePath, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    return {};
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest && typeof manifest.scripts === 'object' && manifest.scripts
      ? manifest.scripts
      : {};
  } catch (_) {
    return {};
  }
}

function resolveReviewCheckCommands(worktreePath, configuredChecks) {
  const commands = uniqueStrings(configuredChecks || []);
  const scripts = readPackageScripts(worktreePath);
  const repoChecks = REVIEW_MERGE_BLOCKING_SCRIPTS
    .filter((scriptName) => typeof scripts[scriptName] === 'string' && scripts[scriptName].trim())
    .map((scriptName) => `npm run ${scriptName}`);
  return uniqueStrings(commands.concat(repoChecks));
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
  const checksText = passedChecks ? ` The merge-blocking checks passed: ${passedChecks}.` : '';
  return `Approved. Compared against origin/${pr.baseBranch}, the diff stays within the lane agent scope (${changed}).${checksText}`;
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
  publishMergeFollowupCommentIfNeeded,
  isScopeOnlyReviewFeedback,
  resolveReviewCheckCommands,
  runCheckCommands,
  getPrCommitCount,
};
