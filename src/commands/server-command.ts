import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { CliOptions, JsonRecord } from '../types.js';
import {
  acquireServerControlLock,
  canonicalizePath,
  ensureDir,
  isProcessAlive,
  readJson,
  signalProcessGroup,
} from '../runtime.js';
import { loadCustomAgentConfig } from '../custom-agents/config.js';

type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

type ServerOwner = {
  pid: number;
  token?: string;
  startedAt?: string;
};

const SERVER_LOCK_WRITE_GRACE_MS = 1_000;

async function runWithServerControl<T>(
  rootDir: string,
  callback: (releaseControl: () => void) => Promise<T> | T
) {
  const releaseLock = await acquireServerControlLock(rootDir);
  let released = false;
  const releaseControl = () => {
    if (released) return;
    released = true;
    releaseLock();
  };
  try {
    return await callback(releaseControl);
  } finally {
    releaseControl();
  }
}

async function runServerCommand(
  requestedRootDir: string,
  options: CliOptions,
  command: string
) {
  const rootDir = canonicalizePath(requestedRootDir);
  if (command === 'server:status') {
    return getServerStatus(rootDir);
  }
  return runWithServerControl(rootDir, async (releaseControl) => {
    if (command === 'server:kill') {
      return killServerUnlocked(rootDir);
    }
    if (command === 'server:start') {
      return startServerUnlocked(rootDir, options, releaseControl);
    }
    if (command === 'server:restart') {
      const stopped = await killServerUnlocked(rootDir);
      if (!stopped.ok) {
        throw new Error(
          `Could not stop every autonomy-v2 server process for ${rootDir}: ${stopped.remaining.join(', ')}`
        );
      }
      const started = await startServerUnlocked(rootDir, options, releaseControl);
      return {
        ok: started.ok,
        action: 'restart',
        rootDir,
        previousPids: stopped.pids,
        stopped: stopped.stopped,
        forced: stopped.forced,
        started: started.started,
        alreadyRunning: started.alreadyRunning,
        pid: started.pid,
        detached: started.detached,
        foreground: started.foreground,
        keepOldTerminal: booleanOption(options, 'keep-old-terminal'),
        logPath: started.logPath,
      };
    }
    throw new Error(`Unsupported server command "${command}".`);
  });
}

function getServerStatus(requestedRootDir: string) {
  const rootDir = canonicalizePath(requestedRootDir);
  const owner = readServerOwner(rootDir);
  const rows = collectServerProcesses(rootDir, owner);
  const ownerAlive = Boolean(owner && rows.some((row) => row.pid === owner.pid));
  const running = rows.length > 0;
  const discoveredServer = rows.find((row) => looksLikeServer(row.command));
  return {
    ok: true,
    action: 'status',
    rootDir,
    running,
    pid: ownerAlive ? owner?.pid || null : discoveredServer?.pid || null,
    owner: owner ? {
      pid: owner.pid,
      alive: ownerAlive,
      startedAt: owner.startedAt || null,
    } : null,
    pids: rows.map((row) => row.pid),
  };
}

async function killServer(requestedRootDir: string) {
  const rootDir = canonicalizePath(requestedRootDir);
  return runWithServerControl(rootDir, () => killServerUnlocked(rootDir));
}

async function killServerUnlocked(rootDir: string, settleAttempt = 0) {
  const owner = readServerOwner(rootDir);
  const rows = collectServerProcesses(rootDir, owner);
  const pids = rows.map((row) => row.pid);
  if (pids.length === 0) {
    const cleaned = removeStaleServerLock(rootDir, owner);
    if (!cleaned && fs.existsSync(path.dirname(getServerOwnerPath(rootDir)))) {
      if (settleAttempt >= 1) {
        throw new Error(`autonomy-v2-server lock is active but its owner could not be verified for ${rootDir}.`);
      }
      await delay(SERVER_LOCK_WRITE_GRACE_MS + 100);
      return killServerUnlocked(rootDir, settleAttempt + 1);
    }
    return {
      ok: true,
      action: 'kill',
      rootDir,
      stopped: false,
      alreadyStopped: true,
      pids: [] as number[],
      forced: false,
      remaining: [] as number[],
    };
  }

  rows.forEach((row) => signalPid(row.pid, 'SIGTERM'));
  const stopTimeoutMs = positiveEnvironmentNumber(
    'AUTONOMY_SERVER_STOP_TIMEOUT_MS',
    5_000
  );
  let remaining = await waitForAlivePids(pids, stopTimeoutMs);
  const forced = remaining.length > 0;
  if (forced) {
    remaining.forEach((pid) => signalPid(pid, 'SIGKILL'));
    remaining = await waitForAlivePids(remaining, 1_500);
  }
  if (remaining.length === 0) {
    removeStaleServerLock(rootDir, readServerOwner(rootDir));
  }
  return {
    ok: remaining.length === 0,
    action: 'kill',
    rootDir,
    stopped: remaining.length === 0,
    alreadyStopped: false,
    pids,
    forced,
    remaining,
  };
}

