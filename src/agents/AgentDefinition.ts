import type { AgentConfig, QueueState, TaskRecord } from '../types.js';

type AgentDefinitionHelpers = {
  isAbsolutePath?: (value: string) => boolean;
  resolveRepoPath?: (rootDir: string, relativePath: string) => string;
  resolveRuntimePath?: (rootDir: string, relativePath: string) => string;
  normalizeConfigPath?: (value: string) => string;
  isRuntimeManagedTaskQueuePath?: (value: string) => boolean;
  path?: typeof import('path');
};

class AgentDefinition {
  roleId: string;

  constructor(roleId: string) {
    this.roleId = roleId;
  }

  validateConfig(_agent?: AgentConfig, _sourcePath?: string, _helpers?: AgentDefinitionHelpers): void {}

  resolveTaskQueue(rootDir: string, agent: AgentConfig, helpers: AgentDefinitionHelpers): string {
    const relativePath = agent.taskQueue;
    if (!relativePath) {
      throw new Error(`Agent "${agent.id}" is missing required taskQueue in config.`);
    }
    if (helpers.isAbsolutePath && helpers.isAbsolutePath(relativePath)) {
      return relativePath;
    }
    if (this.usesTrackedQueue()) {
      return helpers.resolveRepoPath
        ? helpers.resolveRepoPath(rootDir, relativePath)
        : relativePath;
    }
    return helpers.resolveRuntimePath
      ? helpers.resolveRuntimePath(rootDir, relativePath)
      : relativePath;
  }

  buildQueueState(agent: AgentConfig, tasks: TaskRecord[] = []): QueueState {
    return {
      agentId: agent.id,
      role: this.roleId,
      tasks,
    };
  }

  usesTrackedQueue(): boolean {
    return false;
  }

  requiresRunner(): boolean {
    return true;
  }

  entranceCriteria(): { ok: boolean; reason: string } {
    return { ok: true, reason: '' };
  }

  exitCriteria(): { status: string; reason: string; sideEffects: any[] } {
    return { status: 'noop', reason: '', sideEffects: [] };
  }
}


export { AgentDefinition };
