export type AnyRecord = Record<string, any>;

type CliOptionValue = string | boolean | Array<string | boolean>;
export type CliOptions = Record<string, CliOptionValue>;

interface CustomAgentRuntime extends AnyRecord {
  agentId: string;
  runtimeKey?: string;
  baseRuntimeKey?: string;
  parallelSlot?: number;
  parallelism?: number;
  runningCount?: number;
  slots?: AnyRecord[];
  enabled?: boolean;
  target?: AnyRecord;
  status?: string;
  running?: boolean;
  pid?: number | null;
  startedAt?: string;
  finishedAt?: string;
  lastPollAt?: string;
  lastDecision?: string | null;
  lastDecisionReason?: string | null;
  conversationMode?: string | null;
  conversationKey?: string | null;
  conversationScope?: string[] | null;
  conversationId?: string | null;
  lastConversationId?: string | null;
  conversations?: Record<string, AnyRecord>;
  workspacePath?: string | null;
  singletonKey?: string | null;
  singletonValue?: string | null;
  intervalSeconds?: number | null;
  offsetSeconds?: number | null;
  lastPollWindowStart?: number | null;
  lastError?: string | null;
}

export interface RuntimeState extends AnyRecord {
  customAgents?: Record<string, CustomAgentRuntime>;
  customAgentEnabledOverrides?: Record<string, boolean>;
}

export interface TraceContext extends AnyRecord {
  label?: string;
  value?: string;
  stderrMode?: string;
  errorSummary?: string;
  errorPriority?: number;
}
