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

const RUNNER_TYPES = Object.freeze({
  DEFAULT: AGENT_ROLES.IMPLEMENTATION,
  REVIEW: AGENT_ROLES.REVIEW,
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

function requiresRunnerForRole(value) {
  return !isPmRole(value);
}

function getTaskTypeForRole(value) {
  return isReviewRole(value)
    ? TASK_TYPES.REVIEW
    : TASK_TYPES.DEFAULT;
}

function getRunnerTypeForRole(value) {
  return isReviewRole(value)
    ? RUNNER_TYPES.REVIEW
    : RUNNER_TYPES.DEFAULT;
}

function getRoleLabel(value) {
  return normalizeAgentRole(value);
}

function getRoleAgentLabel(value) {
  return `${getRoleLabel(value)} agent`;
}

function buildRoleScopedLabel(value, suffix) {
  return `${getRoleLabel(value)} ${suffix}`;
}

function buildRoleEventName(value, suffix) {
  return `${normalizeAgentRole(value)}:${suffix}`;
}

module.exports = {
  AGENT_ROLES,
  RUNNER_TYPES,
  ROLE_IDS,
  TASK_TYPES,
  buildRoleEventName,
  buildRoleScopedLabel,
  getRunnerTypeForRole,
  getRoleAgentLabel,
  getRoleLabel,
  getTaskTypeForRole,
  isAgentRole,
  isImplementationRole,
  isPmRole,
  isReviewRole,
  listAgentRoleIds,
  normalizeAgentRole,
  requiresRunnerForRole,
  usesTrackedQueueForRole,
};
