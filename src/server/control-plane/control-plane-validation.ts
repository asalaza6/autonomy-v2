import type { ControlPlaneConfig, ControlPlaneDeployPayload, ControlPlanePrdAddPayload, ControlPlaneRepoRecord } from '../../types.js';

const DEFAULT_CONTROL_PLANE_CONFIG: ControlPlaneConfig = {
  schemaVersion: 1,
  repos: [
    {
      id: 'default',
      label: 'Current workspace',
      description: 'Allowed PRD target for the control plane.',
      default: true,
    },
  ],
};

function normalizeControlPlaneConfig(config: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig {
  const repos = Array.isArray(config.repos) ? config.repos : [];
  const normalizedRepos = repos
    .map(normalizeRepoRecord)
    .filter(Boolean) as ControlPlaneRepoRecord[];
  const dedupedRepos = [];
  const seen = new Set();
  normalizedRepos.forEach((repo) => {
    if (seen.has(repo.id)) {
      return;
    }
    seen.add(repo.id);
    dedupedRepos.push(repo);
  });

  return {
    schemaVersion: typeof config.schemaVersion === 'number' ? config.schemaVersion : 1,
    repos: dedupedRepos.length > 0 ? dedupedRepos : DEFAULT_CONTROL_PLANE_CONFIG.repos,
  };
}

function normalizeRepoRecord(repo: ControlPlaneRepoRecord | Record<string, unknown> | null | undefined) {
  if (!repo) {
    return null;
  }
  const id = String(repo.id || '').trim();
  if (!id) {
    return null;
  }
  return {
    id,
    label: String(repo.label || id).trim(),
    description: String(repo.description || '').trim() || undefined,
    default: repo.default === true,
  };
}

function resolveRepoById(config: ControlPlaneConfig, repoId: string) {
  const normalizedRepoId = String(repoId || '').trim();
  if (!normalizedRepoId) {
    throw new Error('Missing repoId.');
  }
  const repo = (config.repos || []).find((entry) => entry.id === normalizedRepoId);
  if (!repo) {
    throw new Error(`Repo "${normalizedRepoId}" is not enabled for this control plane.`);
  }
  return repo;
}

function validatePrdAddSubmission(config: ControlPlaneConfig, submission: Partial<ControlPlanePrdAddPayload> = {}) {
  const repo = resolveRepoById(config, submission.repoId || '');
  const id = String(submission.id || '').trim();
  const title = String(submission.title || '').trim();
  if (!id) {
    throw new Error('Missing PRD id.');
  }
  if (!title) {
    throw new Error('Missing PRD title.');
  }
  const specification = String(submission.specification || '').trim();
  const requirements = Array.isArray(submission.requirements)
    ? submission.requirements.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  const taskSpecs = Array.isArray(submission.taskSpecs)
    ? submission.taskSpecs.map((taskSpec, index) => normalizeTaskSpec(taskSpec, index))
    : [];
  if (!specification && requirements.length === 0 && taskSpecs.length === 0) {
    throw new Error('Provide a specification, at least one requirement, or at least one task spec.');
  }

  return {
    repo,
    payload: {
      repoId: repo.id,
      id,
      title,
      specification: specification || undefined,
      requirements,
      taskSpecs,
      sprintId: String(submission.sprintId || '').trim() || undefined,
    },
  };
}

function validateDeploySubmission(config: ControlPlaneConfig, submission: Partial<ControlPlaneDeployPayload> = {}) {
  const repo = resolveRepoById(config, submission.repoId || '');
  return {
    repo,
    payload: {
      repoId: repo.id,
    },
  };
}

function normalizeTaskSpec(taskSpec: Record<string, unknown> | null | undefined, index: number) {
  const id = String(taskSpec && taskSpec.id || '').trim();
  const title = String(taskSpec && taskSpec.title || '').trim();
  const agentId = String(taskSpec && taskSpec.agentId || '').trim();
  if (!id || !title || !agentId) {
    throw new Error(`Invalid task spec at index ${index}. Expected id, title, and agentId.`);
  }
  return {
    id,
    title,
    agentId,
    description: String(taskSpec && taskSpec.description || '').trim() || undefined,
    acceptance: Array.isArray(taskSpec && taskSpec.acceptance)
      ? ((taskSpec.acceptance as unknown[]).map((entry) => String(entry || '').trim()).filter(Boolean))
      : undefined,
    sprintId: String(taskSpec && taskSpec.sprintId || '').trim() || undefined,
  };
}

export {
  DEFAULT_CONTROL_PLANE_CONFIG,
  normalizeControlPlaneConfig,
  resolveRepoById,
  validateDeploySubmission,
  validatePrdAddSubmission,
};
