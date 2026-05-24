import type {
  ControlPlaneConfig,
  ControlPlaneAgentChatMessagePayload,
  ControlPlaneDeployPayload,
  ControlPlanePackageUpdatePayload,
  ControlPlanePrdAddPayload,
  ControlPlanePrdPriorityPayload,
  ControlPlanePrdResetPayload,
  ControlPlaneRestartPayload,
  ControlPlaneRepoRecord,
} from '../../types.js';
import { randomBytes } from 'crypto';

const DEFAULT_CONTROL_PLANE_CONFIG: ControlPlaneConfig = {
  schemaVersion: 1,
  repoId: 'default',
  label: 'Current workspace',
  description: 'Allowed PRD target for the control plane.',
};

function normalizeControlPlaneConfig(config: Partial<ControlPlaneConfig> = {}): ControlPlaneConfig {
  const repo = normalizeRepoRecord(
    {
      ...DEFAULT_CONTROL_PLANE_CONFIG,
      ...config,
    },
    DEFAULT_CONTROL_PLANE_CONFIG.repoId
  ) || DEFAULT_CONTROL_PLANE_CONFIG;
  return {
    schemaVersion: typeof config.schemaVersion === 'number' ? config.schemaVersion : 1,
    repoId: repo.repoId,
    label: repo.label,
    description: repo.description,
    default: repo.default,
    repoAssistantValidationPullRequest: repo.repoAssistantValidationPullRequest,
    deployCommand: repo.deployCommand,
    packageUpdateCommand: repo.packageUpdateCommand,
    controlBridgeRestartCommand: repo.controlBridgeRestartCommand,
    serverRestartCommand: repo.serverRestartCommand,
    deploymentUrl: repo.deploymentUrl,
    deploymentLabel: repo.deploymentLabel,
    exclusiveControl: repo.exclusiveControl,
    controlTakeover: repo.controlTakeover,
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
  const rawValidationPullRequest = (repo as Record<string, unknown>).repoAssistantValidationPullRequest
    ?? (repo as Record<string, unknown>).validationPullRequestNumber
    ?? null;
  const parsedValidationPullRequest = Number(rawValidationPullRequest);
  return {
    repoId,
    label: String((repo as Record<string, unknown>).label || repoId).trim(),
    description: String((repo as Record<string, unknown>).description || '').trim() || undefined,
    default: (repo as Record<string, unknown>).default === true,
    repoAssistantValidationPullRequest: Number.isInteger(parsedValidationPullRequest) && parsedValidationPullRequest > 0
      ? parsedValidationPullRequest
      : undefined,
    deployCommand: (repo as ControlPlaneRepoRecord).deployCommand,
    packageUpdateCommand: (repo as ControlPlaneRepoRecord).packageUpdateCommand,
    controlBridgeRestartCommand: (repo as ControlPlaneRepoRecord).controlBridgeRestartCommand,
    serverRestartCommand: (repo as ControlPlaneRepoRecord).serverRestartCommand,
    deploymentUrl: String((repo as Record<string, unknown>).deploymentUrl || '').trim() || undefined,
    deploymentLabel: String((repo as Record<string, unknown>).deploymentLabel || '').trim() || undefined,
    exclusiveControl: (repo as Record<string, unknown>).exclusiveControl === true,
    controlTakeover: String((repo as Record<string, unknown>).controlTakeover || '').trim() === 'refuse'
      ? 'refuse'
      : 'takeover',
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
  const title = String(submission.title || '').trim() || generatePrdTitle({
    specification,
    requirements,
    taskSpecs,
  });
  const id = String(submission.id || '').trim() || generatePrdId(title);

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
      priority: String(submission.priority || '').trim() || undefined,
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

function validatePrdResetSubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlanePrdResetPayload> = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
  const confirmPrdId = String(submission.confirmPrdId || '').trim();
  if (!confirmPrdId) {
    throw new Error('Provide confirmPrdId for the active PRD being reset.');
  }
  return {
    repo,
    payload: {
      repoId: repo.repoId,
      confirmPrdId,
      reason: String(submission.reason || '').trim() || undefined,
    },
  };
}

function validatePrdPrioritySubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlanePrdPriorityPayload> = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
  const prdId = String(submission.prdId || (submission as Record<string, unknown>).id || '').trim();
  const priority = String(submission.priority || '').trim();
  if (!prdId) {
    throw new Error('Provide prdId for the queued PRD being reprioritized.');
  }
  if (!priority) {
    throw new Error('Provide priority for the queued PRD.');
  }
  return {
    repo,
    payload: {
      repoId: repo.repoId,
      prdId,
      priority,
      reason: String(submission.reason || '').trim() || undefined,
    },
  };
}

function validatePackageUpdateSubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlanePackageUpdatePayload> = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
  return {
    repo,
    payload: {
      repoId: repo.repoId,
    },
  };
}

function validateRestartSubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlaneRestartPayload> = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
  return {
    repo,
    payload: {
      repoId: repo.repoId,
      controlSessionId: String(submission.controlSessionId || '').trim() || undefined,
      controlSessionLabel: String(submission.controlSessionLabel || '').trim() || undefined,
      takeoverControl: submission.takeoverControl === true,
    },
  };
}

function validateAgentChatSubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlaneAgentChatMessagePayload> & { message?: string; conversationId?: string } = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
  const prompt = String(submission.prompt || submission.message || '').trim();
  if (!prompt) {
    throw new Error('Provide a message for the repo agent.');
  }
  return {
    repo,
    payload: {
      repoId: repo.repoId,
      conversationId: String(submission.conversationId || '').trim() || undefined,
      prompt,
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

function generatePrdTitle(input: {
  specification?: string;
  requirements?: string[];
  taskSpecs?: Array<Record<string, unknown>>;
}) {
  const titleSource = [
    String(input.specification || '').trim(),
    Array.isArray(input.requirements) ? input.requirements.join(' ') : '',
    Array.isArray(input.taskSpecs)
      ? input.taskSpecs
        .map((taskSpec) => String(taskSpec && (taskSpec.title || taskSpec.description) || '').trim())
        .filter(Boolean)
        .join(' ')
      : '',
  ].find((entry) => extractWords(entry).length > 0) || '';
  const words = extractWords(titleSource).slice(0, 10);
  return words.length > 0 ? words.join(' ') : 'Untitled PRD';
}

function generatePrdId(title: string) {
  const words = extractWords(title)
    .slice(0, 4)
    .map((word) => word.toLowerCase());
  const slug = words.length > 0 ? words.join('-') : 'prd';
  const suffix = randomBytes(3).toString('hex');
  return `prd-${slug}-${suffix}`;
}

function extractWords(value: string) {
  return String(value || '')
    .split(/\s+/)
    .map((word) => word.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''))
    .filter(Boolean);
}

export {
  DEFAULT_CONTROL_PLANE_CONFIG,
  assertControlPlaneRepoId,
  normalizeControlPlaneConfig,
  normalizeRepoRecord,
  resolveRepoById,
  validateAgentChatSubmission,
  validateDeploySubmission,
  validatePackageUpdateSubmission,
  validatePrdAddSubmission,
  validatePrdPrioritySubmission,
  validatePrdResetSubmission,
  validateRestartSubmission,
};
