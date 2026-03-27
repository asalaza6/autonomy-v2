import { AGENT_ROLES, TASK_TYPES, buildRoleEventName, getRoleAgentLabel, getRoleLabel } from '../../agents/role-catalog.js';
import { hasGithubAuth, resolveGithubAuthToken } from '../../github/github-main.js';
import { executeTaskWithCodex, reviewPrWithCodex } from '../../codex/codex-main.js';

export const crossLayerRunnerDependencies = {
  AGENT_ROLES,
  TASK_TYPES,
  buildRoleEventName,
  getRoleAgentLabel,
  getRoleLabel,
  hasGithubAuth,
  resolveGithubAuthToken,
  executeTaskWithCodex,
  reviewPrWithCodex,
};
