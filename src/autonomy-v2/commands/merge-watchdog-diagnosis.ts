import { execFileSync } from 'child_process';
import type { AnyRecord, PullRequestRecord } from '../autonomy-types.js';
import { resolveGithubAuthToken } from '../../github/github-main.js';
import { resolveGithubRepo } from './shared-github.js';

const PASSING_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILING_CHECK_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

function diagnoseApprovedPullRequestMerge(rootDir: string, pr: PullRequestRecord) {
  if (!pr.remote || !pr.remote.number) {
    return {
      mergeState: 'waiting',
      canMerge: true,
      code: 'local_merge_ready',
      reason: 'approved local PR is ready for merge',
      headSha: null,
    };
  }

  const token = resolveGithubAuthToken();
  if (!token) {
    return {
      mergeState: 'blocked',
      canMerge: false,
      code: 'missing_github_auth',
      reason: 'GitHub auth is required to inspect and merge this approved PR',
      headSha: null,
    };
  }

  const repo = resolveGithubRepo(rootDir);
  const pull = githubRequest(repo, token, 'GET', `/pulls/${Number(pr.remote.number)}`, null);
  updatePullRequestRemoteSnapshot(pr, pull);
  if (pull.merged || pull.merged_at) {
    return {
      mergeState: 'merged',
      canMerge: false,
      code: 'merged',
      reason: 'PR is already merged on GitHub',
      headSha: pull.merge_commit_sha || (pull.head && pull.head.sha) || null,
      mergedAt: pull.merged_at || null,
    };
  }
  if (String(pull.state || '') !== 'open') {
    return {
      mergeState: 'blocked',
      canMerge: false,
      code: 'closed',
      reason: `PR is ${pull.state || 'closed'} on GitHub`,
      headSha: pull.head && pull.head.sha || null,
    };
  }
  if (pull.draft === true) {
    return {
      mergeState: 'blocked',
      canMerge: false,
      code: 'draft',
      reason: 'PR is still marked as draft',
      headSha: pull.head && pull.head.sha || null,
    };
  }

  const headSha = String(pull.head && pull.head.sha || pr.remote.sha || '').trim() || null;
  const checks = headSha
    ? inspectRequiredStatusChecks(repo, token, String(pull.base && pull.base.ref || pr.baseBranch || ''), headSha)
    : { failed: [], pending: [], required: [], unavailableReason: 'head SHA unavailable' };
  if (checks.failed.length > 0) {
    return {
      mergeState: 'blocked',
      canMerge: false,
      code: 'failed_checks',
      reason: `failed checks: ${checks.failed.join(', ')}`,
      headSha,
    };
  }
  if (checks.pending.length > 0) {
    return {
      mergeState: 'waiting',
      canMerge: false,
      code: 'pending_checks',
      reason: `pending checks: ${checks.pending.join(', ')}`,
      headSha,
    };
  }

  const mergeableState = String(pull.mergeable_state || '').toLowerCase();
  if (pull.mergeable === null || mergeableState === 'unknown') {
    return {
      mergeState: 'waiting',
      canMerge: false,
      code: 'mergeability_unknown',
      reason: 'GitHub is still computing mergeability',
      headSha,
    };
  }
  if (mergeableState === 'dirty' || pull.mergeable === false && mergeableState !== 'blocked') {
    return {
      mergeState: 'blocked',
      canMerge: false,
      code: 'conflicts',
      reason: 'merge conflicts block this PR',
      headSha,
    };
  }
  if (mergeableState === 'behind') {
    return {
      mergeState: 'blocked',
      canMerge: false,
      code: 'stale_branch',
      reason: 'PR branch is behind the base branch and must be updated',
      headSha,
    };
  }
  if (mergeableState === 'blocked') {
    return {
      mergeState: 'blocked',
      canMerge: false,
      code: 'branch_protection',
      reason: 'branch protection blocks merge',
      headSha,
    };
  }

  return {
    mergeState: 'waiting',
    canMerge: true,
    code: 'mergeable',
    reason: 'approved PR is mergeable',
    headSha,
  };
}

