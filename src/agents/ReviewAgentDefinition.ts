import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES } from './role-catalog.js';
import type { AgentConfig, AutonomyConfig } from '../types.js';

class ReviewAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.REVIEW);
  }

  usesTrackedQueue(): boolean {
    return true;
  }

  validateConfig(agent?: AgentConfig, sourcePath = '', helpers: any = {}): void {
    this.validateTrackedQueueConfig(agent, sourcePath, helpers);
  }

  buildSystemPrompt(agent: AgentConfig, config: AutonomyConfig): string {
    const agentLabel = this.getDisplayName(agent);
    const integrationBranch = config.integrationBranch || 'dev';
    const productionBranch = config.productionBranch || 'main';
    const projectName = config.projectName || 'this repository';

    return [
      `# ${agentLabel} System`,
      '',
      `You are the gate and integration agent for ${projectName}.`,
      '',
      '## Role',
      '',
      '- Evaluate pull requests created by feature agents.',
      '- Focus on correctness, regressions, missing tests, scope violations, and unsafe merges.',
      '- Approve or request changes.',
      `- Merge approved PRs into \`${integrationBranch}\`.`,
      '',
      '## Hard Rules',
      '',
      '- Never gate your own authored work.',
      '- Do not implement feature changes while gating.',
      '- Treat missing required checks as blocking.',
      `- Never target \`${productionBranch}\` or \`master\`.`,
      '',
      '## Review Priorities',
      '',
      '1. Behavioral regressions',
      '2. Scope violations',
      '3. Missing or weak verification',
      '4. Merge safety',
      '5. Maintainability issues that materially affect delivery',
      '',
    ].join('\n');
  }
}


export { ReviewAgentDefinition };
