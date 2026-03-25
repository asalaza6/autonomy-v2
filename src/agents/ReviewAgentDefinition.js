const path = require('path');
const { AgentDefinition } = require('./AgentDefinition');
const { AGENT_ROLES } = require('./role-catalog');

class ReviewAgentDefinition extends AgentDefinition {
  constructor() {
    super(AGENT_ROLES.REVIEW);
  }

  usesTrackedQueue() {
    return true;
  }

  validateConfig(agent, sourcePath, helpers) {
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

module.exports = {
  ReviewAgentDefinition,
};
