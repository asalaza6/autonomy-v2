import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listConfiguredCustomAgents } from '../server/orchestrator/custom-agents.js';
import { getPaths } from '../server/orchestrator/paths.js';
import type { RuntimeState } from '../server/server-types.js';
import type { AgentRecord, AutonomyRuntime, FileEntry, LocalAction, Operation, RunRecord } from './runtime-types.js';

/** Local host adapter. Repository pages receive its methods, never Node or a shell. */
export function createLocalRuntime(options: { rootDir: string; actions?: Record<string, LocalAction> }): AutonomyRuntime & { dispose(): void } {
  const requestedRoot = path.resolve(options.rootDir);
  const rootDir = fs.realpathSync(requestedRoot);
  const actions = new Map(Object.entries(options.actions || {}));
  const operations = new Map<string, Operation>();
  const locks = new Set<string>();
  const subscriptions = new Set<() => void>();
  let disposed = false;

  function assertOpen() {
    if (disposed) throw new Error('Local runtime is disposed.');
  }

  function inside(candidate: string, root = rootDir) {
    const relative = path.relative(root, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the repository: ${candidate}`);
    }
    return candidate;
  }

  // Check every existing ancestor as well as the lexical path, including writes to missing files.
  function resolve(filePath: string) {
    assertOpen();
    if (typeof filePath !== 'string' || filePath.includes('\0')) throw new Error('Invalid file path.');
    const lexical = path.resolve(rootDir, filePath);
    const relative = path.relative(requestedRoot, lexical);
    const candidate = inside(path.isAbsolute(filePath) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      ? path.resolve(rootDir, relative)
      : lexical);
    let ancestor = candidate;
    while (true) {
      try {
        inside(fs.realpathSync(ancestor));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // A dangling symlink must not be treated as an ordinary missing path.
        try {
          if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(`Unresolved symlink: ${ancestor}`);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        ancestor = path.dirname(ancestor);
      }
    }
    return candidate;
  }

  function json<T>(filePath: string, fallback?: T): T {
    try {
      return JSON.parse(fs.readFileSync(resolve(filePath), 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fallback !== undefined) return fallback;
      throw error;
    }
  }

  function runtimeState(): RuntimeState {
    return json(getPaths(rootDir).runtimeState, { workers: {} });
  }

  function listFiles(filePath: string, recursive = false): FileEntry[] {
    const entries: FileEntry[] = [];
    function visit(directory: string) {
      for (const entry of fs.readdirSync(resolve(directory), { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        entries.push({ path: path.relative(rootDir, entryPath), type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' });
        // Never traverse symlinks (including cycles and links outside the repo).
        if (recursive && entry.isDirectory()) visit(entryPath);
      }
    }
    visit(resolve(filePath));
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  function operationPath(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid operation ID.');
    return resolve(`.autonomy/runtime/frontend/operations/${id}.json`);
  }

  function saveOperation(operation: Operation) {
    const destination = operationPath(operation.id);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = resolve(`${destination}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(operation));
    fs.renameSync(temporary, destination);
  }

  const copyOperation = (operation: Operation): Operation => JSON.parse(JSON.stringify(operation));

  const api: AutonomyRuntime & { dispose(): void } = {
    async readFile(filePath, readOptions = {}) {
      const encoding = readOptions.encoding || 'utf8';
      if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('Unsupported encoding.');
      return fs.readFileSync(resolve(filePath)).toString(encoding);
    },
    async readJson<T>(filePath: string) { return json<T>(filePath); },
    async listFiles(filePath, listOptions = {}) { return listFiles(filePath, listOptions.recursive); },
    watch(paths, onChange) {
      const targets = paths.map((requested) => resolve(requested));
      function snapshot() {
        const values = new Map<string, string>();
        for (const target of targets) {
          try {
            const stat = fs.statSync(resolve(target));
            const files = stat.isDirectory() ? [target, ...listFiles(target, true).map((entry) => path.join(rootDir, entry.path))] : [target];
            for (const file of files) {
              const entry = fs.lstatSync(file);
              values.set(path.relative(rootDir, file), `${entry.mtimeMs}:${entry.ctimeMs}:${entry.size}:${entry.ino}`);
            }
          } catch {
            // Missing, replaced or inaccessible paths produce an invalidation too.
            values.set(path.relative(rootDir, target), 'unavailable');
          }
        }
        return values;
      }
      let previous = snapshot();
      let closed = false;
      // Scoped polling works on hosts where native recursive watchers are unavailable.
      const timer = setInterval(() => {
        const next = snapshot();
        const changed = new Set([...previous.keys(), ...next.keys()]);
        const before = previous;
        previous = next;
        for (const file of changed) {
          if (!closed && !disposed && before.get(file) !== next.get(file)) onChange(file);
        }
      }, 250);
      timer.unref();
      const unsubscribe = () => {
        closed = true;
        clearInterval(timer);
        subscriptions.delete(unsubscribe);
      };
      subscriptions.add(unsubscribe);
      return unsubscribe;
    },
    async listAgents() {
      // Config normalization stays owned by the scheduler; use its keys and pool aggregation.
      const control = json<Record<string, unknown>>(path.join(getPaths(rootDir).configDir, 'control-plane.json'), {});
      const selected = control.spawnCustomAgents;
      for (const file of Array.isArray(selected) ? selected : typeof selected === 'string' ? [selected] : []) resolve(file);
      return listConfiguredCustomAgents(rootDir, runtimeState()) as AgentRecord[];
    },
    async getAgent(agentKey) {
      return (await api.listAgents()).find((agent) => agent.runtimeKey === agentKey) || null;
    },
    async listRuns(agentKey) {
      return Object.entries(runtimeState().customAgentInvocations || {})
        .map(([id, run]) => ({ ...(run as RunRecord), invocationId: id }) as RunRecord)
        .filter((run) => !agentKey || run.runtimeKey === agentKey || run.baseRuntimeKey === agentKey)
        .sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    },
    async getRun(runId) {
      const run = (await api.listRuns()).find((entry) => entry.invocationId === runId);
      if (!run) return null;
      const outputs: Record<string, unknown> = {};
      if (run.paths?.invocationDir) {
        for (const phase of ['environment', 'prompt', 'finalize']) {
          const output = json(path.join(run.paths.invocationDir, `${phase}.command.json`), null);
          if (output !== null) outputs[phase] = output;
        }
      }
      return { ...run, outputs };
    },
    async readLogs(runId, logOptions = {}) {
      const run = (await api.listRuns()).find((entry) => entry.invocationId === runId);
      if (!run) throw new Error(`Unknown run: ${runId}`);
      if (!run.paths?.invocationDir) return { path: null, text: '', nextOffset: 0, done: true };
      const directory = resolve(run.paths.invocationDir);
      let logPath = logOptions.path;
      if (!logPath) {
        const files = listFiles(directory);
        logPath = files.find((entry) => entry.type === 'file' && /\.(log|jsonl)$/.test(entry.path))?.path;
        if (!logPath) return { path: null, text: '', nextOffset: 0, done: true };
        logPath = path.relative(directory, path.join(rootDir, logPath));
      }
      const file = resolve(inside(path.resolve(directory, logPath), directory));
      inside(fs.realpathSync(file), fs.realpathSync(directory));
      const offset = logOptions.offset ?? 0;
      const limit = logOptions.limit ?? 65536;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1048576) throw new Error('Invalid log page bounds.');
      const fd = fs.openSync(file, 'r');
      try {
        const bytes = Buffer.alloc(limit + 3);
        const available = fs.readSync(fd, bytes, 0, bytes.length, offset);
        let length = Math.min(limit, available);
        // Finish a UTF-8 character straddling the page boundary; offsets stay byte based.
        while (length < available && (bytes[length] & 0xc0) === 0x80) length++;
        return { path: path.relative(directory, file), text: bytes.subarray(0, length).toString('utf8'), nextOffset: offset + length, done: offset + length >= fs.fstatSync(fd).size };
      } finally { fs.closeSync(fd); }
    },
    async runAction(name, input) {
      assertOpen();
      const action = actions.get(name);
      if (!action) throw new Error(`Unknown action: ${name}`);
      const validated = action.validate(input);
      const key = action.lockKey || name;
      if (locks.has(key)) throw new Error(`Action already running: ${key}`);
      const operation: Operation = { id: randomUUID(), name, status: 'running', startedAt: new Date().toISOString(), logs: [] };
      saveOperation(operation);
      operations.set(operation.id, operation);
      locks.add(key);
      void Promise.resolve().then(() => action.run(validated, {
        rootDir,
        log(message) {
          operation.logs.push(String(message));
          if (!disposed) saveOperation(operation);
        },
      })).then((result) => {
        operation.result = result === undefined ? null : JSON.parse(JSON.stringify(result));
        operation.status = 'success';
      }).catch((error) => {
        operation.status = 'failure';
        operation.error = error instanceof Error ? error.message : String(error);
      }).finally(() => {
        operation.finishedAt = new Date().toISOString();
        locks.delete(key);
        // Disposing closes subscriptions, but running handlers are not forcibly cancelled.
        if (!disposed) saveOperation(operation);
      }).catch(() => { /* The in-memory operation remains readable if persistence fails. */ });
      return copyOperation(operation);
    },
    async getOperation(id) {
      assertOpen();
      const operation = operations.get(id) || json<Operation | null>(operationPath(id), null);
      if (!operation) return null;
      return copyOperation(operation);
    },
    dispose() {
      for (const unsubscribe of subscriptions) unsubscribe();
      disposed = true;
    },
  };
  return api;
}
