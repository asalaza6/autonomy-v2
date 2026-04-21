import fs from 'fs';
import path from 'path';
import { AGENT_ROLES, getRoleAgentLabel, getRoleLabel, isImplementationRole } from '../agents/role-catalog.js';
import { runCodexExecSync } from './cli.js';
import { normalizeStringList, readOptionalFile } from './codex-shared.js';
import { ensureDir } from '../sync/core.js';
import { buildPrdSpecRelativePath, parsePrdSpec } from '../sync/sync-prd.js';
import { gitRefExists, isGitWorktree, runGit, runGitWorktreeAdd } from '../sync/git-shared.js';

function planPrdTasksWithCodex({ rootDir, agent, config, sprint, prd }) {
  const implementationAgents = (config.agents || []).filter((candidate) => isImplementationRole(candidate.role));
  const laneLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
  const integrationBranch = config.integrationBranch || 'dev';
  const specRelativePath = buildPrdSpecRelativePath(prd.id, {
    queue: prd.isQueued === true,
  });
  const worktreePath = ensurePlanningWorktree(rootDir, integrationBranch, prd.id);
  const prompt = buildPlanningPrompt({
    rootDir,
    agentSystemPromptPath: agent.systemPrompt,
    laneLabel,
    implementationAgents,
    prd,
    sprintId: prd.sprintId || sprint.sprintId || 'shared',
    worktreePath,
    specRelativePath,
  });

  let plannedSpec = null;
  try {
    runCodexExecSync({
      cwd: worktreePath,
      prompt,
      readOnly: false,
    });
    plannedSpec = validatePlannedSpec({
      worktreePath,
      specRelativePath,
      prd,
      implementationAgents,
      fallbackSprintId: prd.sprintId || sprint.sprintId || 'shared',
    });
  } catch (_) {
    plannedSpec = null;
  } finally {
    cleanupPlanningWorktree(rootDir, worktreePath);
  }

  const plannedTasks = plannedSpec && Array.isArray(plannedSpec.tasks) && plannedSpec.tasks.length > 0
    ? plannedSpec.tasks
    : buildFallbackPlannedTaskSpecs(prd, implementationAgents, prd.sprintId || sprint.sprintId || 'shared');

  let normalizedTasks = [];
  try {
    normalizedTasks = validatePlannedTaskSpecs({
      prd,
      tasks: plannedTasks,
      implementationAgents,
      fallbackSprintId: prd.sprintId || sprint.sprintId || 'shared',
    });
  } catch (_) {
    normalizedTasks = [];
  }

  return {
    summary: plannedSpec
      ? `Planned ${normalizedTasks.length} task(s) for ${prd.id}.`
      : `Fallback planned ${normalizedTasks.length} task(s) for ${prd.id}.`,
    tasks: normalizedTasks,
  };
}

function buildPlanningPrompt({
  rootDir,
  agentSystemPromptPath,
  laneLabel,
  implementationAgents,
  prd,
  sprintId,
  worktreePath,
  specRelativePath,
}) {
  return [
    readOptionalFile(rootDir, agentSystemPromptPath),
    `You are planning ${laneLabel} work by editing a PRD spec file directly in this worktree.`,
    '',
    'No structured response is required.',
    '',
    `Worktree path: ${worktreePath}`,
    `Target file: ${specRelativePath}`,
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
        sprintId,
      },
      null,
      2
    ),
    '',
    'Rules:',
    `- Update only \`${specRelativePath}\`. Do not edit queue files, state files, or unrelated repo content.`,
    '- Preserve the existing PRD id, title, createdAt, specification, and requirements.',
    '- Add or refine a tasks array in the PRD spec file.',
    '- Keep tasks atomic, lane-scoped, and assigned only to enabled lane agents.',
    '- Prefer stable ids of the form "<prd-id>-<lane>-<n>".',
    '- Acceptance criteria must be concrete and testable.',
    '',
    'Return nothing. The CLI will read the updated file and continue the process.',
  ].filter(Boolean).join('\n');
}

function validatePlannedSpec({ worktreePath, specRelativePath, prd, implementationAgents, fallbackSprintId }) {
  const absolutePath = path.join(worktreePath, specRelativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Codex did not update ${specRelativePath}.`);
  }
  const raw = fs.readFileSync(absolutePath, 'utf8');
  const parsed = parsePrdSpec(raw, specRelativePath);
  const tasks = validatePlannedTaskSpecs({
    prd,
    tasks: parsed.tasks || [],
    implementationAgents,
    fallbackSprintId,
  });
  return {
    ...parsed,
    tasks,
  };
}

function validatePlannedTaskSpecs({ prd, tasks, implementationAgents, fallbackSprintId }) {
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

function buildFallbackPlannedTaskSpecs(prd, implementationAgents, sprintId) {
  const primaryAgent = (implementationAgents || [])[0];
  if (!primaryAgent) {
    return [];
  }

  const taskId = `${prd.id}-${primaryAgent.id}-1`;
  const acceptance = normalizeStringList(prd.requirements);
  const description = typeof prd.specification === 'string' && prd.specification.trim()
    ? prd.specification.trim()
    : acceptance[0] || `Implement ${prd.title || prd.id}.`;

  return [{
    id: taskId,
    title: `Implement ${prd.title || prd.id}`,
    agentId: primaryAgent.id,
    description,
    laneKey: `${prd.id}:${primaryAgent.id}`,
    sprintId: sprintId || 'shared',
    acceptance: acceptance.length > 0 ? acceptance : buildFallbackAcceptance(taskId),
  }];
}

function buildFallbackAcceptance(taskId) {
  return [`Task \`${taskId}\` is complete within the assigned agent scope.`];
}

function ensurePlanningWorktree(rootDir, integrationBranch, prdId) {
  const baseRef = gitRefExists(rootDir, `origin/${integrationBranch}`)
    ? `origin/${integrationBranch}`
    : integrationBranch;
  const planningRoot = path.join(rootDir, '.autonomy', 'control', `${AGENT_ROLES.PM}-plan`);
  ensureDir(planningRoot);
  const worktreePath = path.join(planningRoot, sanitizePathSegment(prdId));

  if (!fs.existsSync(worktreePath)) {
    runGitWorktreeAdd(rootDir, ['--detach', worktreePath, baseRef], worktreePath);
    return worktreePath;
  }

  if (!isGitWorktree(worktreePath)) {
    throw new Error(`Planning worktree path "${worktreePath}" exists but is not a git worktree.`);
  }

  runGit(worktreePath, ['reset', '--hard', baseRef]);
  runGit(worktreePath, ['clean', '-fd']);
  return worktreePath;
}

function cleanupPlanningWorktree(rootDir, worktreePath) {
  if (!worktreePath) {
    return;
  }

  try {
    if (isGitWorktree(worktreePath)) {
      runGit(rootDir, ['worktree', 'remove', '--force', worktreePath]);
    }
  } catch (_) {
    // Best-effort cleanup only.
  }

  try {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function sanitizePathSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'prd';
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

export {
  buildPlanningPrompt,
  planPrdTasksWithCodex,
};
