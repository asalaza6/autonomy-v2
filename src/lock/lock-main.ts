import fs from 'fs';
import path from 'path';
type AnyRecord = Record<string, any>;

function sleepMs(durationMs: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

function isProcessAlive(pid: number) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function getLockPaths(rootDir: string, lockName: string) {
  const lockDir = path.join(rootDir, '.autonomy', lockName);
  return {
    lockDir,
    ownerFile: path.join(lockDir, 'owner.json'),
  };
}

function* acquireLockSteps(rootDir: string, lockName: string, options: AnyRecord = {}) {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const pollMs = Number(options.pollMs || 50);
  const startedAt = Date.now();
  const { lockDir, ownerFile } = getLockPaths(rootDir, lockName);

  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerFile, `${JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
      }, null, 2)}\n`, 'utf8');
      return () => {
        fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }

      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
        if (!isProcessAlive(owner.pid)) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch (ownerError) {
        if (ownerError.code === 'ENOENT' || ownerError.name === 'SyntaxError') {
          if (Date.now() - startedAt > timeoutMs) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
          yield pollMs;
          continue;
        }
        throw ownerError;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out acquiring autonomy state lock at ${lockDir}`);
      }
      yield pollMs;
    }
  }
}

function acquireLock(rootDir: string, lockName: string, options: AnyRecord = {}) {
  const attempts = acquireLockSteps(rootDir, lockName, options);
  let next = attempts.next();
  while (!next.done) { sleepMs(next.value as number); next = attempts.next(); }
  return next.value;
}

function acquireStateLock(rootDir: string, options: AnyRecord = {}) {
  return acquireLock(rootDir, 'state-lock', options);
}

function acquireServerLock(rootDir: string, options: AnyRecord = {}) {
  return acquireLock(rootDir, 'server-lock', {
    timeoutMs: Number(options.timeoutMs || 250),
    pollMs: Number(options.pollMs || 50),
  });
}

async function withStateLock(rootDir: string, callback: () => any, options: AnyRecord = {}) {
  const attempts = acquireLockSteps(rootDir, 'state-lock', options);
  let next = attempts.next();
  while (!next.done) {
    await new Promise(resolve => setTimeout(resolve, next.value as number));
    next = attempts.next();
  }
  const release = next.value;
  try {
    return await callback();
  } finally {
    release();
  }
}



export { acquireServerLock, acquireStateLock };

export { withStateLock };
