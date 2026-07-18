import { spawn, type ChildProcess } from 'node:child_process';
import { signalProcessGroup } from '../runtime.js';

const CAPTURE_LIMIT = 64 * 1024;
const TERMINATION_GRACE_MS = 500;

type BufferedCommandOptions = {
  binary: string;
  args?: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  shell?: boolean;
  stream?: boolean;
  timeoutMs?: number;
  captureFullStdout?: boolean;
  onStdout?: (chunk: unknown) => void;
};

type BufferedCommandResult = {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
};

const activeCommands = new Map<number, ChildProcess>();
const terminatingGroups = new Set<number>();

function runBufferedCommand(options: BufferedCommandOptions) {
  return new Promise<BufferedCommandResult>((resolve, reject) => {
    const child = spawn(options.binary, options.args || [], {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      shell: options.shell === true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const pid = child.pid || null;
    if (pid) activeCommands.set(pid, child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killSent = false;
    let settled = false;
    let closeResult: Pick<BufferedCommandResult, 'status' | 'signal'> | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let killTimeout: NodeJS.Timeout | null = null;

    const capture = (current: string, chunk: unknown) => {
      const next = `${current}${String(chunk || '')}`;
      if (options.captureFullStdout) return next;
      return next.length > CAPTURE_LIMIT ? next.slice(-CAPTURE_LIMIT) : next;
    };
    const removeActive = () => {
      if (pid && !terminatingGroups.has(pid)) activeCommands.delete(pid);
    };
    const clearTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (killTimeout) clearTimeout(killTimeout);
    };
    const finish = () => {
      if (settled || !closeResult || (timedOut && !killSent)) return;
      settled = true;
      clearTimers();
      removeActive();
      resolve({ stdout, stderr, ...closeResult, timedOut });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (pid) {
        activeCommands.delete(pid);
        terminatingGroups.delete(pid);
      }
      reject(error);
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout = capture(stdout, chunk);
      options.onStdout?.(chunk);
      if (options.stream) process.stdout.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = capture(stderr, chunk);
      if (options.stream) process.stderr.write(chunk);
    });
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') fail(error);
    });
    child.once('error', fail);
    child.once('close', (status, signal) => {
      closeResult = { status, signal };
      finish();
    });

    const timeoutMs = Number(options.timeoutMs || 0);
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        if (pid) signalCommand(pid, 'SIGTERM');
        killTimeout = setTimeout(() => {
          killSent = true;
          if (pid) signalCommand(pid, 'SIGKILL');
          finish();
        }, TERMINATION_GRACE_MS);
      }, timeoutMs);
    }
    child.stdin?.end(options.input || '', 'utf8');
  });
}

function terminateActiveCommands(signal: NodeJS.Signals) {
  [...activeCommands.keys()].forEach((pid) => signalCommand(pid, signal));
}

function signalCommand(pid: number, signal: NodeJS.Signals) {
  if (signal === 'SIGTERM') terminatingGroups.add(pid);
  try {
    signalProcessGroup(pid, signal);
  } catch {
    // The process may have exited between discovery and signaling.
  } finally {
    if (signal === 'SIGKILL') {
      terminatingGroups.delete(pid);
      activeCommands.delete(pid);
    }
  }
}

export {
  runBufferedCommand,
  terminateActiveCommands,
};
export type {
  BufferedCommandOptions,
  BufferedCommandResult,
};
