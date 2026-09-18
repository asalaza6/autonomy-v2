import type { AnyRecord } from '../types.js';

const DEFAULT_ERROR_PREVIEW_LIMIT = 1000;

function ensureTrailingNewline(value) {
  const text = String(value || '');
  return text.endsWith('\n') ? text : `${text}\n`;
}

function normalizeNonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function isPreferredCodexErrorMessage(message) {
  const normalized = normalizeNonEmptyString(message);
  if (!normalized) {
    return false;
  }
  return /^Codex (produced no output for \d+ms|exceeded wall-clock timeout of \d+ms|did not write an output payload\.|output payload was empty\.)$/.test(normalized);
}

function classifyCodexFailure(summary) {
  const normalized = normalizeNonEmptyString(summary);
  if (/^Codex produced no output for \d+ms$/.test(normalized)) {
    return 'inactivity-timeout';
  }
  if (/^Codex exceeded wall-clock timeout of \d+ms$/.test(normalized)) {
    return 'wall-clock-timeout';
  }
  if (normalized === 'Codex did not write an output payload.') {
    return 'missing-output-payload';
  }
  if (normalized === 'Codex output payload was empty.') {
    return 'empty-output-payload';
  }
  return 'process-failure';
}

function trimErrorPreview(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return '';
  }
  if (normalized.length <= DEFAULT_ERROR_PREVIEW_LIMIT) {
    return normalized;
  }
  return `...[truncated]\n${normalized.slice(-DEFAULT_ERROR_PREVIEW_LIMIT)}`;
}

function logCodexFailure(error: Error, streamOutput: boolean) {
  if (!streamOutput) {
    return;
  }
  const summary = extractExecError(error);
  const message = normalizeNonEmptyString(error && error.message);
  const stderr = trimErrorPreview(error && error.stderr);
  const stdout = trimErrorPreview(error && error.stdout);
  const payload: AnyRecord = {
    kind: classifyCodexFailure(summary),
    summary,
  };

  if (message && message !== summary) {
    payload.message = message;
  }
  if (stderr && stderr !== summary) {
    payload.stderr = stderr;
  }
  if (stdout && stdout !== summary) {
    payload.stdout = stdout;
  }

  console.error(`[codex] error ${JSON.stringify(payload)}`);
}

function extractExecError(error: Error) {
  const message = normalizeNonEmptyString(error && error.message);
  if (isPreferredCodexErrorMessage(message)) {
    return message;
  }
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return message || 'unknown codex failure';
}

function extractSpawnSyncError(result) {
  const stderr = String(result && result.stderr || '').trim();
  if (stderr) {
    return stderr;
  }
  const stdout = String(result && result.stdout || '').trim();
  if (stdout) {
    return stdout;
  }
  if (result && result.signal) {
    return `process terminated by signal ${result.signal}`;
  }
  if (result && typeof result.status === 'number') {
    return `process exited with status ${result.status}`;
  }
  return 'unknown codex failure';
}

function buildSpawnExitMessage({ code, signal, stdout, stderr }) {
  const stderrText = String(stderr || '').trim();
  if (stderrText) {
    return stderrText;
  }
  const stdoutText = String(stdout || '').trim();
  if (stdoutText) {
    return stdoutText;
  }
  if (signal) {
    return `process terminated by signal ${signal}`;
  }
  if (typeof code === 'number') {
    return `process exited with status ${code}`;
  }
  return 'unknown codex failure';
}

export {
  ensureTrailingNewline,
  extractExecError,
  extractSpawnSyncError,
  buildSpawnExitMessage,
  logCodexFailure,
};
