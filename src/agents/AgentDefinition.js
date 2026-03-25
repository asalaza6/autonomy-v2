class AgentDefinition {
  constructor(roleId) {
    this.roleId = roleId;
  }

  validateConfig() {}

  resolveTaskQueue(rootDir, agent, helpers) {
    const relativePath = agent.taskQueue;
    if (!relativePath) {
      throw new Error(`Agent "${agent.id}" is missing required taskQueue in config.`);
    }
    if (helpers.isAbsolutePath(relativePath)) {
      return relativePath;
    }
    if (this.usesTrackedQueue()) {
      return helpers.resolveRepoPath(rootDir, relativePath);
    }
    return helpers.resolveRuntimePath(rootDir, relativePath);
  }

  buildQueueState(agent, tasks = []) {
    return {
      agentId: agent.id,
      role: this.roleId,
      tasks,
    };
  }

  usesTrackedQueue() {
    return false;
  }

  requiresRunner() {
    return true;
  }

  entranceCriteria() {
    return { ok: true, reason: '' };
  }

  exitCriteria() {
    return { status: 'noop', reason: '', sideEffects: [] };
  }
}

module.exports = {
  AgentDefinition,
};
