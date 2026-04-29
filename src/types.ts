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

export interface ControlPlaneRepoRecord extends AnyRecord {
  repoId: string;
  label?: string;
  description?: string;
  default?: boolean;
  repoAssistantValidationPullRequest?: number;
  deployCommand?: DeployCommandConfig;
  packageUpdateCommand?: DeployCommandConfig;
  controlBridgeRestartCommand?: DeployCommandConfig;
  serverRestartCommand?: DeployCommandConfig;
  restartLaunchMode?: 'visible-terminal' | 'detached';
  restartLaunchFallbackToDetached?: boolean;
  deploymentUrl?: string;
  deploymentLabel?: string;
  exclusiveControl?: boolean;
  controlTakeover?: 'refuse' | 'takeover';
  serviceProviders?: ControlPlaneServiceProviderRecord[];
  serviceConnections?: ControlPlaneServiceConnectionRecord[];
  providerDeploy?: ControlPlaneServiceDeploySelection;
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
  providerId?: string;
  connectionId?: string;
}

export interface ControlPlaneServiceDeploySelection extends AnyRecord {
  providerId: string;
  connectionId: string;
}

export interface ControlPlaneServiceFieldRecord extends AnyRecord {
  field: string;
  label?: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
}

export interface ControlPlaneServiceCommandRecord extends AnyRecord {
  command: DeployCommandConfig;
}

export interface ControlPlaneServiceProviderRecord extends AnyRecord {
  providerId: string;
  label?: string;
  authStrategies?: string[];
  authFields?: ControlPlaneServiceFieldRecord[];
  requiredScopes?: string[];
  verifyCommand?: ControlPlaneServiceCommandRecord;
  preflightCommand?: ControlPlaneServiceCommandRecord;
  deployCommand?: ControlPlaneServiceCommandRecord;
  postDeployMetadataCommand?: ControlPlaneServiceCommandRecord;
  capabilityMetadata?: Record<string, string | number | boolean | null>;
}

export interface ControlPlaneServiceConnectionRecord extends AnyRecord {
  providerId: string;
  connectionId: string;
  label?: string;
  authStrategy: string;
  envAliases?: Record<string, string>;
  accountMetadata?: Record<string, string | number | boolean | null>;
  capabilityMetadata?: Record<string, string | number | boolean | null>;
}

export type ControlPlaneServiceConnectionStatus =
  | 'connected'
  | 'verification-failed'
  | 'expired'
  | 'revoked'
  | 'insufficient-scopes'
  | 'needs-reconnect'
  | 'pending';

export type ControlPlaneServiceFailureClass =
  | 'missing-env-alias'
  | 'unresolved-secret-field'
  | 'invalid-credential'
  | 'insufficient-scopes'
  | 'expired'
  | 'revoked'
  | 'verification-failed'
  | 'provider-error'
  | 'needs-reconnect';

export interface ControlPlaneServiceConnectionFieldStatus extends AnyRecord {
  field: string;
  label?: string;
  envKey?: string | null;
  required?: boolean;
  secret?: boolean;
  resolved: boolean;
  source?: 'runtime' | 'machine-local' | 'shared-file' | 'unresolved';
}

export interface ControlPlaneServiceConnectionSummary extends AnyRecord {
  providerId: string;
  providerLabel?: string;
  connectionId: string;
  label?: string;
  authStrategy: string;
  status: ControlPlaneServiceConnectionStatus;
  statusLabel?: string;
  lastVerifiedAt?: string | null;
  failureClass?: ControlPlaneServiceFailureClass | null;
  failureLabel?: string | null;
  accountMetadata?: Record<string, string | number | boolean | null>;
  capabilityMetadata?: Record<string, string | number | boolean | null>;
  requiredScopes?: string[];
  fieldStatuses?: ControlPlaneServiceConnectionFieldStatus[];
}

export interface ControlPlaneServiceAuthPayload extends AnyRecord {
  repoId: string;
  providerId: string;
  connectionId: string;
  authStrategy?: string;
}

export interface ControlPlanePrdResetPayload extends AnyRecord {
  repoId: string;
  confirmPrdId: string;
  reason?: string;
}

export interface ControlPlanePackageUpdatePayload extends AnyRecord {
  repoId: string;
}