async function startServer(requestedRootDir: string, options: CliOptions) {
  const rootDir = canonicalizePath(requestedRootDir);
  return runWithServerControl(rootDir, (releaseControl) => (
    startServerUnlocked(rootDir, options, releaseControl)
  ));
}

async function startServerUnlocked(
  rootDir: string,
  options: CliOptions,
  releaseControl: () => void
) {
  const current = getServerStatus(rootDir);
  if (current.running) {
    return {
      ok: true,
      action: 'start',
      rootDir,
      started: false,
      alreadyRunning: true,
      pid: current.pid,
      detached: !booleanOption(options, 'foreground'),
      foreground: booleanOption(options, 'foreground'),
      logPath: getServerLogPath(rootDir),
    };
  }
  const cleaned = removeStaleServerLock(rootDir, readServerOwner(rootDir));
  if (!cleaned && fs.existsSync(path.dirname(getServerOwnerPath(rootDir)))) {
    const owner = await waitForServerOwner(
      rootDir,
      0,
      SERVER_LOCK_WRITE_GRACE_MS + 250
    );
    if (owner) {
      return {
        ok: true,
        action: 'start',
        rootDir,
        started: false,
        alreadyRunning: true,
        pid: owner.pid,
        detached: !booleanOption(options, 'foreground'),
        foreground: booleanOption(options, 'foreground'),
        logPath: getServerLogPath(rootDir),
      };
    }
    if (!removeStaleServerLock(rootDir, readServerOwner(rootDir))) {
      throw new Error(`autonomy-v2-server lock is active but its owner could not be verified for ${rootDir}.`);
    }
  }
  loadCustomAgentConfig(rootDir, stringOption(options, 'config'));

  if (booleanOption(options, 'foreground')) {
    return startServerInForeground(rootDir, options, releaseControl);
  }
  return startServerDetached(rootDir, options);
}

async function startServerDetached(rootDir: string, options: CliOptions) {
  const logPath = getServerLogPath(rootDir);
  ensureDir(path.dirname(logPath));
  const output = fs.openSync(logPath, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, serverArguments(rootDir, options), {
      cwd: rootDir,
      detached: true,
      env: process.env,
      stdio: ['ignore', output, output],
    });
  } finally {
    fs.closeSync(output);
  }
  await waitForSpawn(child);
  child.unref();

  const readyTimeoutMs = positiveEnvironmentNumber(
    'AUTONOMY_SERVER_READY_TIMEOUT_MS',
    10_000
  );
  const owner = await waitForServerOwner(rootDir, child.pid || 0, readyTimeoutMs, child);
  if (!owner) {
    if (
      child.exitCode === null
      && child.signalCode === null
      && child.pid
      && isServerPidForRoot(child.pid, rootDir)
    ) {
      signalProcessGroup(child.pid, 'SIGTERM');
    }
    const exitDetail = child.exitCode !== null
      ? ` Server exited ${child.exitCode}${child.signalCode ? ` (${child.signalCode})` : ''}.`
      : '';
    throw new Error(
      `autonomy-v2-server did not become ready within ${readyTimeoutMs}ms.${exitDetail} See ${logPath}`
    );
  }
  return {
    ok: true,
    action: 'start',
    rootDir,
    started: true,
    alreadyRunning: false,
    pid: owner.pid,
    detached: true,
    foreground: false,
    logPath,
  };
}

async function startServerInForeground(
  rootDir: string,
  options: CliOptions,
  releaseControl: () => void
) {
  const child = spawn(process.execPath, serverArguments(rootDir, options), {
    cwd: rootDir,
    detached: false,
    env: process.env,
    stdio: options.json === true ? ['inherit', 'ignore', 'inherit'] : 'inherit',
  });
  await waitForSpawn(child);
  releaseControl();
  const exit = await waitForExit(child);
  if (exit.code !== 0) {
    throw new Error(
      `autonomy-v2-server exited ${exit.code ?? '-'}${exit.signal ? ` (${exit.signal})` : ''}.`
    );
  }
  return {
    ok: true,
    action: 'start',
    rootDir,
    started: true,
    alreadyRunning: false,
    pid: child.pid || null,
    detached: false,
    foreground: true,
    logPath: null,
    exit,
  };
}

