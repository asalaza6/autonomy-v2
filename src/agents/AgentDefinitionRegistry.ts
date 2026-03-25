import { PmAgentDefinition } from './PmAgentDefinition.js';
import { ImplementationAgentDefinition } from './ImplementationAgentDefinition.js';
import { ReviewAgentDefinition } from './ReviewAgentDefinition.js';
import { listAgentRoleIds, normalizeAgentRole, } from './role-catalog.js';

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


export { getAgentDefinition };
export { listAgentDefinitions };
export default {
  getAgentDefinition,
  listAgentDefinitions
};