export interface ControlPlaneRestartPayload extends AnyRecord {
  repoId: string;
  controlSessionId?: string;
  controlSessionLabel?: string;
  takeoverControl?: boolean;
}

export interface ControlPlaneManagedProcessRecord extends AnyRecord {
  repoId: string;
  target: 'server' | 'controlBridge';
  sessionId: string;
  outputSessionId?: string;
  pid?: number | null;
  running?: boolean;
  launchMode?: 'configured' | 'default';
  restartLaunchMode?: 'visible-terminal' | 'detached';
  lifecycleAction?: 'restart';
  singletonPolicy?: 'replace';
  singletonOutcome?: 'started' | 'replaced' | 'reused' | 'refused' | 'failed';
  command?: string | null;
  cwd?: string | null;
  requestedBySessionId?: string | null;
  requestedBySessionLabel?: string | null;
  requestedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  exitedAt?: string | null;
  exitReason?: string | null;
  preRestartPid?: number | null;
  postRestartPid?: number | null;
  replacementOfSessionId?: string | null;
  replacementOfPid?: number | null;
  error?: string | null;
}

export interface ControlPlaneRepoControlOwner extends AnyRecord {
  repoId: string;
  sessionId: string;
  sessionLabel?: string | null;
  exclusiveControl?: boolean;
  takeoverPolicy?: 'refuse' | 'takeover';
  claimedAt: string;
  lastSeenAt: string;
  takeoverAt?: string | null;
  takeoverCount?: number;
}

export interface ControlPlaneRepoControlAccess extends AnyRecord {
  repoId: string;
  sessionId?: string | null;
  sessionLabel?: string | null;
  exclusiveControl: boolean;
  canManage: boolean;
  isOwner: boolean;
  readOnly: boolean;
  owner?: ControlPlaneRepoControlOwner | null;
  takeoverPolicy?: 'refuse' | 'takeover';
  refusalReason?: string | null;
}

export interface ControlPlaneAgentChatMessagePayload extends AnyRecord {
  repoId: string;
  conversationId: string;
  messageId: string;
  responseMessageId: string;
  prompt: string;
  resumeSessionId?: string;
  history?: Array<Pick<ControlPlaneChatMessageRecord, 'role' | 'content' | 'createdAt'>>;
}

export interface ControlPlanePrdProposalSource extends AnyRecord {
  repoId?: string;
  conversationId?: string;
  messageId?: string;
  responseMessageId?: string;
  createdAt?: string;
}

export interface ControlPlanePrdSourceChat extends AnyRecord {
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
  codexConversationId?: string;
  continuityMode?: 'history-only' | 'codex-session';
  continuityError?: string;
  messages: ControlPlaneChatMessageRecord[];
}

export interface ControlPlaneJobRecord extends AnyRecord {
  id: string;
  type:
    | 'prd:add'
    | 'prd:reset'
    | 'deploy'
    | 'agent:chat'
    | 'package:update'
    | 'restart'
    | 'service:auth:start'
    | 'service:auth:complete'
    | 'service:auth:verify';
  repoId: string;
  payload:
    | ControlPlanePrdAddPayload
    | ControlPlanePrdResetPayload
    | ControlPlaneDeployPayload
    | ControlPlaneAgentChatMessagePayload
    | ControlPlanePackageUpdatePayload
    | ControlPlaneRestartPayload
    | ControlPlaneServiceAuthPayload;
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
  exclusiveControl?: boolean;
  controlTakeover?: 'refuse' | 'takeover';
  serviceConnections?: ControlPlaneServiceConnectionSummary[];
  snapshot: AnyRecord;
}

export interface ControlPlaneState extends AnyRecord {
  schemaVersion?: number;
  jobs: ControlPlaneJobRecord[];
  repoStatuses: Record<string, ControlPlaneRepoStatusRecord>;
  conversations: Record<string, ControlPlaneConversationRecord[]>;
  heartbeats: Record<string, ControlPlaneHeartbeatRecord>;
  managedProcesses?: Record<string, Partial<Record<'server' | 'controlBridge', ControlPlaneManagedProcessRecord>>>;
  controlOwnership?: Record<string, ControlPlaneRepoControlOwner>;
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

export interface RuntimeState extends AnyRecord {
  workers: Record<string, WorkerRuntime>;
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
