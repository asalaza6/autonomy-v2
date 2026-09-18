const ROLE_PM = 'pm';
const ROLE_IMPLEMENTATION = 'implementation';
const ROLE_REVIEW = 'review';

const AGENT_ROLES = Object.freeze({
  PM: ROLE_PM,
  IMPLEMENTATION: ROLE_IMPLEMENTATION,
  REVIEW: ROLE_REVIEW,
});

const ROLE_IDS = Object.freeze([
  AGENT_ROLES.PM,
  AGENT_ROLES.IMPLEMENTATION,
  AGENT_ROLES.REVIEW,
]);

const TASK_TYPES = Object.freeze({
  DEFAULT: AGENT_ROLES.IMPLEMENTATION,
  REVIEW: AGENT_ROLES.REVIEW,
  FOLLOWUP: 'review_followup',
  CONFLICT: 'conflict-resolution',
});

function listAgentRoleIds() {
  return ROLE_IDS.slice();
}

function normalizeAgentRole(value) {
  const normalized = String(value || '').trim();
  return ROLE_IDS.find((roleId) => roleId === normalized) || '';
}

function isAgentRole(value) {
  return normalizeAgentRole(value).length > 0;
}

function isPmRole(value) {
  return normalizeAgentRole(value) === AGENT_ROLES.PM;
}

function isImplementationRole(value) {
  return normalizeAgentRole(value) === AGENT_ROLES.IMPLEMENTATION;
}

function isReviewRole(value) {
  return normalizeAgentRole(value) === AGENT_ROLES.REVIEW;
}

function usesTrackedQueueForRole(value) {
  return isImplementationRole(value) || isReviewRole(value);
}

function getRoleLabel(value) {
  return normalizeAgentRole(value);
}

function getRoleAgentLabel(value) {
  return `${getRoleLabel(value)} agent`;
}

function buildRoleEventName(value, suffix) {
  return `${normalizeAgentRole(value)}:${suffix}`;
}

export { AGENT_ROLES };

export { TASK_TYPES };
export { buildRoleEventName };

export { getRoleAgentLabel };
export { getRoleLabel };

export { isAgentRole };
export { isImplementationRole };
export { isPmRole };
export { isReviewRole };
export { listAgentRoleIds };
export { normalizeAgentRole };

export { usesTrackedQueueForRole };
