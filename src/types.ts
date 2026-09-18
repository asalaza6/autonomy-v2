export type AnyRecord = Record<string, any>;

export type CliOptionValue = string | boolean | Array<string | boolean>;
export type CliOptions = Record<string, CliOptionValue>;

export interface GitIdentity extends AnyRecord {
  name: string;
  email: string;
}

export type DeployCommandConfig = string | string[] | {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | number | boolean | null | undefined>;
  shell?: boolean;
};

export interface AgentConfig extends AnyRecord {
  id: string;
  role: string;
  systemPrompt?: string;
  gitIdentity?: GitIdentity;
  taskQueue?: string;
  personaName?: string;
  include?: string[];
  exclude?: string[];
  checks?: string[];
}

export interface AutonomyConfig extends AnyRecord {
  schemaVersion?: number;
  agents: AgentConfig[];
  deployCommand?: DeployCommandConfig;
  mergeActors?: string[];
  integrationBranch?: string;
  mergeStrategy?: string;
  worktreesRoot?: string;
  branchPrefixes?: {
    task?: string;
    [key: string]: any;
  };
}

export interface ScopeViolation extends AnyRecord {
  taskId?: string;
  file?: string;
  reason?: string;
}

export interface ConflictRecord extends AnyRecord {
  conflictedAt?: string;
  message?: string;
}

export interface ReviewDecisionRecord extends AnyRecord {
  reviewerId?: string;
  decision?: string;
  summary?: string;
  publishedSummary?: string;
  reviewedAt?: string;
  conversationId?: string;
  remotePublishFallback?: string;
}

export interface TaskRecord extends AnyRecord {
  id: string;
  title?: string;
  description?: string;
  agentId: string;
  prdId?: string;
  laneKey?: string;
  sprintId?: string;
  baseBranch?: string;
  branch?: string | null;
  type?: string;
  source?: string;
  checks?: string[];
  acceptance?: string[];
  state?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string | null;
  completedAt?: string;
  implementationConversationId?: string;
  conversationReferences?: Record<string, AnyRecord>;
  prId?: string;
  sourceTaskId?: string;
  sourceAgentId?: string;
  reviewRound?: number;
  reviewedAt?: string;
  reviewedCommitCount?: number;
  lastDecision?: string;
  lastError?: string | null;
  lastMergeFailureMessage?: string;
  lastMergeFailureCode?: string;
  dispatcher?: string;
  dispatchedAt?: string;
  scopeViolations?: ScopeViolation[];
  conflicts?: ConflictRecord[];
  conflict?: ConflictRecord;
}

export interface QueueState extends AnyRecord {
  schemaVersion?: number;
  agentId: string;
  role: string;
  tasks: TaskRecord[];
}

export type QueueMap = Record<string, QueueState>;

export interface PrdTaskSpec extends AnyRecord {
  id: string;
  title: string;
  agentId: string;
  description?: string;
  acceptance?: string[];
  sprintId?: string;
}

export interface PrdSpecPayload extends AnyRecord {
  schemaVersion?: number;
  id: string;
  title: string;
  tasks?: PrdTaskSpec[];
  createdAt: string;
  specification?: string;
  requirements?: string[];
  priority?: string;
  archive?: PrdArchiveMetadata;
}

export interface PrdArchiveMetadata extends AnyRecord {
  kind?: 'completed' | 'reset' | string;
  status?: string;
  archivedAt?: string;
  reason?: string;
  fromStatus?: string;
  actor?: string;
}

export interface RepositoryMetadata extends AnyRecord {
  repoId: string;
  label?: string;
  description?: string;
  deployCommand?: DeployCommandConfig;
  packageUpdateCommand?: DeployCommandConfig;
  serverRestartCommand?: DeployCommandConfig;
  deploymentUrl?: string;
  deploymentLabel?: string;
}

export interface RepositoryConfig extends RepositoryMetadata {
  schemaVersion?: number;
}

export interface PrdSourceChat extends AnyRecord {
  repoId?: string;
  conversationId?: string;
  managerMessageId?: string;
  agentMessageId?: string;
  createdAt?: string;
}

export interface PrdLinkedPullRequestSummary extends AnyRecord {
  number?: number | null;
  url?: string | null;
}

export interface PrdStateRecord extends AnyRecord {
  schemaVersion?: number;
  prdId: string;
  status: string;
  plannedTaskIds?: string[];
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrackedPrdRecord extends PrdSpecPayload {
  isQueued?: boolean;
  status?: string;
  updatedAt?: string;
  plannedTaskIds?: string[];
  lastError?: string;
  completedTaskSpecIds?: string[];
  remoteLaneStates?: AnyRecord;
  planningOnlySpec?: boolean;
  source?: AnyRecord;
  pullRequest?: PrdLinkedPullRequestSummary | null;
}

export interface PullRequestRemote extends AnyRecord {
  number?: number;
  url?: string;
  state?: string;
  mergedAt?: string | null;
  merged_at?: string | null;
  html_url?: string;
  title?: string;
  body?: string;
  commitCount?: number;
  commits?: number;
  sha?: string;
  mergeSha?: string;
}

export interface PullRequestRecord extends AnyRecord {
  id: string;
  taskId: string;
  agentId: string;
  laneKey?: string;
  prdId?: string;
  sprintId?: string;
  sourceTitle?: string;
  sourceBody?: string;
  taskIds?: string[];
  completedTaskIds?: string[];
  pendingTaskIds?: string[];
  acceptance?: string[];
  checks?: string[];
  commitCount?: number;
  headBranch?: string | null;
  baseBranch?: string | null;
  status?: string;
  reviews?: ReviewDecisionRecord[];
  createdAt?: string;
  updatedAt?: string;
  remote?: PullRequestRemote | null;
  title?: string;
  body?: string;
  scopeViolations?: ScopeViolation[];
  conflicts?: ConflictRecord[];
  conflict?: ConflictRecord;
  mergeState?: 'waiting' | 'blocked' | 'merged';
  mergeBlockedCode?: string;
  mergeBlockedReason?: string;
  mergeWatchdog?: AnyRecord;
  conversationReferences?: Record<string, AnyRecord>;
}

export interface PrState extends AnyRecord {
  pullRequests: PullRequestRecord[];
}

export interface BranchLock extends AnyRecord {
  taskId?: string;
  laneKey?: string;
  prdId?: string;
  sprintId?: string;
  baseBranch?: string;
  agentId?: string;
  branch?: string;
  worktreePath?: string;
  mode?: string;
  updatedAt?: string;
  completedTasks?: TaskRecord[];
}

export interface BranchLocksState extends AnyRecord {
  locks: BranchLock[];
}

export interface WorkerRuntime extends AnyRecord {
  agentId: string;
  status?: string;
  mode?: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number | null;
  reason?: string;
  lastResult?: any;
  lastError?: string | null;
}

export interface CustomAgentRuntime extends AnyRecord {
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
  workers: Record<string, WorkerRuntime>;
  customAgents?: Record<string, CustomAgentRuntime>;
  customAgentEnabledOverrides?: Record<string, boolean>;
  backlogGraceConsumed?: boolean;
  backlogGraceUntil?: string;
  lastPrdPromotion?: AnyRecord | null;
}

export interface TraceContext extends AnyRecord {
  label?: string;
  value?: string;
  stderrMode?: string;
  errorSummary?: string;
  errorPriority?: number;
}

export interface HttpResponse<TPayload = AnyRecord> extends AnyRecord {
  statusCode: number;
  payload: TPayload;
  raw: string;
}
