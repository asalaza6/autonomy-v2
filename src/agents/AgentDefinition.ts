import path from 'path';
import { AGENT_ROLES } from './role-catalog.js';
import type {
  AgentConfig,
  AutonomyConfig,
  BranchLocksState,
  PullRequestRecord,
  QueueMap,
  QueueState,
  RuntimeState,
  TaskRecord,
  TrackedPrdRecord,
  AnyRecord,
} from '../types.js';

type AgentDefinitionHelpers = {
  isAbsolutePath?: (value: string) => boolean;
  resolveRepoPath?: (rootDir: string, relativePath: string) => string;
  resolveRuntimePath?: (rootDir: string, relativePath: string) => string;
  normalizeConfigPath?: (value: string) => string;
  isRuntimeManagedTaskQueuePath?: (value: string) => boolean;
  path?: typeof import('path');
};

type AgentExecutionPhase = 'schedule' | 'worker' | 'runner';

type ClaimedPrdWork = {
  kind: 'prd';
  agentId: string;
  reason: string;
  prd: TrackedPrdRecord;
};

type ClaimedTaskWork = {
  kind: 'task';
  agentId: string;
  reason: string;
  taskId: string;
  branch?: string | null;
  worktreePath?: string | null;
  task?: TaskRecord | null;
  dispatchTask?: TaskRecord | null;
  queueContext?: AnyRecord | null;
};

type ClaimedReviewWork = {
  kind: (typeof AGENT_ROLES)['REVIEW'];
  agentId: string;
  reason: string;
  reviewTaskId: string;
  prId: string;
  sourceAgentId?: string;
  reviewTask?: TaskRecord | null;
};

type ClaimedWork = ClaimedPrdWork | ClaimedTaskWork | ClaimedReviewWork;

type ExecutionResult = AnyRecord & {
  ok: boolean;
  status: string;
  reason?: string;
};

type FinalizeResult = AnyRecord & {
  status?: string;
};

type AgentExecutionSnapshot = {
  queues?: QueueMap;
  branchLocks?: BranchLocksState;
  prds?: { prds: TrackedPrdRecord[] };
  runtime?: RuntimeState;
  prs?: { pullRequests: PullRequestRecord[] };
};

type QueueStoreCapability = {
  listTasks?: (queue: QueueState | AnyRecord) => TaskRecord[];
  buildQueueState?: (agent: AgentConfig, tasks?: TaskRecord[]) => QueueState;
  loadQueues?: () => QueueMap;
  getTask?: (queues: QueueMap, taskId: string) => TaskRecord;
  getReviewTask?: (queues: QueueMap, reviewTaskId: string) => TaskRecord;
  getLaneTasks?: (queues: QueueMap, agentId: string, laneKey: string) => TaskRecord[];
  getCompletedLaneTasks?: (agentId: string, laneKey: string) => TaskRecord[];
  resolveImplementationQueueContext?: (agent: AgentConfig, queue: QueueState, branchLocks: BranchLocksState) => AnyRecord;
  selectImplementationTask?: (tasks: TaskRecord[], prds: TrackedPrdRecord[]) => TaskRecord | null;
  implementationTaskNeedsDispatch?: (task: TaskRecord) => boolean;
  isPendingImplementationTask?: (task: TaskRecord) => boolean;
  buildTaskLaneKey?: (task: TaskRecord | AnyRecord) => string;
  claimQueuedReviewTask?: (agentId: string) => TaskRecord | null;
  markReviewDispatchFailure?: (agentId: string, taskId: string, message: string) => void;
  claimImplementationTaskInWorktree?: (agent: AgentConfig, task: TaskRecord, branch: string, worktreePath: string) => { task: TaskRecord; branch: string; };
  markImplementationTaskComplete?: (worktreePath: string, config: AutonomyConfig, task: TaskRecord, branch: string, completionMode: string) => { queuePath: string; relativePath: string; };
  recordImplementationTaskCommitSha?: (worktreePath: string, config: AutonomyConfig, task: TaskRecord, commitSha: string) => { queuePath: string; relativePath: string; changed: boolean; };
  recordLaneTaskCompletion?: (task: TaskRecord, branch: string, worktreePath: string, scopeResult?: AnyRecord) => TaskRecord[];
  persistReviewerTaskState?: (reviewTaskId: string, patch: AnyRecord) => void;
  writeQueueAndAggregate?: (agentId: string, queue: QueueState, options?: AnyRecord) => void;
};

