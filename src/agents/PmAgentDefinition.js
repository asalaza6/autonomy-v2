const { AgentDefinition } = require('./AgentDefinition');
const { AGENT_ROLES } = require('./role-catalog');

class PmAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.PM);
  }

  requiresRunner() {
    return false;
  }
}

module.exports = {
  PmAgentDefinition,
};
