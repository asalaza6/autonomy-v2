import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES, TASK_TYPES } from './role-catalog.js';
import type { AgentConfig, AutonomyConfig, TaskRecord, TrackedPrdRecord, AnyRecord } from '../types.js';
import type { AgentExecutionContext, ClaimedWork, ExecutionResult } from './AgentDefinition.js';

class PmAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.PM);
  }

  requiresRunner() {
    return false;
  }

  getDisplayName(agent?: AgentConfig): string {
    const source = String(agent && (agent.personaName || agent.id) || '').trim();
    if (!source || new RegExp(`^${AGENT_ROLES.PM}([-_\\s]?agent)?$`, 'i').test(source)) {
      return 'PM Agent';
    }
    return super.getDisplayName(agent);
  }

  buildSystemPrompt(agent: AgentConfig, config: AutonomyConfig): string {
    const agentLabel = this.getDisplayName(agent);
    const integrationBranch = config.integrationBranch || 'dev';
    const productionBranch = config.productionBranch || 'main';
    const projectName = config.projectName || 'this repository';

    return [
      `# ${agentLabel} System`,
      '',
      `You are the ${agentLabel} for ${projectName}.`,
      '',
      '## Role',
      '',
      '- Watch the PRD inbox for newly inserted product requests.',
      '- Decompose each PRD into scoped feature-lane tasks for the feature agents.',
      '- Route tasks into the correct per-agent queues with concrete acceptance criteria.',
      '',
      '## Hard Rules',
      '',
      '- Do not write feature code.',
      '- Do not gate or merge pull requests.',
      '- Do not create repo-wide tasks when a narrower scoped task is possible.',
      `- Always target automation at \`${integrationBranch}\`, never \`${productionBranch}\` or \`master\`.`,
      '',
      '## Workflow',
      '',
      '1. Read the next queued PRD from the PRD inbox.',
      '2. Break it into atomic tasks for the configured feature lanes as needed.',
      '3. Assign each task to one agent queue that already owns the needed scope.',
      '4. Record the decomposition result and mark the PRD as planned.',
      '',
    ].join('\n');
  }

  canRun(context: AgentExecutionContext): boolean {
    if (context.phase !== 'schedule') {
      return false;
    }
    const knownPrds = this.listPrds(context, context.current && context.current.prds ? context.current.prds : { prds: [] });
    const hasQueuedPrd = knownPrds.some((prd) => prd.status === 'queued');
    const hasActivePrd = knownPrds.some((prd) => prd.status === 'planning' || prd.status === 'planned');
    return hasQueuedPrd && !hasActivePrd;
  }

  claimWork(context: AgentExecutionContext): ClaimedWork | null {
    if (context.phase !== 'worker') {
      return null;
    }
    const prdsState = context.prdStore.loadPrds ? context.prdStore.loadPrds() : { prds: [] };
    const prd = this.listPrds(context, prdsState)
      .filter((candidate) => candidate.status === 'queued')
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')))[0];
    if (!prd) {
      return null;
    }
    const now = context.clock.now();
    context.prdStore.commitPrdState?.({
      prdId: prd.id,
      status: 'planning',
      createdAt: now,
      updatedAt: now,
    }, {
      commitMessage: `autonomy(prd-state): planning ${prd.id}`,
      gitIdentity: context.agent.gitIdentity,
    });
    prd.status = 'planning';
    prd.updatedAt = now;
    return {
      kind: 'prd',
      agentId: context.agent.id,
      reason: 'queued_prd',
      prd,
    };
  }

  execute(context: AgentExecutionContext, work: ClaimedWork): ExecutionResult {
    if (context.phase !== 'worker' || work.kind !== 'prd') {
      return {
        ok: true,
        status: 'unsupported',
        reason: `Role "${this.roleId}" has no execution flow for this phase.`,
      };
    }
    const sprint = context.sprint || {};
    const prd = work.prd;
    const plannedSpecs = context.codex.useStub && context.codex.useStub()
      ? this.buildPmStubTaskSpecs(context.config, sprint, prd)
      : (context.codex.planPrdTasks
        ? context.codex.planPrdTasks({
            rootDir: context.rootDir,
            agent: context.agent,
            config: context.config,
            sprint,
            prd,
          }).tasks
        : []);
    const sanitizedPlannedSpecs = this.sanitizePlannedTaskSpecs(plannedSpecs);
    if (!Array.isArray(sanitizedPlannedSpecs) || sanitizedPlannedSpecs.length === 0) {
      throw new Error(`PM planning produced no tasks for PRD "${prd.id}".`);
    }

    const createdTaskIds = [];
    try {
      context.prdStore.commitPrdSpec?.({
        id: prd.id,
        title: prd.title,
        createdAt: prd.createdAt,
        specification: prd.specification,
        requirements: prd.requirements,
      }, {
        commitMessage: `autonomy(prd): persist plan ${prd.id}`,
        gitIdentity: context.agent.gitIdentity,
      });

      const queueUpdates = this.buildTrackedImplementationQueueUpdates(context, sanitizedPlannedSpecs, { prd, sprint });
      context.prdStore.commitTrackedFiles?.(queueUpdates, {
        commitMessage: `autonomy(queue): enqueue plan ${prd.id}`,
        gitIdentity: context.agent.gitIdentity,
      });
      createdTaskIds.push(...sanitizedPlannedSpecs.map((spec) => spec.id));
    } catch (error) {
      this.finalizePrd(context, prd.id, {
        status: 'failed',
        error: this.extractErrorMessage(error),
      });
      context.logger.appendAgentLog?.(context.agent.id, 'prd:failed', {
        input: {
          prdId: prd.id,
          taskCount: Array.isArray(prd.plannedTaskIds) ? prd.plannedTaskIds.length : 0,
        },
        output: {
          createdTaskIds,
          status: 'failed',
        },
      });
      throw error;
    }

    this.finalizePrd(context, prd.id, {
      status: 'planned',
      plannedTaskIds: createdTaskIds,
    });
    context.logger.appendAgentLog?.(context.agent.id, 'prd:planned', {
      input: {
        prdId: prd.id,
        taskCount: sanitizedPlannedSpecs.length,
      },
      output: {
        plannedTaskIds: createdTaskIds,
        status: 'planned',
      },
    });

    return {
      ok: true,
      status: 'planned',
      prdId: prd.id,
      createdTaskIds,
    };
  }

  private listPrds(context: AgentExecutionContext, prdsState: { prds: TrackedPrdRecord[] }): TrackedPrdRecord[] {
    if (context.prdStore.listPrds) {
      return context.prdStore.listPrds(prdsState);
    }
    return Array.isArray(prdsState && prdsState.prds) ? prdsState.prds : [];
  }

  private normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }

  private isProcessAcceptance(value: unknown): boolean {
    return /(reflog|origin\/|merge-base|created from|branch|commit)/i.test(String(value || ''));
  }

  private buildFallbackAcceptance(taskId: string): string[] {
    return [`Task \`${taskId}\` is complete within the assigned agent scope.`];
  }

  private sanitizePlannedTaskSpecs(taskSpecs: AnyRecord[]): AnyRecord[] {
    return (Array.isArray(taskSpecs) ? taskSpecs : []).map((task) => {
      const acceptance = this.normalizeStringList(task && task.acceptance)
        .filter((entry) => !this.isProcessAcceptance(entry));
      return {
        ...task,
        acceptance: acceptance.length > 0
          ? acceptance
          : this.buildFallbackAcceptance(task && task.id),
      };
    });
  }

  private buildPmStubTaskSpecs(config: AutonomyConfig, sprint: AnyRecord, prd: TrackedPrdRecord): AnyRecord[] {
    const implementationAgents = (config.agents || []).filter((candidate) => candidate.role === AGENT_ROLES.IMPLEMENTATION);
    const primaryAgent = implementationAgents[0];
    if (!primaryAgent) {
      return [];
    }
    const taskId = `${prd.id}-${primaryAgent.id}-1`;
    const acceptance = this.normalizeStringList(prd.requirements);
    const description = typeof prd.specification === 'string' && prd.specification.trim()
      ? prd.specification.trim()
      : acceptance[0] || `Implement ${prd.title || prd.id}.`;
    return [{
      id: taskId,
      title: `Implement ${prd.title || prd.id}`,
      agentId: primaryAgent.id,
      description,
      laneKey: `${prd.id}:${primaryAgent.id}`,
      sprintId: prd.sprintId || sprint.sprintId || 'shared',
      acceptance: acceptance.length > 0 ? acceptance : this.buildFallbackAcceptance(taskId),
    }];
  }

  private buildTrackedImplementationQueueUpdates(context: AgentExecutionContext, taskSpecs: AnyRecord[], { prd, sprint }: { prd: TrackedPrdRecord; sprint: AnyRecord; }): AnyRecord[] {
    const queues = context.queueStore.loadQueues ? context.queueStore.loadQueues() : {};
    const nextByAgent = new Map<string, AnyRecord>();
    const now = context.clock.now();

    (Array.isArray(taskSpecs) ? taskSpecs : []).forEach((spec) => {
      const agent = (context.config.agents || []).find((candidate) => candidate.id === spec.agentId);
      if (!agent) {
        throw new Error(`Unknown agent "${spec.agentId}".`);
      }
      const baseQueue = nextByAgent.get(agent.id)
        || (context.queueStore.buildQueueState
          ? context.queueStore.buildQueueState(agent, (context.queueStore.listTasks?.(queues[agent.id]) || []).slice())
          : { agentId: agent.id, role: agent.role, tasks: [] });
      const existingIndex = (context.queueStore.listTasks?.(baseQueue as AnyRecord) || []).findIndex((task: TaskRecord) => task.id === spec.id);
      const nextTask = {
        id: spec.id,
        title: spec.title,
        description: spec.description || '',
        agentId: spec.agentId,
        prdId: prd.id || undefined,
        laneKey: spec.laneKey || `${prd.id}:${spec.agentId}`,
        type: spec.type || TASK_TYPES.DEFAULT,
        source: spec.source || 'planned',
        sprintId: spec.sprintId || prd.sprintId || sprint.sprintId || 'shared',
        baseBranch: context.config.integrationBranch,
        checks: this.normalizeStringList(agent.checks || []),
        acceptance: this.normalizeStringList(spec.acceptance),
        state: 'queued',
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      };
      if (!nextTask.prdId) {
        delete nextTask.prdId;
      }
      if (existingIndex >= 0) {
        baseQueue.tasks[existingIndex] = {
          ...baseQueue.tasks[existingIndex],
          ...nextTask,
        };
      } else {
        baseQueue.tasks.push(nextTask);
      }
      nextByAgent.set(agent.id, baseQueue);
    });

    return Array.from(nextByAgent.entries()).map(([agentId, queueState]) => {
      const agent = (context.config.agents || []).find((candidate) => candidate.id === agentId);
      if (!agent) {
        throw new Error(`Unknown agent "${agentId}".`);
      }
      const relativePath = agent.taskQueue;
      if (typeof relativePath !== 'string' || !relativePath.trim()) {
        throw new Error(`Implementation queue for "${agentId}" is missing taskQueue.`);
      }
      if (relativePath.startsWith('/')) {
        throw new Error(`Implementation queue for "${agentId}" must be repo-relative to commit it to ${context.config.integrationBranch}.`);
      }
      return {
        relativePath,
        content: context.queueStore.buildQueueState
          ? context.queueStore.buildQueueState(agent, context.queueStore.listTasks?.(queueState) || [])
          : queueState,
      };
    });
  }

  private finalizePrd(context: AgentExecutionContext, prdId: string, patch: AnyRecord): void {
    const currentState = context.prdStore.readTrackedPrdStateMap
      ? context.prdStore.readTrackedPrdStateMap().get(prdId) || null
      : null;
    const now = context.clock.now();
    const rawError = patch.error || patch.lastError || '';
    context.prdStore.commitPrdState?.({
      prdId,
      status: patch.status || (currentState && currentState.status) || 'planned',
      plannedTaskIds: Array.isArray(patch.plannedTaskIds)
        ? patch.plannedTaskIds
        : (currentState && currentState.plannedTaskIds) || [],
      lastError: patch.status === 'failed'
        ? (typeof rawError === 'string' ? rawError : this.extractErrorMessage(rawError))
        : '',
      createdAt: currentState && currentState.createdAt ? currentState.createdAt : now,
      updatedAt: now,
    }, {
      commitMessage: `autonomy(prd-state): ${patch.status || 'update'} ${prdId}`,
      gitIdentity: context.agent.gitIdentity,
    });
  }

  private extractErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
      const maybeError = error as { stderr?: string; stdout?: string; message?: string; };
      if (typeof maybeError.stderr === 'string' && maybeError.stderr.trim()) {
        return maybeError.stderr.trim();
      }
      if (typeof maybeError.stdout === 'string' && maybeError.stdout.trim()) {
        return maybeError.stdout.trim();
      }
      if (typeof maybeError.message === 'string' && maybeError.message.trim()) {
        return maybeError.message.trim();
      }
    }
    return String(error || 'Command failed without stderr/stdout output.').trim();
  }
}


export { PmAgentDefinition };
