import path from 'path';
import { getAgentDefinition } from '../agents/AgentDefinitionRegistry.js';
import { isAgentRole, listAgentRoleIds, normalizeAgentRole, } from '../agents/role-catalog.js';

const VALID_AGENT_ROLES = new Set(listAgentRoleIds());
const DEFAULT_TASK_QUEUE_DIR = 'prompts/autonomous/v2/queues';

function validateAutonomyConfig(config, sourcePath = 'prompts/autonomous/v2/config/agents.json') {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: expected an object.`);
  }

  if (typeof config.schemaVersion !== 'undefined') {
    requirePositiveInteger(config.schemaVersion, sourcePath, 'schemaVersion');
  }

  if (!Array.isArray(config.agents)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: expected an agents array.`);
  }

  const seenAgentIds = new Set();
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

function validateAgentConfig(agent, index, sourcePath, seenAgentIds) {
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

function validateResolvedTaskQueue(agent, sourcePath) {
  if (!agent || !agent.taskQueue) {
    return;
  }
  getAgentDefinition(agent).validateConfig(agent, sourcePath, {
    isRuntimeManagedTaskQueuePath,
    normalizeConfigPath,
    path,
  });
}

function buildDefaultTaskQueuePath(agentId) {
  return joinConfigPath(DEFAULT_TASK_QUEUE_DIR, `${agentId}.json`);
}

function joinConfigPath(dirPath, basename) {
  if (!dirPath || dirPath === '.') {
    return basename;
  }
  return `${trimTrailingSlashes(dirPath)}/${basename}`;
}

function normalizeTaskQueueDir(dirPath) {
  const normalized = trimTrailingSlashes(normalizeConfigPath(dirPath));
  return normalized || DEFAULT_TASK_QUEUE_DIR;
}

function normalizeConfigPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function isRuntimeManagedTaskQueuePath(value) {
  const normalized = normalizeConfigPath(value);
  return normalized === 'state'
    || normalized.startsWith('state/')
    || normalized === 'prompts/autonomous/v2/state'
    || normalized.startsWith('prompts/autonomous/v2/state/');
}

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/g, '');
}

function normalizeNonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function requireNonEmptyString(value, sourcePath, agentId, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agent "${agentId}" is missing ${fieldName}.`);
  }
}

function requireGitIdentity(value, sourcePath, agentId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agent "${agentId}" must define gitIdentity.`);
  }
  requireNonEmptyString(value.name, sourcePath, agentId, 'gitIdentity.name');
  requireNonEmptyString(value.email, sourcePath, agentId, 'gitIdentity.email');
}

function requirePositiveInteger(value, sourcePath, fieldName) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: ${fieldName} must be a positive integer.`);
  }
}


export { VALID_AGENT_ROLES };
export { buildDefaultTaskQueuePath };
export { validateAutonomyConfig };
export default {
  VALID_AGENT_ROLES,
  buildDefaultTaskQueuePath,
  validateAutonomyConfig
};

