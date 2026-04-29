import type {
  ControlPlaneConfig,
  ControlPlaneAgentChatMessagePayload,
  ControlPlaneDeployPayload,
  ControlPlanePackageUpdatePayload,
  ControlPlanePrdAddPayload,
  ControlPlanePrdResetPayload,
  ControlPlaneRestartPayload,
  ControlPlaneRepoRecord,
  ControlPlaneServiceAuthPayload,
  ControlPlaneServiceConnectionRecord,
  ControlPlaneServiceDeploySelection,
  ControlPlaneServiceProviderRecord,
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
    githubRepository: repo.githubRepository,
    repoAssistantValidationPullRequest: repo.repoAssistantValidationPullRequest,
    deployCommand: repo.deployCommand,
    packageUpdateCommand: repo.packageUpdateCommand,
    controlBridgeRestartCommand: repo.controlBridgeRestartCommand,
    serverRestartCommand: repo.serverRestartCommand,
    restartLaunchMode: repo.restartLaunchMode,
    restartLaunchFallbackToDetached: repo.restartLaunchFallbackToDetached,
    deploymentUrl: repo.deploymentUrl,
    deploymentLabel: repo.deploymentLabel,
    exclusiveControl: repo.exclusiveControl,
    controlTakeover: repo.controlTakeover,
    serviceProviders: repo.serviceProviders,
    serviceConnections: repo.serviceConnections,
    providerDeploy: repo.providerDeploy,
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
    githubRepository: String((repo as Record<string, unknown>).githubRepository || '').trim() || undefined,
    repoAssistantValidationPullRequest: Number.isInteger(parsedValidationPullRequest) && parsedValidationPullRequest > 0
      ? parsedValidationPullRequest
      : undefined,
    deployCommand: (repo as ControlPlaneRepoRecord).deployCommand,
    packageUpdateCommand: (repo as ControlPlaneRepoRecord).packageUpdateCommand,
    controlBridgeRestartCommand: (repo as ControlPlaneRepoRecord).controlBridgeRestartCommand,
    serverRestartCommand: (repo as ControlPlaneRepoRecord).serverRestartCommand,
    restartLaunchMode: String((repo as Record<string, unknown>).restartLaunchMode || '').trim() === 'detached'
      ? 'detached'
      : 'visible-terminal',
    restartLaunchFallbackToDetached: (repo as Record<string, unknown>).restartLaunchFallbackToDetached === true,
    deploymentUrl: String((repo as Record<string, unknown>).deploymentUrl || '').trim() || undefined,
    deploymentLabel: String((repo as Record<string, unknown>).deploymentLabel || '').trim() || undefined,
    exclusiveControl: (repo as Record<string, unknown>).exclusiveControl === true,
    controlTakeover: String((repo as Record<string, unknown>).controlTakeover || '').trim() === 'refuse'
      ? 'refuse'
      : 'takeover',
    serviceProviders: normalizeServiceProviders((repo as Record<string, unknown>).serviceProviders),
    serviceConnections: normalizeServiceConnections((repo as Record<string, unknown>).serviceConnections),
    providerDeploy: normalizeDeploySelection((repo as Record<string, unknown>).providerDeploy),
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
    },
  };
}

function validateDeploySubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlaneDeployPayload> = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
  const providerId = String(submission.providerId || '').trim() || undefined;
  const connectionId = String(submission.connectionId || '').trim() || undefined;
  if ((providerId && !connectionId) || (!providerId && connectionId)) {
    throw new Error('Provide both providerId and connectionId when selecting a provider-backed deploy.');
  }
  return {
    repo,
    payload: {
      repoId: repo.repoId,
      providerId,
      connectionId,
    },
  };
}

