import path from 'path';
import { usesTrackedQueueForRole, isAgentRole, listAgentRoleIds, normalizeAgentRole, } from '../agents/role-catalog.js';
import type { AgentConfig, AutonomyConfig, GitIdentity } from '../types.js';

const VALID_AGENT_ROLES = new Set<string>(listAgentRoleIds());
const DEFAULT_TASK_QUEUE_DIR = 'prompts/autonomous/v2/queues';

function validateAutonomyConfig(config: AutonomyConfig, sourcePath = 'prompts/autonomous/v2/config/agents.json') {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: expected an object.`);
  }

  if (typeof config.schemaVersion !== 'undefined') {
    requirePositiveInteger(config.schemaVersion, sourcePath, 'schemaVersion');
  }

  if (!Array.isArray(config.agents)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: expected an agents array.`);
  }

  const seenAgentIds = new Set<string>();
  config.agents.forEach((agent, index) => {
    validateAgentConfig(agent, index, sourcePath, seenAgentIds);
  });
  config.agents.forEach((agent) => {
    agent.taskQueue = normalizeNonEmptyString(agent.taskQueue) || buildDefaultTaskQueuePath(agent.id);
    validateResolvedTaskQueue(agent, sourcePath);
  });

  if (Array.isArray(config.mergeActors)) {
    const knownIds = new Set(config.agents.map((agent) => agent.id));
    const unknownMergeActors = config.mergeActors
      .map((actor) => String(actor || '').trim())
      .filter(Boolean)
      .filter((actorId) => !knownIds.has(actorId));
    if (unknownMergeActors.length > 0) {
      throw new Error(
        `Invalid autonomy config at ${sourcePath}: mergeActors reference unknown agent id(s): ${unknownMergeActors.join(', ')}.`
      );
    }
  }

  return config;
}

function validateAgentConfig(agent: AgentConfig, index: number, sourcePath: string, seenAgentIds: Set<string>) {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agents[${index}] must be an object.`);
  }

  const agentId = String(agent.id || '').trim();
  if (!agentId) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agents[${index}].id is required.`);
  }
  if (seenAgentIds.has(agentId)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: duplicate agent id "${agentId}".`);
  }
  seenAgentIds.add(agentId);

  const rawRole = String(agent.role || '').trim();
  if (!rawRole) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agents["${agentId}"].role is required.`);
  }
  if (!isAgentRole(rawRole) || !VALID_AGENT_ROLES.has(rawRole)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: unsupported role "${rawRole}" for agent "${agentId}".`);
  }
  const role = normalizeAgentRole(rawRole);
  agent.role = role;

  requireNonEmptyString(agent.systemPrompt, sourcePath, agentId, 'systemPrompt');
  requireGitIdentity(agent.gitIdentity, sourcePath, agentId);
  agent.taskQueue = normalizeNonEmptyString(agent.taskQueue);
  validateResolvedTaskQueue(agent, sourcePath);
}

function validateResolvedTaskQueue(agent: AgentConfig, sourcePath: string) {
  if (!agent || !agent.taskQueue) {
    return;
  }
  if (!usesTrackedQueueForRole(agent.role)) return;
  const taskQueue = normalizeConfigPath(agent.taskQueue);
  if (path.posix.isAbsolute(taskQueue)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: ${agent.role} agent "${agent.id}" must use a repo-relative taskQueue.`);
  }
  if (isRuntimeManagedTaskQueuePath(taskQueue)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: ${agent.role} agent "${agent.id}" cannot use runtime-managed taskQueue paths.`);
  }
}

function buildDefaultTaskQueuePath(agentId: string) {
  return joinConfigPath(DEFAULT_TASK_QUEUE_DIR, `${agentId}.json`);
}

function joinConfigPath(dirPath: string, basename: string) {
  if (!dirPath || dirPath === '.') {
    return basename;
  }
  return `${trimTrailingSlashes(dirPath)}/${basename}`;
}


function normalizeConfigPath(value: string) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function isRuntimeManagedTaskQueuePath(value: string) {
  const normalized = normalizeConfigPath(value);
  return normalized === 'state'
    || normalized.startsWith('state/')
    || normalized === 'prompts/autonomous/v2/state'
    || normalized.startsWith('prompts/autonomous/v2/state/');
}

function trimTrailingSlashes(value: string) {
  return String(value || '').replace(/\/+$/g, '');
}

function normalizeNonEmptyString(value: unknown) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function requireNonEmptyString(value: unknown, sourcePath: string, agentId: string, fieldName: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agent "${agentId}" is missing ${fieldName}.`);
  }
}

function requireGitIdentity(value: GitIdentity, sourcePath: string, agentId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agent "${agentId}" must define gitIdentity.`);
  }
  requireNonEmptyString(value.name, sourcePath, agentId, 'gitIdentity.name');
  requireNonEmptyString(value.email, sourcePath, agentId, 'gitIdentity.email');
}

function requirePositiveInteger(value: number, sourcePath: string, fieldName: string) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: ${fieldName} must be a positive integer.`);
  }
}




export { validateAutonomyConfig };
