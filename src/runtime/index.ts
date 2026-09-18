import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRepositoryFiles } from './repository-files.js';
import { withStateLock } from '../lock/lock-main.js';
export type { LocalAction, ActionCapabilities } from '../frontend/runtime-types.js';

export interface ActionRuntime {
  readFile(file: string, options?: { encoding?: 'utf8' | 'base64' }): Promise<string>;
  readJson<T = unknown>(file: string, fallback?: T): Promise<T>;
  listFiles(directory: string, options?: { recursive?: boolean }): Promise<{ path: string; type: 'file' | 'directory' | 'symlink' }[]>;
  writeFile(file: string, content: string): Promise<void>;
  writeJson(file: string, value: unknown): Promise<void>;
  removeFile(file: string, options?: { recursive?: boolean }): Promise<void>;
  runProcess(command: string, args: string[], options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; input?: string }): Promise<{ status: number | null; stdout: string; stderr: string; signal: string | null }>;
  withLock<T>(callback: () => T | Promise<T>): Promise<T>;
}

/** Trusted action facilities. Paths are contained in the selected repository. */
export function createActionRuntime(root: string): ActionRuntime {
  const files = createRepositoryFiles(root);
  const { resolve, rootDir } = files;
  const runtime: ActionRuntime = {
    async readFile(file, options) { return files.readFile(file, options?.encoding); },
    async readJson<T>(file: string, ...fallback: [T?]): Promise<T> { return files.readJson(file, ...fallback); },
    async listFiles(directory, options = {}) { return files.listFiles(directory, options.recursive); },
    async writeFile(file, content) {
      const target = resolve(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, content); fs.renameSync(temporary, target); }
      finally { fs.rmSync(temporary, { force: true }); }
    },
    async writeJson(file, value) { await runtime.writeFile(file, `${JSON.stringify(value, null, 2)}\n`); },
    async removeFile(file, options = {}) {
      const target = resolve(file);
      if (target === rootDir) throw new Error('Cannot remove repository root.');
      fs.rmSync(target, { force: true, recursive: options.recursive === true });
    },
    runProcess(command, args, options = {}) {
      return new Promise((accept, reject) => {
        const child = spawn(command, args, { cwd: resolve(options.cwd || '.'), env: { ...process.env, ...options.env }, stdio: ['pipe', 'pipe', 'pipe'], timeout: options.timeoutMs ?? 120000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-8 * 1024 * 1024); });
        child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8 * 1024 * 1024); });
        child.on('error', reject);
        child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') reject(error); });
        child.on('close', (status, signal) => accept({ status, signal, stdout, stderr }));
        child.stdin.end(options.input);
      });
    },
    async withLock(callback) { return withStateLock(rootDir, callback); },
  };
  return runtime;
}
