const VALID_AGENT_ROLES = new Set(['pm', 'implementation', 'review']);

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

  const role = String(agent.role || '').trim();
  if (!role) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agents["${agentId}"].role is required.`);
  }
  if (!VALID_AGENT_ROLES.has(role)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: unsupported role "${role}" for agent "${agentId}".`);
  }

  requireNonEmptyString(agent.systemPrompt, sourcePath, agentId, 'systemPrompt');
  requireGitIdentity(agent.gitIdentity, sourcePath, agentId);

  if (role !== 'pm') {
    requireRunnerCommand(agent.runnerCommand, sourcePath, agentId);
  }
  requireNonEmptyString(agent.taskQueue, sourcePath, agentId, 'taskQueue');
}

function requireNonEmptyString(value, sourcePath, agentId, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agent "${agentId}" is missing ${fieldName}.`);
  }
}

function requireRunnerCommand(value, sourcePath, agentId) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => String(entry || '').trim().length === 0)) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: agent "${agentId}" must define a runnerCommand array.`);
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

module.exports = {
  VALID_AGENT_ROLES,
  validateAutonomyConfig,
};
