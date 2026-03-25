import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES } from './role-catalog.js';

class ImplementationAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.IMPLEMENTATION);
  }

  usesTrackedQueue() {
    return true;
  }

  buildQueueState(agent, tasks = []) {
    return {
      schemaVersion: 1,
      agentId: agent.id,
      role: this.roleId,
      tasks,
    };
  }
}


export { ImplementationAgentDefinition };
export default {
  ImplementationAgentDefinition
};