type PrdStoreCapability = {
  listPrds?: (prdsState: { prds: TrackedPrdRecord[] }) => TrackedPrdRecord[];
  loadPrds?: (options?: AnyRecord) => { prds: TrackedPrdRecord[] };
  readTrackedPrdStateMap?: () => Map<string, AnyRecord>;
  commitPrdSpec?: (spec: AnyRecord, options?: AnyRecord) => AnyRecord;
  commitTrackedFiles?: (updates: AnyRecord[], options?: AnyRecord) => AnyRecord;
  commitPrdState?: (payload: AnyRecord, options?: AnyRecord) => AnyRecord;
};

type PrStoreCapability = {
  getPrForLane?: (agentId: string, laneKey: string) => PullRequestRecord | null;
  getPr?: (prId: string) => PullRequestRecord;
  recordReviewDecision?: (params: AnyRecord) => void;
  finalizeTaskRun?: (params: AnyRecord) => void;
};

type BranchLockStoreCapability = {
  loadBranchLocks?: () => BranchLocksState;
  getCompletedLaneTasks?: (agentId: string, laneKey: string) => TaskRecord[];
  recordLaneTaskCompletion?: (task: TaskRecord, branch: string, worktreePath: string, scopeResult?: AnyRecord) => TaskRecord[];
};

type RuntimeStoreCapability = {
  loadState?: (options?: AnyRecord) => AnyRecord;
  loadRuntime?: () => RuntimeState;
  writeRuntime?: (runtime: RuntimeState) => void;
  executeRunner?: (env: AnyRecord) => AnyRecord;
};

type ScmCapability = {
  prepareTaskWorktree?: (taskId: string) => { branch: string; worktreePath: string; };
  ensureDir?: (targetPath: string) => void;
  fsExists?: (filePath: string) => boolean;
  readFile?: (filePath: string) => string;
  writeFile?: (filePath: string, content: string) => void;
  relativePath?: (fromPath: string, toPath: string) => string;
  resolveTargetFile?: (worktreePath: string, task: TaskRecord, agent: AgentConfig) => string;
  ensureCheckEnvironment?: (worktreePath: string, commands: string[]) => void;
  runCheckCommands?: (worktreePath: string, commands: string[]) => AnyRecord[];
  listChangedFiles?: (worktreePath: string) => string[];
  listReviewDiffFiles?: (worktreePath: string, baseBranch: string) => string[];
  listBranchCommits?: (worktreePath: string, baseBranch: string) => AnyRecord[];
  ensureReviewContext?: (pr: PullRequestRecord) => { branch: string; worktreePath: string; };
  buildCommitMessage?: (agentId: string, task: TaskRecord, hasPriorLaneWork: boolean) => string;
  buildQueueMetadataCommitMessage?: (agentId: string, task: TaskRecord) => string;
  runGit?: (cwd: string, args: string[]) => void;
  readGit?: (cwd: string, args: string[]) => string;
  tryPushBranch?: (worktreePath: string, branch: string) => { ok: boolean; message: string; };
  tryMergeWithRetry?: (prId: string, agentId: string) => { merged: boolean; message: string | null; code?: string | null; };
  hasStagedGitChanges?: (cwd: string) => boolean;
};

type ReviewClientCapability = {
  hasGithubAuth?: () => boolean;
  publishMergeFollowupCommentIfNeeded?: (pr: PullRequestRecord, reviewerTask: TaskRecord, mergeMessage: string | null) => boolean;
  resolveGithubRepo?: () => AnyRecord;
  resolveGithubAuthToken?: (options?: AnyRecord) => string;
  postIssueComment?: (repo: AnyRecord, token: string, issueNumber: number, body: string) => void;
};

type CodexCapability = {
  useStub?: () => boolean;
  planPrdTasks?: (params: AnyRecord) => AnyRecord;
  executeTask?: (params: AnyRecord) => Promise<AnyRecord>;
  reviewPr?: (params: AnyRecord) => Promise<AnyRecord>;
};

type ScopeEvaluatorCapability = {
  evaluate?: (params: AnyRecord) => AnyRecord;
};

type ClockCapability = {
  now: () => string;
};

type LoggerCapability = {
  appendAgentLog?: (agentId: string, event: string, payload?: AnyRecord) => void;
  appendRunnerLog?: (agentId: string, event: string, payload: AnyRecord) => void;
  logRunnerEvent?: (eventName: string, payload?: AnyRecord) => void;
};

