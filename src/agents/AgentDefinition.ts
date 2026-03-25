import path from 'path';
import type { AgentConfig, AutonomyConfig, QueueState, TaskRecord } from '../types.js';

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

  validateScaffoldConfig(_agent?: AgentConfig, _sourcePath?: string): void {}

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

  buildSystemPrompt(agent: AgentConfig, _config: AutonomyConfig): string {
    return `# ${this.getDisplayName(agent)} System\n`;
  }

  buildHandoffTemplate(agent: AgentConfig): string {
    return [
      `# ${this.getDisplayName(agent)} Handoff`,
      '',
      '## Current State',
      '',
      '_No active handoff yet._',
      '',
    ].join('\n');
  }

  buildLogTemplate(agent: AgentConfig): string {
    return `# ${this.getDisplayName(agent)} Log\n`;
  }

  getDisplayName(agent?: AgentConfig): string {
    const source = String(agent && (agent.personaName || agent.id) || 'agent').trim();
    if (!source) {
      return 'Agent';
    }

    return source
      .replace(/[-_]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  entranceCriteria(): { ok: boolean; reason: string } {
    return { ok: true, reason: '' };
  }

  exitCriteria(): { status: string; reason: string; sideEffects: any[] } {
    return { status: 'noop', reason: '', sideEffects: [] };
  }

  validateTrackedQueueConfig(agent?: AgentConfig, sourcePath = '', helpers: AgentDefinitionHelpers = {}): void {
    if (!agent || !agent.taskQueue) {
      return;
    }

    const normalizeConfigPath = helpers.normalizeConfigPath || ((value: string) => String(value || '').trim());
    const taskQueue = normalizeConfigPath(agent.taskQueue);
    if (path.posix.isAbsolute(taskQueue)) {
      throw new Error(
        `Invalid autonomy config at ${sourcePath}: ${this.roleId} agent "${agent.id}" must use a repo-relative taskQueue.`
      );
    }
    if (helpers.isRuntimeManagedTaskQueuePath && helpers.isRuntimeManagedTaskQueuePath(taskQueue)) {
      throw new Error(
        `Invalid autonomy config at ${sourcePath}: ${this.roleId} agent "${agent.id}" cannot use runtime-managed taskQueue paths.`
      );
    }
  }
}


export { AgentDefinition };
