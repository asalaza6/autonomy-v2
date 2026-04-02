export type AnyRecord = Record<string, any>;

export type CliOptionValue = string | boolean | Array<string | boolean>;
export type CliOptions = Record<string, CliOptionValue>;

export interface GitIdentity extends AnyRecord {
  name: string;
  email: string;
}

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
  id: string;
  label?: string;
  description?: string;
  default?: boolean;
}

export interface ControlPlaneConfig extends AnyRecord {
  schemaVersion?: number;
  repos: ControlPlaneRepoRecord[];
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

export interface ControlPlaneSiteCreatePayload extends AnyRecord {
  site: ManagedSiteRecord;
  autoStart?: boolean;
  publishToHeroku?: boolean;
  herokuAppName?: string;
}

export interface ControlPlaneSiteDeployPayload extends AnyRecord {
  site: ManagedSiteRecord;
  herokuAppName?: string;
}

export interface ControlPlaneJobRecord extends AnyRecord {
  id: string;
  type: 'prd:add' | 'site:create' | 'site:deploy';
  repoId: string;
  payload: ControlPlanePrdAddPayload | ControlPlaneSiteCreatePayload | ControlPlaneSiteDeployPayload;
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
  snapshot: AnyRecord;
}

export interface ControlPlaneState extends AnyRecord {
  schemaVersion?: number;
  jobs: ControlPlaneJobRecord[];
  repoStatuses: Record<string, ControlPlaneRepoStatusRecord>;
}

export interface ManagedSiteContent extends AnyRecord {
  title: string;
  headline?: string;
  description?: string;
  body?: string;
  footer?: string;
  accent?: string;
}

export interface ManagedSiteDeployment extends AnyRecord {
  target?: 'heroku';
  status: 'idle' | 'pending' | 'deployed' | 'failed' | 'skipped';
  provider?: 'heroku';
  appName?: string;
  appUrl?: string;
  buildId?: string;
  version?: string;
  sourceBundlePath?: string;
  lastError?: string;
  updatedAt?: string;
}

export interface ManagedSiteRecord extends AnyRecord {
  id: string;
  slug: string;
  name: string;
  description?: string;
  repoRoot?: string;
  branch?: string;
  siteDir: string;
  port: number;
  localUrl?: string | null;
  routePath: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  desiredState: 'running' | 'stopped';
  createdAt: string;
  updatedAt: string;
  installStatus?: 'pending' | 'installing' | 'installed' | 'failed';
  initStatus?: 'pending' | 'initializing' | 'initialized' | 'failed';
  bootstrapError?: string | null;
  pid?: number | null;
  startedAt?: string | null;
  stoppedAt?: string | null;
  lastExitCode?: number | null;
  lastSignal?: string | null;
  healthStatus?: 'unknown' | 'healthy' | 'unhealthy';
  healthMessage?: string;
  healthCheckedAt?: string | null;
  logPath?: string;
  publicUrl?: string | null;
  deployment?: ManagedSiteDeployment;
  content?: ManagedSiteContent;
}

export interface ManagerState extends AnyRecord {
  schemaVersion?: number;
  nextSiteIndex?: number;
  sites: ManagedSiteRecord[];
}

export interface ManagerSiteCreateRequest extends AnyRecord {
  name: string;
  description?: string;
  slug?: string;
  autoStart?: boolean;
  publishToHeroku?: boolean;
  content?: Partial<ManagedSiteContent>;
}

export interface ManagerSiteDeployRequest extends AnyRecord {
  target?: 'heroku';
  appName?: string;
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
