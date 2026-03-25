import fs from 'fs';
import path from 'path';

const DEFAULT_ERROR_PREVIEW_LIMIT = 4000;

function logRunnerEvent(event, payload = {}) {
  if (process.env.AUTONOMY_STREAM_WORKER_OUTPUT !== '1') {
    return;
  }
  const suffix = payload && Object.keys(payload).length > 0
    ? ` ${JSON.stringify(payload)}`
    : '';
  console.log(`[runner] ${event}${suffix}`);
}

function logRunnerErrorEvent(event, payload = {}) {
  if (process.env.AUTONOMY_STREAM_WORKER_OUTPUT !== '1') {
    return;
  }
  const suffix = payload && Object.keys(payload).length > 0
    ? ` ${JSON.stringify(payload)}`
    : '';
  console.error(`[runner] ${event}${suffix}`);
}

function summarizeText(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
}

function uniqueStrings(values) {
  const seen = new Set();
  return values.reduce((accumulator, value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      return accumulator;
    }
    seen.add(normalized);
    accumulator.push(normalized);
    return accumulator;
  }, []);
}

function uniqueScopeViolations(values) {
  const seen = new Set();
  return (values || []).reduce((accumulator, value) => {
    const file = String(value && value.file || '').trim();
    const reason = String(value && value.reason || '').trim();
    const key = `${file}::${reason}`;
    if (!file || !reason || seen.has(key)) {
      return accumulator;
    }
    seen.add(key);
    accumulator.push({ file, reason });
    return accumulator;
  }, []);
}

function normalizeNonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function trimForErrorReport(value, { preferTail = false } = {}) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return null;
  }
  if (normalized.length <= DEFAULT_ERROR_PREVIEW_LIMIT) {
    return normalized;
  }
  if (preferTail) {
    return `...[truncated]\n${normalized.slice(-DEFAULT_ERROR_PREVIEW_LIMIT)}`;
  }
  return `${normalized.slice(0, DEFAULT_ERROR_PREVIEW_LIMIT)}\n...[truncated]`;
}

function extractExecError(error) {
  const stderr = normalizeNonEmptyString(error.stderr);
  if (stderr) {
    return stderr;
  }
  const stdout = normalizeNonEmptyString(error.stdout);
  if (stdout) {
    return stdout;
  }
  return normalizeNonEmptyString(error.message) || 'Command failed without stderr/stdout output.';
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function trimLeadingSeparator(value) {
  let normalized = String(value || '');
  while (normalized.startsWith('/') || normalized.startsWith('\\')) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable ${key}`);
  }
  return value;
}

function sleepMs(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}


export { ensureDir };
export { extractExecError };
export { logRunnerErrorEvent };
export { logRunnerEvent };
export { normalizeNonEmptyString };
export { readJson };
export { requireEnv };
export { slugify };
export { sleepMs };
export { summarizeText };
export { trimForErrorReport };
export { trimLeadingSeparator };
export { uniqueScopeViolations };
export { uniqueStrings };
export { writeJson };
