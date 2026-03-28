import fs from 'fs';
import path from 'path';
import { AGENT_ROLES, RUNNER_TYPES, buildRoleEventName, getRunnerTypeForRole } from '../../agents/role-catalog.js';
import type { AnyRecord } from '../autonomy-types.js';
import { RUNTIME_SEGMENTS } from './runner-constants.js';
import { ensureDir, logRunnerErrorEvent, normalizeNonEmptyString, trimForErrorReport } from './runner-shared.js';

function appendRunnerLog(rootDir, agentId, event, payload) {
  const logPath = path.join(rootDir, ...RUNTIME_SEGMENTS, 'agents', agentId, 'log.md');
  ensureDir(path.dirname(logPath));
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${agentId} Log\n`, 'utf8');
  }

  const lines = [
    '',
    `## ${new Date().toISOString()} ${event}`,
    '### Input',
    '```json',
    JSON.stringify(payload.input, null, 2),
    '```',
    '### Output',
    '```json',
    JSON.stringify(payload.output, null, 2),
    '```',
  ];
  fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
}

function getRunnerFailureContext() {
  const runnerType = process.env.AUTONOMY_TASK_ID
    ? getRunnerTypeForRole(AGENT_ROLES.IMPLEMENTATION)
    : process.env.AUTONOMY_REVIEW_TASK_ID
      ? getRunnerTypeForRole(AGENT_ROLES.REVIEW)
      : 'unknown';
  return {
    rootDir: normalizeNonEmptyString(process.env.AUTONOMY_ROOT),
    agentId: normalizeNonEmptyString(process.env.AUTONOMY_AGENT_ID),
    runnerType,
    taskId: normalizeNonEmptyString(process.env.AUTONOMY_TASK_ID),
    reviewTaskId: normalizeNonEmptyString(process.env.AUTONOMY_REVIEW_TASK_ID),
    prId: normalizeNonEmptyString(process.env.AUTONOMY_PR_ID),
    sourceAgentId: normalizeNonEmptyString(process.env.AUTONOMY_SOURCE_AGENT_ID),
    branch: normalizeNonEmptyString(process.env.AUTONOMY_BRANCH),
    worktreePath: normalizeNonEmptyString(process.env.AUTONOMY_WORKTREE),
  };
}

function buildRunnerFailureRecord(error, context = getRunnerFailureContext()) {
  const message = normalizeNonEmptyString(error && error.message) || 'Runner failed without an error message.';
  const stderr = trimForErrorReport(error && error.stderr, { preferTail: true });
  const stdout = trimForErrorReport(error && error.stdout, { preferTail: true });
  const stack = trimForErrorReport(error && error.stack);
  return {
    recordedAt: new Date().toISOString(),
    runnerType: context.runnerType,
    agentId: context.agentId,
    taskId: context.taskId,
    reviewTaskId: context.reviewTaskId,
    prId: context.prId,
    sourceAgentId: context.sourceAgentId,
    branch: context.branch,
    worktreePath: context.worktreePath,
    summary: stderr || stdout || message,
    message,
    stderr,
    stdout,
    stack,
  };
}

function buildRunnerFailureEventName(context) {
  if (context.runnerType === RUNNER_TYPES.DEFAULT) {
    return buildRoleEventName(AGENT_ROLES.IMPLEMENTATION, 'error');
  }
  if (context.runnerType === RUNNER_TYPES.REVIEW) {
    return buildRoleEventName(AGENT_ROLES.REVIEW, 'error');
  }
  return 'error';
}

function publishRunnerFailure(error) {
  const context = getRunnerFailureContext();
  const record = buildRunnerFailureRecord(error, context);
  const eventPayload: AnyRecord = {
    summary: record.summary,
  };
  if (record.taskId) {
    eventPayload.taskId = record.taskId;
  }
  if (record.reviewTaskId) {
    eventPayload.reviewTaskId = record.reviewTaskId;
  }
  if (record.prId) {
    eventPayload.prId = record.prId;
  }
  logRunnerErrorEvent(buildRunnerFailureEventName(context), eventPayload);

  if (context.rootDir && context.agentId) {
    try {
      appendRunnerLog(context.rootDir, context.agentId, 'runner:error', {
        input: {
          runnerType: context.runnerType,
          taskId: context.taskId,
          reviewTaskId: context.reviewTaskId,
          prId: context.prId,
          sourceAgentId: context.sourceAgentId,
          branch: context.branch,
          worktreePath: context.worktreePath,
        },
        output: record,
      });
    } catch (_) {
      // Runner failure reporting must not mask the original error.
    }
  }

  const errorReportPath = normalizeNonEmptyString(process.env.AUTONOMY_ERROR_REPORT);
  if (errorReportPath) {
    try {
      ensureDir(path.dirname(errorReportPath));
      fs.writeFileSync(errorReportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    } catch (_) {
      // Best effort only.
    }
  }

  return record.summary;
}

export { appendRunnerLog, publishRunnerFailure };