function inspectRequiredStatusChecks(repo: AnyRecord, token: string, baseBranch: string, headSha: string) {
  const required = getRequiredStatusCheckNames(repo, token, baseBranch);
  const combinedStatus = safeGithubRequest(repo, token, 'GET', `/commits/${encodeURIComponent(headSha)}/status`, null);
  const checkRuns = safeGithubRequest(repo, token, 'GET', `/commits/${encodeURIComponent(headSha)}/check-runs?per_page=100`, null);
  return summarizeStatusChecks({
    required,
    statuses: Array.isArray(combinedStatus && combinedStatus.statuses) ? combinedStatus.statuses : [],
    checkRuns: Array.isArray(checkRuns && checkRuns.check_runs) ? checkRuns.check_runs : [],
  });
}

function getRequiredStatusCheckNames(repo: AnyRecord, token: string, baseBranch: string) {
  if (!baseBranch) {
    return [];
  }
  const protection = safeGithubRequest(
    repo,
    token,
    'GET',
    `/branches/${encodeURIComponent(baseBranch)}/protection/required_status_checks`,
    null
  );
  if (!protection) {
    return [];
  }
  return uniqueStrings([
    ...(Array.isArray(protection.contexts) ? protection.contexts : []),
    ...(Array.isArray(protection.checks) ? protection.checks.map((check) => check && check.context) : []),
  ]);
}

function summarizeStatusChecks({ required, statuses, checkRuns }: {
  required: string[];
  statuses: AnyRecord[];
  checkRuns: AnyRecord[];
}) {
  const statusByName = new Map<string, string>();
  (statuses || []).forEach((status) => {
    const name = String(status && status.context || '').trim();
    if (!name || statusByName.has(name)) {
      return;
    }
    statusByName.set(name, normalizeStatusState(status.state));
  });

  const checkByName = new Map<string, string>();
  (checkRuns || []).forEach((checkRun) => {
    const name = String(checkRun && checkRun.name || '').trim();
    if (!name || checkByName.has(name)) {
      return;
    }
    checkByName.set(name, normalizeCheckRunState(checkRun));
  });

  const names = required.length > 0
    ? required
    : uniqueStrings([...statusByName.keys(), ...checkByName.keys()]);
  const failed = [];
  const pending = [];
  names.forEach((name) => {
    const states = [statusByName.get(name), checkByName.get(name)].filter(Boolean);
    if (states.length === 0) {
      pending.push(name);
      return;
    }
    if (states.some((state) => state === 'failed')) {
      failed.push(name);
      return;
    }
    if (states.some((state) => state === 'pending')) {
      pending.push(name);
    }
  });

  return { required: names, failed, pending };
}

function normalizeStatusState(value: unknown) {
  const state = String(value || '').toLowerCase();
  if (state === 'success') {
    return 'passed';
  }
  if (state === 'failure' || state === 'error') {
    return 'failed';
  }
  return 'pending';
}

function normalizeCheckRunState(checkRun: AnyRecord) {
  const status = String(checkRun && checkRun.status || '').toLowerCase();
  const conclusion = String(checkRun && checkRun.conclusion || '').toLowerCase();
  if (status !== 'completed') {
    return 'pending';
  }
  if (PASSING_CHECK_CONCLUSIONS.has(conclusion)) {
    return 'passed';
  }
  if (FAILING_CHECK_CONCLUSIONS.has(conclusion)) {
    return 'failed';
  }
  return 'pending';
}

function updatePullRequestRemoteSnapshot(pr: PullRequestRecord, pull: AnyRecord) {
  pr.remote = {
    ...(pr.remote || {}),
    number: Number(pull.number || (pr.remote && pr.remote.number)),
    url: pull.html_url || (pr.remote && pr.remote.url),
    state: pull.state || (pr.remote && pr.remote.state),
    mergedAt: pull.merged_at || null,
    title: pull.title || (pr.remote && pr.remote.title),
    body: pull.body || (pr.remote && pr.remote.body),
    commitCount: Number(pull.commits || (pr.remote && pr.remote.commitCount) || 0),
    sha: pull.head && pull.head.sha || (pr.remote && pr.remote.sha),
  };
  if (pull.title) {
    pr.title = pr.title || pull.title;
  }
}

function buildBlockedMergeDiagnosis(message: string, baseDiagnosis: AnyRecord = {}) {
  const code = classifyMergeFailureMessage(message);
  return {
    mergeState: code === 'pending_checks' || code === 'mergeability_unknown' ? 'waiting' : 'blocked',
    canMerge: false,
    code,
    reason: formatMergeFailureReason(code, message),
    headSha: baseDiagnosis.headSha || null,
  };
}

