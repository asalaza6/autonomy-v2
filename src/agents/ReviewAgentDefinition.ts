import path from 'path';
import { AgentDefinition } from './AgentDefinition.js';
import { AGENT_ROLES } from './role-catalog.js';
import type { AgentConfig } from '../types.js';

class ReviewAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.REVIEW);
  }

  usesTrackedQueue(): boolean {
    return true;
  }

  validateConfig(agent?: AgentConfig, sourcePath = '', helpers: any = {}): void {
    if (!agent || !agent.taskQueue) {
      return;
    }
    const taskQueue = helpers.normalizeConfigPath(agent.taskQueue);
    if (path.posix.isAbsolute(taskQueue)) {
      throw new Error(`Invalid autonomy config at ${sourcePath}: ${this.roleId} agent "${agent.id}" must use a repo-relative taskQueue.`);
    }
    if (helpers.isRuntimeManagedTaskQueuePath(taskQueue)) {
      throw new Error(`Invalid autonomy config at ${sourcePath}: ${this.roleId} agent "${agent.id}" cannot use runtime-managed taskQueue paths.`);
    }
  }
}


export { ReviewAgentDefinition };
export default {
  ReviewAgentDefinition
};
