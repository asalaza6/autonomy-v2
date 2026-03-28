import { getAgentDefinition } from '../../agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES } from '../../agents/role-catalog.js';
import { planPrdTasksWithCodex } from '../../codex/codex-main.js';
import { extractExecError } from './orchestrator-git.js';
import { createWorkerAgentExecutionContext } from './orchestrator-agent-context.js';
import { getAgent } from './helpers.js';
import { appendAgentLog, loadConfig } from './orchestrator-state.js';

function runWorkerOnce(rootDir, agentId) {
  const { config, sprint } = loadConfig(rootDir);
  const agent = getAgent(config, agentId);
  const definition = getAgentDefinition(agent);
  const context = createWorkerAgentExecutionContext(rootDir, config, sprint, agent, {
    appendAgentLog,
    planPrdTasksWithCodex,
  });
  const claimedWork = definition.claimWork(context);
  if (!claimedWork) {
    return {
      ok: true,
      status: 'noop',
      reason: getNoopReason(agent.role),
    };
  }

  try {
    const result = definition.execute(context, claimedWork);
    if (result && typeof result === 'object' && typeof result.then === 'function') {
      throw new Error(`Role "${agent.role}" must execute synchronously in worker phase.`);
    }
    return result;
  } catch (error) {
    appendAgentLog(rootDir, config, agent.id, 'worker:error', {
      input: {
        role: agent.role,
      },
      output: {
        message: extractExecError(error),
      },
    });
    throw error;
  }
}

function getNoopReason(role) {
  if (role === AGENT_ROLES.PM) {
    return 'no_queued_prd';
  }
  if (role === AGENT_ROLES.REVIEW) {
    return 'no_queued_review';
  }
  if (role === AGENT_ROLES.IMPLEMENTATION) {
    return 'no_queued_task';
  }
  return 'unsupported';
}

export { runWorkerOnce };
