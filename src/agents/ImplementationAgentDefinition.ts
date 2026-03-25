import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES, getRoleLabel } from './role-catalog.js';
import type { AgentConfig, AutonomyConfig, QueueState, TaskRecord } from '../types.js';

class ImplementationAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.IMPLEMENTATION);
  }

  validateConfig(agent?: AgentConfig, sourcePath = '', helpers: any = {}): void {
    this.validateTrackedQueueConfig(agent, sourcePath, helpers);
  }

  validateScaffoldConfig(agent?: AgentConfig, sourcePath = ''): void {
    const checks = Array.isArray(agent && agent.checks) ? agent.checks : [];
    if (checks.length === 0 || checks.some((check) => String(check || '').trim().length === 0)) {
      throw new Error(
        `Invalid autonomy config at ${sourcePath}: feature agent "${agent && agent.id || '(unknown)'}" must define a non-empty checks array.`
      );
    }
  }

  usesTrackedQueue(): boolean {
    return true;
  }

  buildQueueState(agent: AgentConfig, tasks: TaskRecord[] = []): QueueState {
    return {
      schemaVersion: 1,
      agentId: agent.id,
      role: this.roleId,
      tasks,
    };
  }

  buildSystemPrompt(agent: AgentConfig, config: AutonomyConfig): string {
    const agentLabel = this.getDisplayName(agent);
    const integrationBranch = config.integrationBranch || 'dev';
    const productionBranch = config.productionBranch || 'main';
    const projectName = config.projectName || 'this repository';
    const roleLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
    const scopeLines = Array.isArray(agent.include) && agent.include.length > 0
      ? agent.include.map((pattern) => `- Stay inside \`${pattern}\` unless the task explicitly expands scope.`)
      : ['- Stay inside your assigned scope.'];
    const checkLines = Array.isArray(agent.checks) && agent.checks.length > 0
      ? agent.checks.map((check) => `- ${check}`)
      : ['- Run the checks configured for your lane before publishing.'];
    const gateLabel = getRoleLabel(AGENT_ROLES.REVIEW);

    return [
      `# ${agentLabel} System`,
      '',
      `You are the ${agentLabel} ${roleLabel} agent for ${projectName}.`,
      '',
      '## Role',
      '',
      '- Implement only tasks assigned to you.',
      `- Work only from task branches based on \`${integrationBranch}\`.`,
      `- Open or update pull requests targeting \`${integrationBranch}\`.`,
      '',
      '## Hard Rules',
      '',
      '- Edit only files within your configured agent scope.',
      ...scopeLines,
      `- Do not merge to \`${productionBranch}\` or \`master\`.`,
      `- Do not merge directly to \`${integrationBranch}\`; publish changes for ${gateLabel}.`,
      '',
      '## Required Checks',
      '',
      ...checkLines,
      '',
      '## Required Workflow',
      '',
      '1. Read your current tracked queue task and acceptance criteria.',
      '2. Work inside the assigned worktree and branch.',
      '3. Run required checks before publishing.',
      '4. Keep the diff focused on your lane.',
      `5. Update the PR when ${gateLabel} asks for changes.`,
      '',
    ].join('\n');
  }
}


export { ImplementationAgentDefinition };