type AgentExecutionContext = {
  phase: AgentExecutionPhase;
  rootDir: string;
  agent: AgentConfig;
  config: AutonomyConfig;
  sprint?: AnyRecord;
  options?: AnyRecord;
  current?: AgentExecutionSnapshot;
  queueStore: QueueStoreCapability;
  prdStore: PrdStoreCapability;
  prStore: PrStoreCapability;
  branchLockStore: BranchLockStoreCapability;
  runtimeStore: RuntimeStoreCapability;
  scm: ScmCapability;
  reviewClient: ReviewClientCapability;
  codex: CodexCapability;
  scopeEvaluator: ScopeEvaluatorCapability;
  clock: ClockCapability;
  logger: LoggerCapability;
};

class AgentDefinition {
  roleId: string;

  constructor(roleId: string) {
    this.roleId = roleId;
  }

  validateConfig(_agent?: AgentConfig, _sourcePath?: string, _helpers?: AgentDefinitionHelpers): void {}

  validateScaffoldConfig(_agent?: AgentConfig, _sourcePath?: string): void {}

  resolveTaskQueue(rootDir: string, agent: AgentConfig, helpers: AgentDefinitionHelpers): string {
    const relativePath = agent.taskQueue;
    if (!relativePath) {
      throw new Error(`Agent "${agent.id}" is missing required taskQueue in config.`);
    }
    if (helpers.isAbsolutePath && helpers.isAbsolutePath(relativePath)) {
      return relativePath;
    }
    if (this.usesTrackedQueue()) {
      return helpers.resolveRepoPath
        ? helpers.resolveRepoPath(rootDir, relativePath)
        : relativePath;
    }
    return helpers.resolveRuntimePath
      ? helpers.resolveRuntimePath(rootDir, relativePath)
      : relativePath;
  }

  buildQueueState(agent: AgentConfig, tasks: TaskRecord[] = []): QueueState {
    return {
      agentId: agent.id,
      role: this.roleId,
      tasks,
    };
  }

  usesTrackedQueue(): boolean {
    return false;
  }

  requiresRunner(): boolean {
    return true;
  }

  buildSystemPrompt(agent: AgentConfig, _config: AutonomyConfig): string {
    return `# ${this.getDisplayName(agent)} System\n`;
  }

  buildHandoffTemplate(agent: AgentConfig): string {
    return [
      `# ${this.getDisplayName(agent)} Handoff`,
      '',
      '## Current State',
      '',
      '_No active handoff yet._',
      '',
    ].join('\n');
  }

  buildLogTemplate(agent: AgentConfig): string {
    return `# ${this.getDisplayName(agent)} Log\n`;
  }

  canRun(_context: AgentExecutionContext): boolean {
    return false;
  }

  claimWork(_context: AgentExecutionContext): ClaimedWork | null {
    return null;
  }

  execute(_context: AgentExecutionContext, _work: ClaimedWork): ExecutionResult | Promise<ExecutionResult> {
    return {
      ok: true,
      status: 'unsupported',
      reason: `Role "${this.roleId}" has no execution flow for this phase.`,
    };
  }

  finalize(_context: AgentExecutionContext, _work: ClaimedWork, _result: ExecutionResult): FinalizeResult | void {}

  getDisplayName(agent?: AgentConfig): string {
    const source = String(agent && (agent.personaName || agent.id) || 'agent').trim();
    if (!source) {
      return 'Agent';
    }

    return source
      .replace(/[-_]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  entranceCriteria(): { ok: boolean; reason: string } {
    return { ok: true, reason: '' };
  }

  exitCriteria(): { status: string; reason: string; sideEffects: any[] } {
    return { status: 'noop', reason: '', sideEffects: [] };
  }

  validateTrackedQueueConfig(agent?: AgentConfig, sourcePath = '', helpers: AgentDefinitionHelpers = {}): void {
    if (!agent || !agent.taskQueue) {
      return;
    }

    const normalizeConfigPath = helpers.normalizeConfigPath || ((value: string) => String(value || '').trim());
    const taskQueue = normalizeConfigPath(agent.taskQueue);
    if (path.posix.isAbsolute(taskQueue)) {
      throw new Error(
        `Invalid autonomy config at ${sourcePath}: ${this.roleId} agent "${agent.id}" must use a repo-relative taskQueue.`
      );
    }
    if (helpers.isRuntimeManagedTaskQueuePath && helpers.isRuntimeManagedTaskQueuePath(taskQueue)) {
      throw new Error(
        `Invalid autonomy config at ${sourcePath}: ${this.roleId} agent "${agent.id}" cannot use runtime-managed taskQueue paths.`
      );
    }
  }
}


export { AgentDefinition };
export type {
  
  AgentExecutionContext,
  
  
  ClaimedReviewWork,
  ClaimedTaskWork,
  ClaimedWork,
  ExecutionResult,
  
};
