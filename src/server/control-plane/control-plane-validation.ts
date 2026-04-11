import type {
  ControlPlaneConfig,
  ControlPlaneDeployPayload,
  ControlPlanePrdAddPayload,
  ControlPlaneRepoRecord,
} from '../../types.js';

const DEFAULT_CONTROL_PLANE_CONFIG: ControlPlaneConfig = {
  schemaVersion: 1,
  repoId: 'default',
  label: 'Current workspace',
  description: 'Allowed PRD target for the control plane.',
};

function normalizeControlPlaneConfig(config: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig {
  const repo = normalizeRepoRecord(config, DEFAULT_CONTROL_PLANE_CONFIG.repoId) || DEFAULT_CONTROL_PLANE_CONFIG;
  return {
    schemaVersion: typeof config.schemaVersion === 'number' ? config.schemaVersion : 1,
    repoId: repo.repoId,
    label: repo.label,
    description: repo.description,
    default: repo.default,
    deploymentUrl: repo.deploymentUrl,
    deploymentLabel: repo.deploymentLabel,
  };
}

function normalizeRepoRecord(
  repo: ControlPlaneRepoRecord | Record<string, unknown> | null | undefined,
  fallbackRepoId = ''
) {
  if (!repo) {
    return fallbackRepoId ? { repoId: fallbackRepoId } as ControlPlaneRepoRecord : null;
  }
  const repoId = String((repo as Record<string, unknown>).repoId || (repo as Record<string, unknown>).id || fallbackRepoId || '').trim();
  if (!repoId) {
    return null;
  }
  return {
    repoId,
    label: String((repo as Record<string, unknown>).label || repoId).trim(),
    description: String((repo as Record<string, unknown>).description || '').trim() || undefined,
    default: (repo as Record<string, unknown>).default === true,
    deploymentUrl: String((repo as Record<string, unknown>).deploymentUrl || '').trim() || undefined,
    deploymentLabel: String((repo as Record<string, unknown>).deploymentLabel || '').trim() || undefined,
  } as ControlPlaneRepoRecord;
}

function resolveRepoById(repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>, repoId: string) {
  const normalizedRepoId = String(repoId || '').trim();
  if (!normalizedRepoId) {
    throw new Error('Missing repoId.');
  }

  const repoList = Array.isArray(repos)
    ? repos
    : Object.values(repos || {});
  const repo = repoList
    .map((entry) => normalizeRepoRecord(entry))
    .find((entry) => entry && entry.repoId === normalizedRepoId);
  if (!repo) {
    throw new Error(`Repo "${normalizedRepoId}" is not registered with this control plane.`);
  }
  return repo;
}

function validatePrdAddSubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlanePrdAddPayload> = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
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
      repoId: repo.repoId,
      id,
      title,
      specification: specification || undefined,
      requirements,
      taskSpecs,
      sprintId: String(submission.sprintId || '').trim() || undefined,
    },
  };
}

function validateDeploySubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlaneDeployPayload> = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
  return {
    repo,
    payload: {
      repoId: repo.repoId,
    },
  };
}

function assertControlPlaneRepoId(config: Partial<ControlPlaneConfig> | null | undefined) {
  const repoId = String(config && config.repoId || '').trim();
  if (!repoId) {
    throw new Error('Missing required control-plane repoId.');
  }
  return repoId;
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
  assertControlPlaneRepoId,
  normalizeControlPlaneConfig,
  normalizeRepoRecord,
  resolveRepoById,
  validateDeploySubmission,
  validatePrdAddSubmission,
};
