import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES } from './role-catalog.js';

class PmAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.PM);
  }

  requiresRunner() {
    return false;
  }
}


export { PmAgentDefinition };
export default {
  PmAgentDefinition
};

