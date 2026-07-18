import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { JsonRecord, RuntimeState } from './types.js';

const DEFAULT_ENV_FILES = [
  '.env.autonomy.local',
  '.env.autonomy',
  '.env.local',
  '.env',
];

function resolveRootDir(rootOption = '') {
  return rootOption
    ? path.resolve(process.cwd(), rootOption)
    : process.cwd();
}

function resolveInsideRoot(rootDir: string, value: string, label: string) {
  const resolved = path.isAbsolute(value)
    ? path.normalize(value)
    : path.resolve(rootDir, value);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must resolve inside the repository root: ${value}`);
  }
  return resolved;
}

function ensureDir(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function writeJson(filePath: string, value: unknown) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function getRuntimePath(rootDir: string) {
  return path.join(rootDir, '.autonomy', 'runtime', 'state', 'runtime.json');
}

function loadRuntime(rootDir: string): RuntimeState {
  const value = readJson<JsonRecord>(getRuntimePath(rootDir), {});
  return {
    schemaVersion: 1,
    customAgents: isRecord(value.customAgents) ? value.customAgents : {},
    customAgentInvocations: isRecord(value.customAgentInvocations)
      ? value.customAgentInvocations
      : {},
  } as RuntimeState;
}

function writeRuntime(rootDir: string, runtime: RuntimeState) {
  writeJson(getRuntimePath(rootDir), {
    schemaVersion: 1,
    customAgents: runtime.customAgents || {},
    customAgentInvocations: runtime.customAgentInvocations || {},
  });
}

function isProcessAlive(pid: number | null | undefined) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const status = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return status ? !status.includes('Z') : true;
  } catch {
    return true;
  }
}

function signalProcessGroup(pid: number | null | undefined, signal: NodeJS.Signals) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Fall back to signaling the direct process.
    }
  }
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function acquireStateLock(rootDir: string) {
  return acquireLock(rootDir, 'state-lock', 10_000);
}

function acquireServerLock(rootDir: string) {
  return acquireLock(rootDir, 'server-lock', 250);
}

function acquireLock(rootDir: string, name: string, timeoutMs: number) {
  const lockDir = path.join(rootDir, '.autonomy', name);
  const ownerPath = path.join(lockDir, 'owner.json');
  const token = randomUUID();
  const startedAt = Date.now();
  ensureDir(path.dirname(lockDir));

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, `${JSON.stringify({
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const owner = readLockOwner(ownerPath);
      if (owner && !isProcessAlive(Number(owner.pid))) {
        if (recoverLock(lockDir, ownerPath, owner)) continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        if (!owner) {
          if (recoverLock(lockDir, ownerPath, null)) continue;
        }
        throw new Error(`Timed out acquiring ${name} at ${lockDir}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }

  return () => {
    const owner = readLockOwner(ownerPath);
    if (owner && owner.token === token) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  };
}

function recoverLock(
  lockDir: string,
  ownerPath: string,
  observedOwner: JsonRecord | null
) {
  const recoveryDir = `${lockDir}-recovery`;
  try {
    fs.mkdirSync(recoveryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    const currentOwner = readLockOwner(ownerPath);
    const stillStale = observedOwner
      ? currentOwner !== null
        && sameLockOwner(currentOwner, observedOwner)
        && !isProcessAlive(Number(currentOwner.pid))
      : currentOwner === null;
    if (!stillStale) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    fs.rmSync(recoveryDir, { recursive: true, force: true });
  }
}

function sameLockOwner(left: JsonRecord, right: JsonRecord) {
  if (left.token || right.token) return left.token === right.token;
  return left.pid === right.pid && left.startedAt === right.startedAt;
}

function readLockOwner(ownerPath: string): JsonRecord | null {
  try {
    return JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function loadAutonomyEnv(rootDir: string) {
  DEFAULT_ENV_FILES.forEach((fileName) => {
    const filePath = path.join(rootDir, fileName);
    if (fs.existsSync(filePath)) {
      parseEnvFile(filePath);
    }
  });
}

function parseEnvFile(filePath: string) {
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    const separator = trimmed.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || separator <= 0) {
      return;
    }
    const key = trimmed.slice(0, separator).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      return;
    }
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function slugify(value: string) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'custom-agent';
}

function extractError(error: unknown) {
  return error instanceof Error ? error.message : String(error || 'unknown error');
}

export {
  acquireServerLock,
  acquireStateLock,
  ensureDir,
  extractError,
  getRuntimePath,
  isProcessAlive,
  isRecord,
  loadAutonomyEnv,
  loadRuntime,
  readJson,
  resolveInsideRoot,
  resolveRootDir,
  signalProcessGroup,
  slugify,
  writeJson,
  writeRuntime,
};
