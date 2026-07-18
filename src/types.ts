import type { ChildProcess } from 'node:child_process';

export type JsonRecord = Record<string, any>;

export type CommandConfig = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  shell: boolean;
  timeoutMs: number;
};

export type CustomAgentContext = {
  globalReadOnly: Array<{
    path: string;
    relativePath: string;
  }>;
  workspaceReadWrite: string[];
  allowRuntimeStateChanges: boolean;
};

export type CustomAgentConversation = {
  mode: 'fresh' | 'scoped';
  persist: boolean;
  key: string;
  resumeSessionId: string;
};

export type NormalizedCustomAgent = {
  id: string;
  runtimeKey: string;
  baseRuntimeKey: string;
  parallelSlot: number;
  parallelism: number;
  enabled: boolean;
  kind: string;
  promptRole: string;
  promptIntro: string;
  instructions: string;
  promptPath: string;
  target: JsonRecord;
  workspace: string;
  workspacePath: string;
  intervalSeconds: number;
  singletonKey: string;
  singletonValue: string;
  decisionMode: 'always' | 'command';
  decisionCommand: CommandConfig | null;
  environmentCommand: CommandConfig | null;
  promptCommand: CommandConfig | null;
  finalizeCommand: CommandConfig | null;
  conversationMode: 'fresh' | 'scoped';
  context: CustomAgentContext;
};

export type LoadedCustomAgentConfig = {
  path: string;
  enabled: boolean;
  kind: string;
  promptRole: string;
  promptIntro: string;
  agents: NormalizedCustomAgent[];
};

export type CustomAgentStatus = {
  agentId: string;
  runtimeKey: string;
  baseRuntimeKey?: string;
  parallelSlot?: number;
  parallelism?: number;
  enabled: boolean;
  status: 'idle' | 'running' | 'disabled' | 'blocked';
  running: boolean;
  pid: number | null;
  target: JsonRecord;
  workspacePath: string;
  singletonKey: string;
  singletonValue: string;
  intervalSeconds: number;
  lastPollAt?: string;
  lastDecision?: string;
  lastDecisionReason?: string;
  lastError?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  invocationId?: string;
  phase?: string;
  decisionToken?: string;
  decisionExpiresAt?: string;
  conversationId?: string;
  lastConversationId?: string;
  lastResult?: JsonRecord | null;
};

export type CustomAgentInvocation = {
  invocationId: string;
  runtimeKey: string;
  baseRuntimeKey?: string;
  agentId: string;
  parallel?: { slot: number; total: number };
  status: 'running' | 'completed' | 'failed';
  phase: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  target: JsonRecord;
  workspace: { cwd: string };
  paths: {
    invocationDir: string;
    contextPath: string;
  };
  lastError: string | null;
  result?: JsonRecord | null;
};

export type RuntimeState = {
  schemaVersion: 1;
  customAgents: Record<string, CustomAgentStatus>;
  customAgentInvocations: Record<string, CustomAgentInvocation>;
};

export type PendingCustomAgentStart = {
  runtimeKey: string;
  baseRuntimeKey: string;
  parallelSlot: number;
  parallelism: number;
  invocationId: string;
  agentId: string;
  target: JsonRecord;
  startedAt: string;
  runtimeContextPath: string;
  conversation: CustomAgentConversation;
};

export type StartedCustomAgent = {
  runtimeKey: string;
  baseRuntimeKey: string;
  parallelSlot: number;
  parallelism: number;
  invocationId: string;
  agentId: string;
  target: JsonRecord;
  reason: string;
  startedAt: string;
  pid: number | null;
};

export type LaunchedCustomAgent = {
  start: StartedCustomAgent;
  child: ChildProcess;
};

export type SchedulerTickResult = {
  rootDir: string;
  started: StartedCustomAgent[];
  launched: LaunchedCustomAgent[];
  runtime: RuntimeState;
};

export type CliOptions = Record<string, string | boolean>;
