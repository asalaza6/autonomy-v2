import type { ActionRuntime } from '../runtime/index.js';
/** Serializable contracts shared by repository pages and their local host. */
export interface FrontendContext {
  repository: { id: string; rootDir: string; name?: string };
  agentKey?: string;
  preset?: string;
  frontend?: unknown;
}

export interface FileEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
}

export interface AgentRecord {
  runtimeKey: string;
  agentId: string;
  [key: string]: unknown;
}

export interface RunRecord {
  invocationId: string;
  runtimeKey: string;
  baseRuntimeKey?: string;
  startedAt?: string;
  paths?: { invocationDir?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface Operation {
  id: string;
  name: string;
  status: 'running' | 'success' | 'failure';
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
  logs: string[];
}

export interface ActionCapabilities {
  executeModel(request: { prompt: string; schema: Record<string, unknown>; readOnly?: boolean; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access'; cwd?: string }): Promise<Record<string, unknown>>;
  setAgentEnabled(agentKey: string, enabled: boolean): unknown;
  controlServer(command: 'server:start' | 'server:kill' | 'server:restart' | 'server:status', options?: Record<string, unknown>): unknown;
}

export interface LocalAction {
  /** Throw on invalid input; return the validated value passed to run. */
  validate(input: unknown): unknown;
  run(input: unknown, context: { rootDir: string; runtime: ActionRuntime; options?: Record<string, unknown>; capabilities?: ActionCapabilities; log(message: string): void }): Promise<unknown> | unknown;
  /** Actions sharing a key cannot run together. Defaults to the action name. */
  lockKey?: string;
}

export interface LogPage {
  path: string | null;
  text: string;
  nextOffset: number;
  done: boolean;
}

export interface AutonomyRuntime {
  readFile(path: string, options?: { encoding?: 'utf8' | 'base64' }): Promise<string>;
  readJson<T = unknown>(path: string): Promise<T>;
  listFiles(path: string, options?: { recursive?: boolean }): Promise<FileEntry[]>;
  watch(paths: string[], onChange: (path: string) => void): () => void;
  listAgents(): Promise<AgentRecord[]>;
  getAgent(agentKey: string): Promise<AgentRecord | null>;
  listRuns(agentKey?: string): Promise<RunRecord[]>;
  getRun(runId: string): Promise<RunRecord | null>;
  /** Offsets and limits are bytes. path is relative to the invocation directory. */
  readLogs(runId: string, options?: { path?: string; offset?: number; limit?: number }): Promise<LogPage>;
  runAction(name: string, input?: unknown): Promise<Operation>;
  getOperation(operationId: string): Promise<Operation | null>;
}