function validateServiceAuthSubmission(
  repos: ControlPlaneRepoRecord[] | Record<string, ControlPlaneRepoRecord>,
  submission: Partial<ControlPlaneServiceAuthPayload> = {}
) {
  const repo = resolveRepoById(repos, submission.repoId || '');
  const providerId = String(submission.providerId || '').trim();
  const connectionId = String(submission.connectionId || '').trim();
  if (!providerId) {
    throw new Error('Provide providerId for the service connection.');
  }
  if (!connectionId) {
    throw new Error('Provide connectionId for the service connection.');
  }
  return {
    repo,
    payload: {
      repoId: repo.repoId,
      providerId,
      connectionId,
      authStrategy: String(submission.authStrategy || '').trim() || undefined,
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

function normalizeServiceProviders(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.map((provider) => normalizeServiceProvider(provider)).filter(Boolean) as ControlPlaneServiceProviderRecord[];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeServiceProvider(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const providerId = String((value as Record<string, unknown>).providerId || '').trim();
  if (!providerId) {
    return null;
  }
  return {
    providerId,
    label: String((value as Record<string, unknown>).label || providerId).trim(),
    authStrategies: normalizeStringList((value as Record<string, unknown>).authStrategies),
    authFields: normalizeServiceFields((value as Record<string, unknown>).authFields),
    requiredScopes: normalizeStringList((value as Record<string, unknown>).requiredScopes),
    verifyCommand: normalizeServiceCommand((value as Record<string, unknown>).verifyCommand),
    preflightCommand: normalizeServiceCommand((value as Record<string, unknown>).preflightCommand),
    deployCommand: normalizeServiceCommand((value as Record<string, unknown>).deployCommand),
    postDeployMetadataCommand: normalizeServiceCommand((value as Record<string, unknown>).postDeployMetadataCommand),
    capabilityMetadata: normalizeFlatMetadata((value as Record<string, unknown>).capabilityMetadata),
  } satisfies ControlPlaneServiceProviderRecord;
}

function normalizeServiceConnections(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.map((connection) => normalizeServiceConnection(connection)).filter(Boolean) as ControlPlaneServiceConnectionRecord[];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeServiceConnection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const providerId = String((value as Record<string, unknown>).providerId || '').trim();
  const connectionId = String((value as Record<string, unknown>).connectionId || '').trim();
  const authStrategy = String((value as Record<string, unknown>).authStrategy || '').trim();
  if (!providerId || !connectionId || !authStrategy) {
    return null;
  }
  return {
    providerId,
    connectionId,
    label: String((value as Record<string, unknown>).label || connectionId).trim() || undefined,
    authStrategy,
    envAliases: normalizeStringMap((value as Record<string, unknown>).envAliases),
    accountMetadata: normalizeFlatMetadata((value as Record<string, unknown>).accountMetadata),
    capabilityMetadata: normalizeFlatMetadata((value as Record<string, unknown>).capabilityMetadata),
  } satisfies ControlPlaneServiceConnectionRecord;
}

function normalizeServiceFields(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const field = String((entry as Record<string, unknown>).field || '').trim();
      if (!field) {
        return null;
      }
      return {
        field,
        label: String((entry as Record<string, unknown>).label || field).trim() || undefined,
        description: String((entry as Record<string, unknown>).description || '').trim() || undefined,
        required: (entry as Record<string, unknown>).required !== false,
        secret: (entry as Record<string, unknown>).secret !== false,
      };
    })
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.map((entry) => String(entry || '').trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeStringMap(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const normalized = Object.entries(value as Record<string, unknown>).reduce((record, [key, entry]) => {
    const normalizedKey = String(key || '').trim();
    const normalizedValue = String(entry || '').trim();
    if (!normalizedKey || !normalizedValue) {
      return record;
    }
    record[normalizedKey] = normalizedValue;
    return record;
  }, {} as Record<string, string>);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeFlatMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const normalized = Object.entries(value as Record<string, unknown>).reduce((record, [key, entry]) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      return record;
    }
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      record[normalizedKey] = entry;
      return record;
    }
    if (entry === null) {
      record[normalizedKey] = null;
    }
    return record;
  }, {} as Record<string, string | number | boolean | null>);
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeServiceCommand(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const command = (value as Record<string, unknown>).command;
  if (typeof command === 'undefined' || command === null || (typeof command === 'string' && !command.trim())) {
    return undefined;
  }
  return {
    command: command as any,
  };
}

function normalizeDeploySelection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const providerId = String((value as Record<string, unknown>).providerId || '').trim();
  const connectionId = String((value as Record<string, unknown>).connectionId || '').trim();
  if (!providerId || !connectionId) {
    return undefined;
  }
  return {
    providerId,
    connectionId,
  } satisfies ControlPlaneServiceDeploySelection;
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
  validatePrdResetSubmission,
  validateRestartSubmission,
  validateServiceAuthSubmission,
};