function serverArguments(rootDir: string, options: CliOptions) {
  const serverPath = resolveServerBinaryPath();
  if (!fs.existsSync(serverPath)) {
    throw new Error(`Missing autonomy-v2-server binary at ${serverPath}. Reinstall or rebuild the package.`);
  }
  const args = [serverPath, 'serve', '--root', rootDir];
  const config = stringOption(options, 'config');
  const pollMs = stringOption(options, 'poll-ms');
  if (config) args.push('--config', config);
  if (pollMs) args.push('--poll-ms', pollMs);
  return args;
}

function resolveServerBinaryPath() {
  return fileURLToPath(new URL('../../bin/autonomy-v2-server.js', import.meta.url));
}

function collectServerProcesses(requestedRootDir: string, owner: ServerOwner | null) {
  const rootDir = canonicalizePath(requestedRootDir);
  const table = readProcessTable();
  const ancestry = currentAncestry(table);
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const children = new Map<number, number[]>();
  table.forEach((row) => {
    const entries = children.get(row.ppid) || [];
    entries.push(row.pid);
    children.set(row.ppid, entries);
  });
  const roots = new Set<number>();
  table.forEach((row) => {
    if (ancestry.has(row.pid)) return;
    if (!looksLikeServer(row.command)) return;
    if (processBelongsToRoot(row, rootDir)) roots.add(row.pid);
  });
  if (
    owner
    && !ancestry.has(owner.pid)
    && isProcessAlive(owner.pid)
  ) {
    const row = byPid.get(owner.pid);
    if (row && looksLikeServer(row.command) && processBelongsToRoot(row, rootDir)) {
      roots.add(owner.pid);
    }
  }

  const included = new Set<number>();
  const depths = new Map<number, number>();
  const visit = (pid: number, depth: number) => {
    if (ancestry.has(pid)) return;
    const previousDepth = depths.get(pid) || -1;
    if (included.has(pid) && previousDepth >= depth) return;
    included.add(pid);
    depths.set(pid, depth);
    (children.get(pid) || []).forEach((childPid) => visit(childPid, depth + 1));
  };
  roots.forEach((pid) => visit(pid, 0));
  return [...included]
    .map((pid) => byPid.get(pid))
    .filter((row): row is ProcessRow => Boolean(row))
    .sort((left, right) => (
      (depths.get(right.pid) || 0) - (depths.get(left.pid) || 0)
      || right.pid - left.pid
    ));
}

function processBelongsToRoot(row: ProcessRow, rootDir: string) {
  const normalizedRoot = canonicalizePath(rootDir);
  const commandRoots = readCommandRootArguments(row.command);
  if (commandRoots.length > 0) {
    const cwd = readProcessCwd(row.pid);
    const selectedRoot = commandRoots.at(-1) || '';
    const resolvedRoot = path.isAbsolute(selectedRoot)
      ? selectedRoot
      : path.resolve(cwd || process.cwd(), selectedRoot);
    return canonicalizePath(resolvedRoot) === normalizedRoot;
  }
  const cwd = readProcessCwd(row.pid);
  return cwd === normalizedRoot;
}

function looksLikeServer(command: string) {
  const invocation = command.match(
    /^(?:\S*\/)?node(?:\s+--[^\s]+)*\s+(.+?)\s+serve(?=$|\s)/
  );
  if (!invocation) return false;
  const scriptPath = invocation[1].replace(/^["']|["']$/g, '');
  return /(?:^|\/)(?:(?:dist\/bin|node_modules\/\.bin)\/)?autonomy-v2-server(?:\.js)?$/.test(scriptPath);
}

function readCommandRootArguments(command: string) {
  const roots: string[] = [];
  const pattern = /(?:^|\s)--root(?:=|\s+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    const remainder = command.slice(match.index + match[0].length).trimStart();
    if (!remainder) continue;
    const quote = remainder[0] === '"' || remainder[0] === "'"
      ? remainder[0]
      : '';
    if (quote) {
      const closing = remainder.indexOf(quote, 1);
      roots.push((closing >= 0 ? remainder.slice(1, closing) : remainder.slice(1)).trim());
      continue;
    }
    const nextOption = remainder.search(/\s+--[A-Za-z0-9][A-Za-z0-9-]*(?:=|\s|$)/);
    roots.push((nextOption >= 0 ? remainder.slice(0, nextOption) : remainder).trim());
  }
  return roots.filter(Boolean);
}

function readProcessTable(): ProcessRow[] {
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        command: match[3].trim(),
      };
    })
    .filter((row): row is ProcessRow => Boolean(row));
}

