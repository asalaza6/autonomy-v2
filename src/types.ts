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
  prId?: string;
  sourceTaskId?: string;
  sourceAgentId?: string;
  reviewRound?: number;
  reviewedAt?: string;
  reviewedCommitCount?: number;
  lastDecision?: string;
  lastError?: string | null;
  lastMergeFailureMessage?: string;
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
}

export interface ControlPlaneRepoRecord extends AnyRecord {
  repoId: string;
  label?: string;
  description?: string;
  default?: boolean;
  deployCommand?: DeployCommandConfig;
  deploymentUrl?: string;
  deploymentLabel?: string;
}

export interface ControlPlaneConfig extends ControlPlaneRepoRecord {
  schemaVersion?: number;
}

export interface ControlPlanePrdAddPayload extends AnyRecord {
  repoId: string;
  id: string;
  title: string;
  specification?: string;
  requirements?: string[];
  taskSpecs?: PrdTaskSpec[];
  sprintId?: string;
}

export interface ControlPlaneDeployPayload extends AnyRecord {
  repoId: string;
}

export interface ControlPlaneAgentChatMessagePayload extends AnyRecord {
  repoId: string;
  conversationId: string;
  messageId: string;
  responseMessageId: string;
  prompt: string;
  history?: Array<Pick<ControlPlaneChatMessageRecord, 'role' | 'content' | 'createdAt'>>;
}

export interface ControlPlanePrdProposalSource extends AnyRecord {
  repoId?: string;
  conversationId?: string;
  messageId?: string;
  responseMessageId?: string;
  createdAt?: string;
}

export interface ControlPlanePrdProposal extends AnyRecord {
  schemaVersion?: number;
  kind: 'prd-proposal';
  title: string;
  problem?: string;
  goal?: string;
  requirements: string[];
  acceptanceCriteria: string[];
  verification: string[];
  priority?: string;
  source?: ControlPlanePrdProposalSource;
}

export interface ControlPlaneChatMessageRecord extends AnyRecord {
  id: string;
  role: 'manager' | 'agent';
  content: string;
  createdAt: string;
  updatedAt?: string;
  status?: 'queued' | 'responding' | 'complete' | 'failed';
  jobId?: string;
  error?: string;
  prdProposal?: ControlPlanePrdProposal;
}

export interface ControlPlaneConversationRecord extends AnyRecord {
  id: string;
  repoId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ControlPlaneChatMessageRecord[];
}

export interface ControlPlaneJobRecord extends AnyRecord {
  id: string;
  type: 'prd:add' | 'deploy' | 'agent:chat';
  repoId: string;
  payload: ControlPlanePrdAddPayload | ControlPlaneDeployPayload | ControlPlaneAgentChatMessagePayload;
  status: 'queued' | 'claimed' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  error?: string;
  result?: AnyRecord;
}

export interface ControlPlaneRepoStatusRecord extends AnyRecord {
  repoId: string;
  updatedAt: string;
  label?: string;
  description?: string;
  default?: boolean;
  deploymentUrl?: string;
  deploymentLabel?: string;
  snapshot: AnyRecord;
}

export interface ControlPlaneState extends AnyRecord {
  schemaVersion?: number;
  jobs: ControlPlaneJobRecord[];
  repoStatuses: Record<string, ControlPlaneRepoStatusRecord>;
  conversations: Record<string, ControlPlaneConversationRecord[]>;
  heartbeats: Record<string, ControlPlaneHeartbeatRecord>;
}

export interface ControlPlaneHeartbeatRecord extends AnyRecord {
  kind: 'server' | 'bridge';
  updatedAt: string;
  note?: string;
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

export interface RuntimeState extends AnyRecord {
  workers: Record<string, WorkerRuntime>;
  backlogGraceConsumed?: boolean;
  backlogGraceUntil?: string;
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
