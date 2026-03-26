import { AGENT_ROLES, getRoleAgentLabel, getRoleLabel } from '../agents/role-catalog.js';
import { runCodexExec, runCodexStructured } from './cli.js';
import { readOptionalFile } from './shared.js';

async function executeTaskWithCodex({ rootDir, agent, task, laneTasks, pr, branch, worktreePath }) {
  const laneLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
  const prompt = [
    readOptionalFile(rootDir, agent.systemPrompt),
    `You are executing a ${laneLabel} lane inside the assigned git worktree.`,
    '',
    'Hard rules:',
    '- Edit only files within the assigned agent scope and current lane work.',
    '- Implement only the primary task in this run. Do not edit files that belong exclusively to later queued lane tasks.',
    '- Do not modify .autonomy/**, prompts/autonomous/**, or git metadata.',
    '- Do not commit, push, merge, or open/update pull requests. The wrapper will handle git and PR state.',
    '- Keep the diff tightly focused on the assigned work.',
    '- You may inspect the repo and run local commands as needed.',
    '',
    'Primary task:',
    JSON.stringify(task, null, 2),
    '',
    'Lane plan context (later queued lane tasks are context only; they must remain untouched in this run):',
    JSON.stringify(laneTasks, null, 2),
    '',
    'Current lane PR context:',
    JSON.stringify(
      pr
        ? {
            id: pr.id,
            title: pr.title,
            body: pr.body,
            baseBranch: pr.baseBranch,
            headBranch: pr.headBranch,
            reviews: pr.reviews || [],
          }
        : null,
      null,
      2
    ),
    '',
    `Current branch: ${branch}`,
    `Worktree path: ${worktreePath}`,
    '',
    'Make the requested changes directly in the worktree. No structured response is required.',
  ].join('\n');

  await runCodexExec({
    cwd: worktreePath,
    prompt,
    readOnly: false,
  });

  return {
    status: 'completed',
    summary: '',
    notes: '',
  };
}

async function reviewPrWithCodex({ rootDir, agent, reviewTask, pr, branch, worktreePath, checkResults, diffFiles, scopeResult }) {
  const laneLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
  const prompt = [
    readOptionalFile(rootDir, agent.systemPrompt),
    `You are reviewing a ${laneLabel} branch for merge into dev.`,
    '',
    'Hard rules:',
    '- Do not edit files.',
    '- Review the current branch checked out in this worktree against the base branch.',
    '- Missing or failing required checks are blocking.',
    '- Focus on regressions, correctness, scope violations, weak verification, and merge safety.',
    `- Treat the PR as lane-scoped: files within the ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} scope are in-scope even if sourceTitle/sourceBody mention only the most recent task.`,
    `- Do not request changes solely because the diff includes earlier completed lane-task files that are still within the ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} scope.`,
    '',
    'Review task:',
    JSON.stringify(reviewTask, null, 2),
    '',
    'Pull request context:',
    JSON.stringify(
      {
        id: pr.id,
        title: pr.title,
        body: pr.body,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        taskIds: pr.taskIds || [],
        completedTaskIds: pr.completedTaskIds || [],
        acceptance: pr.acceptance || [],
        [`${laneLabel}ScopeViolations`]: pr.scopeViolations || [],
        priorReviews: pr.reviews || [],
      },
      null,
      2
    ),
    '',
    'Deterministic check results already run by the wrapper:',
    JSON.stringify(checkResults || [], null, 2),
    '',
    'Deterministic diff files against the base branch:',
    JSON.stringify(diffFiles || [], null, 2),
    '',
    'Deterministic scope evaluation for those diff files:',
    JSON.stringify(scopeResult || { ok: true, violations: [] }, null, 2),
    '',
    `${laneLabel[0].toUpperCase()}${laneLabel.slice(1)}-time scope violations above are advisory context only; judge merge safety from the current diff and current deterministic scope evaluation.`,
    '',
    `Compare against origin/${pr.baseBranch} when available; do not rely on a stale local ${pr.baseBranch} ref.`,
    `Review branch: ${branch}`,
    `Review worktree path: ${worktreePath}`,
    '',
    'Return JSON only.',
  ].join('\n');

  const output = await runCodexStructured({
    cwd: worktreePath,
    prompt,
    readOnly: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision', 'summary', 'concerns'],
      properties: {
        decision: {
          type: 'string',
          enum: ['approved', 'changes_requested'],
        },
        summary: {
          type: 'string',
        },
        concerns: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  });

  const concerns = Array.isArray(output.concerns)
    ? output.concerns.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];

  return {
    decision: output.decision,
    summary: String(output.summary || '').trim(),
    concerns,
  };
}

export { executeTaskWithCodex, reviewPrWithCodex };