function currentAncestry(table: ProcessRow[]) {
  const parentByPid = new Map(table.map((row) => [row.pid, row.ppid]));
  const pids = new Set<number>([process.pid]);
  let cursor = process.pid;
  while (parentByPid.has(cursor)) {
    const parent = parentByPid.get(cursor) || 0;
    if (parent <= 0 || pids.has(parent)) break;
    pids.add(parent);
    cursor = parent;
  }
  return pids;
}

function readProcessCwd(pid: number) {
  const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0) return '';
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.startsWith('n'));
  return line ? canonicalizePath(line.slice(1).trim()) : '';
}

function isServerPidForRoot(pid: number, rootDir: string) {
  const row = readProcessTable().find((entry) => entry.pid === pid);
  return Boolean(row && looksLikeServer(row.command) && processBelongsToRoot(row, rootDir));
}

function readServerOwner(rootDir: string): ServerOwner | null {
  const ownerPath = getServerOwnerPath(rootDir);
  let value: JsonRecord;
  try {
    value = readJson<JsonRecord>(ownerPath, {});
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const pid = Number(value.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    pid,
    token: typeof value.token === 'string' ? value.token : undefined,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : undefined,
  };
}

function removeStaleServerLock(rootDir: string, owner: ServerOwner | null) {
  const lockDir = path.dirname(getServerOwnerPath(rootDir));
  if (!fs.existsSync(lockDir)) return true;
  if (isValidServerOwner(rootDir, owner)) return false;
  if (!owner && serverLockAgeMs(lockDir) < SERVER_LOCK_WRITE_GRACE_MS) return false;

  const recoveryDir = `${lockDir}-recovery`;
  try {
    fs.mkdirSync(recoveryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const current = readServerOwner(rootDir);
    if (!sameServerOwner(owner, current)) return false;
    if (isValidServerOwner(rootDir, current)) return false;
    if (!current && serverLockAgeMs(lockDir) < SERVER_LOCK_WRITE_GRACE_MS) return false;
    const finalOwner = readServerOwner(rootDir);
    if (!sameServerOwner(current, finalOwner)) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    fs.rmSync(recoveryDir, { recursive: true, force: true });
  }
}

function isValidServerOwner(rootDir: string, owner: ServerOwner | null) {
  return Boolean(owner && isProcessAlive(owner.pid) && isServerPidForRoot(owner.pid, rootDir));
}

function sameServerOwner(left: ServerOwner | null, right: ServerOwner | null) {
  if (!left || !right) return left === right;
  if (left.token || right.token) return left.token === right.token;
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

function serverLockAgeMs(lockDir: string) {
  try {
    return Math.max(0, Date.now() - fs.statSync(lockDir).mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Number.POSITIVE_INFINITY;
    throw error;
  }
}

function getServerOwnerPath(rootDir: string) {
  return path.join(rootDir, '.autonomy', 'server-lock', 'owner.json');
}

function getServerLogPath(rootDir: string) {
  return path.join(rootDir, '.autonomy', 'runtime', 'server.log');
}

async function waitForServerOwner(
  rootDir: string,
  expectedPid: number,
  timeoutMs: number,
  child?: ChildProcess
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const owner = readServerOwner(rootDir);
    if (
      owner
      && isProcessAlive(owner.pid)
      && (owner.pid === expectedPid || collectServerProcesses(rootDir, owner).some((row) => row.pid === owner.pid))
    ) {
      return owner;
    }
    if (child && (child.exitCode !== null || child.signalCode !== null)) return null;
    await delay(100);
  }
  return null;
}

async function waitForAlivePids(pids: number[], timeoutMs: number) {
  const startedAt = Date.now();
  let remaining = pids.filter(isProcessAlive);
  while (remaining.length > 0 && Date.now() - startedAt <= timeoutMs) {
    await delay(100);
    remaining = remaining.filter(isProcessAlive);
  }
  return remaining;
}

function signalPid(pid: number, signal: NodeJS.Signals) {
  if (pid === process.pid || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function waitForSpawn(child: ChildProcess) {
  if (child.pid) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function waitForExit(child: ChildProcess) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function positiveEnvironmentNumber(name: string, fallback: number) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function booleanOption(options: CliOptions, name: string) {
  const value = options[name];
  return value === true || String(value || '').toLowerCase() === 'true';
}

function stringOption(options: CliOptions, name: string) {
  const value = options[name];
  return typeof value === 'string' ? value.trim() : '';
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  collectServerProcesses,
  getServerStatus,
  killServer,
  runServerCommand,
  startServer,
};