function classifyMergeFailureMessage(message: unknown) {
  const text = String(message || '').toLowerCase();
  if (/unreviewed head|review must cover the latest head|approval reviewed/.test(text)) {
    return 'unreviewed_head';
  }
  if (/conflicts?|merge conflict|dirty/.test(text)) {
    return 'conflicts';
  }
  if (/pending|required status check.*expected|checks? (?:is|are) pending|waiting for status/.test(text)) {
    return 'pending_checks';
  }
  if (/failed|failure|failing|errored|error/.test(text) && /checks?|status|ci/.test(text)) {
    return 'failed_checks';
  }
  if (/behind|out of date|update branch|base branch was modified|stale/.test(text)) {
    return 'stale_branch';
  }
  if (/protected branch|branch protection|required approving review|required review|linear history|not authorized|permission|bypass/.test(text)) {
    return 'branch_protection';
  }
  if (/not mergeable|mergeable.*unknown|merge already in progress/.test(text)) {
    return 'mergeability_unknown';
  }
  return 'merge_rejected';
}

function formatMergeFailureReason(code: string, message: unknown) {
  const detail = summarizeText(message);
  if (code === 'conflicts') {
    return 'merge conflicts block this PR';
  }
  if (code === 'pending_checks') {
    return detail || 'required checks are pending';
  }
  if (code === 'failed_checks') {
    return detail || 'required checks failed';
  }
  if (code === 'stale_branch') {
    return detail || 'PR branch is stale and must be updated';
  }
  if (code === 'branch_protection') {
    return detail || 'branch protection blocks merge';
  }
  if (code === 'mergeability_unknown') {
    return detail || 'GitHub mergeability is not ready yet';
  }
  if (code === 'unreviewed_head') {
    return detail || 'review must cover the latest PR head before merge';
  }
  return detail || 'automatic merge was rejected';
}

function githubRequest(repo: AnyRecord, token: string, method: string, endpoint: string, payload: AnyRecord | null) {
  const response = execHttpRequest(buildGithubRequestOptions(repo, token, method, endpoint, payload), payload);
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return response.payload;
  }
  const error = new Error(`GitHub API ${response.statusCode}: ${response.payload.message || response.raw}`);
  (error as AnyRecord).statusCode = response.statusCode;
  (error as AnyRecord).payload = response.payload;
  throw error;
}

function safeGithubRequest(repo: AnyRecord, token: string, method: string, endpoint: string, payload: AnyRecord | null) {
  try {
    return githubRequest(repo, token, method, endpoint, payload);
  } catch (_) {
    return null;
  }
}

function buildGithubRequestOptions(repo: AnyRecord, token: string, method: string, endpoint: string, payload: AnyRecord | null) {
  const headers: AnyRecord = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'autonomy-v2-merge-watchdog',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (payload) {
    headers['Content-Length'] = Buffer.byteLength(JSON.stringify(payload));
  }
  return {
    hostname: 'api.github.com',
    path: `/repos/${repo.owner}/${repo.repo}${endpoint}`,
    method,
    headers,
  };
}

function execHttpRequest(options: AnyRecord, payload: AnyRecord | null) {
  const response = execFileSync(process.execPath, ['-e', buildHttpClientScript()], {
    env: {
      ...process.env,
      AUTONOMY_HTTP_OPTIONS: JSON.stringify(options),
      AUTONOMY_HTTP_BODY: payload ? JSON.stringify(payload) : '',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return response ? JSON.parse(response) : { statusCode: 0, payload: {}, raw: '' };
}

function buildHttpClientScript() {
  return `
import https from 'https';
const options = JSON.parse(process.env.AUTONOMY_HTTP_OPTIONS || '{}');
const body = process.env.AUTONOMY_HTTP_BODY || '';
const req = https.request(options, (res) => {
  let raw = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => {
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_) {}
    process.stdout.write(JSON.stringify({ statusCode: res.statusCode, payload, raw }));
  });
});
req.on('error', (error) => {
  process.stderr.write(error.message);
  process.exit(1);
});
if (body) req.write(body);
req.end();
`;
}

function summarizeText(value: unknown) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

function uniqueStrings(values: unknown[]) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

export {
  buildBlockedMergeDiagnosis,
  classifyMergeFailureMessage,
  diagnoseApprovedPullRequestMerge,
  formatMergeFailureReason,
  summarizeText,
};
