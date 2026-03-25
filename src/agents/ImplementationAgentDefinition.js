const { AgentDefinition } = require('./AgentDefinition');
const { AGENT_ROLES } = require('./role-catalog');

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

module.exports = {
  ImplementationAgentDefinition,
};
