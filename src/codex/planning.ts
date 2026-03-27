import { AGENT_ROLES, getRoleAgentLabel, getRoleLabel, isImplementationRole } from '../agents/role-catalog.js';
import { runCodexStructuredSync } from './cli.js';
import { normalizeStringList, readOptionalFile } from './codex-shared.js';

function planPrdTasksWithCodex({ rootDir, agent, config, sprint, prd }) {
  const implementationAgents = (config.agents || []).filter((candidate) => isImplementationRole(candidate.role));
  const laneLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
  const prompt = [
    readOptionalFile(rootDir, agent.systemPrompt),
    `You are planning ${laneLabel} work for an autonomy-first repository.`,
    '',
    `Available ${laneLabel} lanes:`,
    JSON.stringify(
      implementationAgents.map((candidate) => ({
        id: candidate.id,
        personaName: candidate.personaName || candidate.id,
        include: candidate.include || [],
        exclude: candidate.exclude || [],
      })),
      null,
      2
    ),
    '',
    'Product request to decompose:',
    JSON.stringify(
      {
        id: prd.id,
        title: prd.title,
        specification: prd.specification || '',
        requirements: prd.requirements || [],
        taskHints: prd.tasks || [],
        sprintId: prd.sprintId || sprint.sprintId || 'shared',
      },
      null,
      2
    ),
    '',
    'Rules:',
    `- Create ${laneLabel} tasks only. Do not create reviewer tasks.`,
    '- Keep tasks atomic and lane-scoped.',
    `- Each task must target exactly one ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)}.`,
    '- Scope is defined by the chosen agent include/exclude rules. Do not emit task-level scope fields.',
    '- Prefer stable ids of the form "<prd-id>-<lane>-<n>".',
    '- Acceptance criteria must be concrete and testable.',
    '',
    'Return JSON only.',
  ].filter(Boolean).join('\n');

  const output = runCodexStructuredSync({
    cwd: rootDir,
    prompt,
    readOnly: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['tasks', 'summary'],
      properties: {
        summary: {
          type: 'string',
        },
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'agentId', 'description', 'acceptance', 'sprintId'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              agentId: { type: 'string' },
              description: { type: 'string' },
              acceptance: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
              },
              sprintId: { type: 'string' },
            },
          },
        },
      },
    },
  });

  return {
    summary: String(output.summary || '').trim(),
    tasks: validatePlannedTasks({
      prd,
      tasks: output.tasks || [],
      implementationAgents,
      fallbackSprintId: prd.sprintId || sprint.sprintId || 'shared',
    }),
  };
}

function validatePlannedTasks({ prd, tasks, implementationAgents, fallbackSprintId }) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`Codex did not return any ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} tasks for PRD "${prd.id}".`);
  }

  const agentMap = new Map(implementationAgents.map((agent) => [agent.id, agent]));
  const seenIds = new Set();

  return tasks.map((task, index) => {
    const agentId = String(task.agentId || '').trim();
    const agent = agentMap.get(agentId);
    if (!agent) {
      throw new Error(`Codex returned unsupported ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} "${agentId}".`);
    }

    const id = sanitizeTaskId(task.id || buildGeneratedTaskId(prd.id, agentId, index + 1));
    if (!id) {
      throw new Error(`Codex returned an invalid task id at index ${index}.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Codex returned duplicate task id "${id}".`);
    }
    seenIds.add(id);

    const acceptance = normalizeStringList(task.acceptance);
    if (acceptance.length === 0) {
      throw new Error(`Task "${id}" must include at least one acceptance criterion.`);
    }

    return {
      id,
      title: String(task.title || '').trim() || `Implement ${agentId} work for ${prd.id}`,
      agentId,
      description: String(task.description || '').trim(),
      acceptance,
      sprintId: String(task.sprintId || '').trim() || fallbackSprintId,
    };
  });
}

function sanitizeTaskId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildGeneratedTaskId(prdId, agentId, index) {
  const lane = String(agentId || '').replace(/-agent$/, '');
  return `${prdId}-${lane}-${index}`;
}

export { planPrdTasksWithCodex };
