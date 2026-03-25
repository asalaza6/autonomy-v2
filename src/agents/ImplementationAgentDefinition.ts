import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES } from './role-catalog.js';
import type { AgentConfig, QueueState, TaskRecord } from '../types.js';

class ImplementationAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.IMPLEMENTATION);
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
}


export { ImplementationAgentDefinition };
