const { PmAgentDefinition } = require('./PmAgentDefinition');
const { ImplementationAgentDefinition } = require('./ImplementationAgentDefinition');
const { ReviewAgentDefinition } = require('./ReviewAgentDefinition');
const {
  listAgentRoleIds,
  normalizeAgentRole,
} = require('./role-catalog');

const definitions = new Map([
  [new PmAgentDefinition().roleId, new PmAgentDefinition()],
  [new ImplementationAgentDefinition().roleId, new ImplementationAgentDefinition()],
  [new ReviewAgentDefinition().roleId, new ReviewAgentDefinition()],
]);

function getAgentDefinition(roleOrAgent) {
  const roleId = normalizeAgentRole(
    roleOrAgent && typeof roleOrAgent === 'object'
      ? roleOrAgent.role
      : roleOrAgent
  );
  const definition = definitions.get(roleId);
  if (!definition) {
    throw new Error(`Unsupported agent role "${roleOrAgent && roleOrAgent.role ? roleOrAgent.role : roleOrAgent}".`);
  }
  return definition;
}

function listAgentDefinitions() {
  return listAgentRoleIds().map((roleId) => definitions.get(roleId));
}

module.exports = {
  getAgentDefinition,
  listAgentDefinitions,
};
