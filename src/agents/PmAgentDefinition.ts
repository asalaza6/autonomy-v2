import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES } from './role-catalog.js';
import type { AgentConfig, AutonomyConfig } from '../types.js';

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
}


export { PmAgentDefinition };
