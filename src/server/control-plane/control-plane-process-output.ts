import fs from 'fs';
import path from 'path';

type ManagedProcessTarget = 'server' | 'controlBridge';

const PROCESS_OUTPUT_DIR = ['.autonomy', 'control-plane', 'managed-process-output'];
const DEFAULT_OUTPUT_TAIL_BYTES = 12 * 1024;

function getManagedProcessOutputPath(rootDir: string, repoId: string, target: ManagedProcessTarget) {
  return path.join(
    rootDir,
    ...PROCESS_OUTPUT_DIR,
    sanitizePathSegment(repoId),
    `${sanitizePathSegment(target)}.log`
  );
}

function prepareManagedProcessOutput(rootDir: string, repoId: string, target: ManagedProcessTarget, options: {
  outputSessionId?: string;
  command?: string | null;
  cwd?: string | null;
  requestedAt?: string | null;
}) {
  const outputPath = getManagedProcessOutputPath(rootDir, repoId, target);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const outputSessionId = String(options.outputSessionId || `${target}-${Date.now().toString(36)}`).trim();
  const requestedAt = String(options.requestedAt || new Date().toISOString()).trim();
  const headerLines = [
    '',
    `=== ${requestedAt} ${target} session ${outputSessionId} ===`,
    options.command ? `command: ${options.command}` : '',
    options.cwd ? `cwd: ${options.cwd}` : '',
  ].filter(Boolean);
  fs.appendFileSync(outputPath, `${headerLines.join('\n')}\n`, 'utf8');
  const stdoutFd = fs.openSync(outputPath, 'a');
  const stderrFd = fs.openSync(outputPath, 'a');
  let closed = false;
  return {
    outputPath,
    outputSessionId,
    stdio: ['ignore', stdoutFd, stderrFd] as [stdin: 'ignore', stdout: number, stderr: number],
    close() {
      if (closed) {
        return;
      }
      closed = true;
      safeClose(stdoutFd);
      safeClose(stderrFd);
    },
  };
}

function appendManagedProcessOutputNote(rootDir: string, repoId: string, target: ManagedProcessTarget, note: string) {
  const outputPath = getManagedProcessOutputPath(rootDir, repoId, target);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const content = String(note || '').trim();
  if (!content) {
    return outputPath;
  }
  fs.appendFileSync(outputPath, `${content}\n`, 'utf8');
  return outputPath;
}

function readManagedProcessOutput(rootDir: string, repoId: string, target: ManagedProcessTarget, maxBytes = DEFAULT_OUTPUT_TAIL_BYTES) {
  const outputPath = getManagedProcessOutputPath(rootDir, repoId, target);
  if (!fs.existsSync(outputPath)) {
    return {
      available: false,
      outputPath,
      content: '',
      truncated: false,
      updatedAt: null,
    };
  }
  const stat = fs.statSync(outputPath);
  const tailBytes = Number.isFinite(maxBytes) ? Math.max(512, Math.floor(maxBytes)) : DEFAULT_OUTPUT_TAIL_BYTES;
  const start = Math.max(0, stat.size - tailBytes);
  const buffer = Buffer.alloc(Math.max(0, stat.size - start));
  const fd = fs.openSync(outputPath, 'r');
  try {
    if (buffer.length > 0) {
      fs.readSync(fd, buffer, 0, buffer.length, start);
    }
  } finally {
    safeClose(fd);
  }
  return {
    available: true,
    outputPath,
    content: buffer.toString('utf8'),
    truncated: start > 0,
    updatedAt: stat.mtime.toISOString(),
  };
}

function sanitizePathSegment(value: string) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function safeClose(fd: number) {
  try {
    fs.closeSync(fd);
  } catch {
    // Ignore repeated or failed closes.
  }
}

export {
  appendManagedProcessOutputNote,
  getManagedProcessOutputPath,
  prepareManagedProcessOutput,
  readManagedProcessOutput,
};
