import { PmAgentDefinition } from './PmAgentDefinition.js';
import { ImplementationAgentDefinition } from './ImplementationAgentDefinition.js';
import { ReviewAgentDefinition } from './ReviewAgentDefinition.js';
import { listAgentRoleIds, normalizeAgentRole, } from './role-catalog.js';
import type { AnyRecord, AgentConfig } from '../types.js';

const definitions = new Map<string, InstanceType<typeof PmAgentDefinition> | InstanceType<typeof ImplementationAgentDefinition> | InstanceType<typeof ReviewAgentDefinition>>([
  [new PmAgentDefinition().roleId, new PmAgentDefinition()],
  [new ImplementationAgentDefinition().roleId, new ImplementationAgentDefinition()],
  [new ReviewAgentDefinition().roleId, new ReviewAgentDefinition()],
]);

function getAgentDefinition(roleOrAgent: string | AgentConfig | AnyRecord) {
  const roleId = normalizeAgentRole(
    roleOrAgent && typeof roleOrAgent === 'object'
      ? roleOrAgent.role
      : roleOrAgent
  );
  const definition = definitions.get(roleId);
  if (!definition) {
    const unsupportedRole = typeof roleOrAgent === 'object' && roleOrAgent
      ? roleOrAgent.role
      : roleOrAgent;
    throw new Error(`Unsupported agent role "${unsupportedRole}".`);
  }
  return definition;
}

function listAgentDefinitions() {
  return listAgentRoleIds()
    .map((roleId) => definitions.get(roleId))
    .filter(Boolean);
}


export { getAgentDefinition };
export { listAgentDefinitions };
