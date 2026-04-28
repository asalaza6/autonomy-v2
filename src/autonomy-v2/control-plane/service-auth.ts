import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import type {
  AnyRecord,
  ControlPlaneConfig,
  ControlPlaneServiceConnectionFieldStatus,
  ControlPlaneServiceConnectionRecord,
  ControlPlaneServiceConnectionStatus,
  ControlPlaneServiceConnectionSummary,
  ControlPlaneServiceDeploySelection,
  ControlPlaneServiceFailureClass,
  ControlPlaneServiceProviderRecord,
  DeployCommandConfig,
} from '../../types.js';
import { getAutonomyPaths, readJson, writeJson } from '../commands/shared-core.js';
import { readControlPlaneConfig } from '../../server/control-plane/control-plane-config.js';

const MACHINE_LOCAL_ENV_FILES = ['.env.autonomy.local', '.env.local'] as const;
const SHARED_ENV_FILES = ['.env.autonomy', '.env'] as const;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_PROVIDER_OUTPUT_LENGTH = 8_000;

type PersistedConnectionState = {
  providerId: string;
  connectionId: string;
  status: ControlPlaneServiceConnectionStatus;
  lastVerifiedAt?: string | null;
  failureClass?: ControlPlaneServiceFailureClass | null;
  accountMetadata?: Record<string, string | number | boolean | null>;
  capabilityMetadata?: Record<string, string | number | boolean | null>;
};

type PersistedServiceAuthState = {
  schemaVersion: number;
  connections: Record<string, PersistedConnectionState>;
};

type ResolvedSecretField = {
  field: string;
  envKey: string | null;
  value: string | null;
  source: ControlPlaneServiceConnectionFieldStatus['source'];
  required: boolean;
  secret: boolean;
  label: string;
};

type ProviderCommandContext = {
  providerId: string;
  connectionId: string;
  authStrategy: string;
  fields: Record<string, string>;
  accountMetadata: Record<string, string | number | boolean | null>;
  capabilityMetadata: Record<string, string | number | boolean | null>;
};

type ProviderCommandOutcome = {
  ok: boolean;
  status?: ControlPlaneServiceConnectionStatus;
  failureClass?: ControlPlaneServiceFailureClass | null;
  accountMetadata?: Record<string, string | number | boolean | null>;
  capabilityMetadata?: Record<string, string | number | boolean | null>;
};

type ProviderDeployExecution = {
  selection: ControlPlaneServiceDeploySelection;
  deployCommand: DeployCommandConfig;
  redactions: string[];
  postDeployMetadata: ((context: { rootDir: string; deployResult: AnyRecord }) => Record<string, unknown> | null) | null;
};

function buildServiceConnectionSummaries(rootDir: string) {
  const config = readControlPlaneConfig(rootDir);
  if (!config) {
    return [];
  }
  const providers = listServiceProviders(config);
  const connections = listServiceConnections(config);
  const persistedState = loadPersistedServiceAuthState(rootDir);
  return connections.map((connection) => buildServiceConnectionSummary(rootDir, providers, connection, persistedState));
}

function beginServiceAuth(rootDir: string, selection: ControlPlaneServiceDeploySelection) {
  const config = requireControlPlaneConfig(rootDir);
  const providers = listServiceProviders(config);
  const connection = getServiceConnection(config, selection);
  getServiceProvider(providers, selection.providerId);
  const nextState = {
    providerId: connection.providerId,
    connectionId: connection.connectionId,
    status: 'pending' as const,
    failureClass: null,
    lastVerifiedAt: null,
    accountMetadata: sanitizeMetadata(connection.accountMetadata),
    capabilityMetadata: sanitizeMetadata(connection.capabilityMetadata),
  };
  writePersistedConnectionState(rootDir, nextState);
  return buildServiceConnectionSummary(rootDir, providers, connection, loadPersistedServiceAuthState(rootDir));
}

function completeServiceAuth(rootDir: string, selection: ControlPlaneServiceDeploySelection) {
  return beginServiceAuth(rootDir, selection);
}

function verifyServiceConnection(rootDir: string, selection: ControlPlaneServiceDeploySelection) {
  const config = requireControlPlaneConfig(rootDir);
  const providers = listServiceProviders(config);
  const provider = getServiceProvider(providers, selection.providerId);
  const connection = getServiceConnection(config, selection);
  const resolution = resolveConnectionSecrets(rootDir, provider, connection);
  const unresolved = resolution.fields.filter((field) => field.required && !field.value);
  const missingAlias = resolution.fields.filter((field) => field.required && !field.envKey);
  if (missingAlias.length > 0 || unresolved.length > 0) {
    const failureClass = normalizeFailureClass(missingAlias.length > 0 ? 'missing-env-alias' : 'unresolved-secret-field') || 'needs-reconnect';
    const persisted = {
      providerId: connection.providerId,
      connectionId: connection.connectionId,
      status: 'needs-reconnect' as const,
      lastVerifiedAt: null,
      failureClass,
      accountMetadata: sanitizeMetadata(connection.accountMetadata),
      capabilityMetadata: sanitizeMetadata(connection.capabilityMetadata),
    };
    writePersistedConnectionState(rootDir, persisted);
    return buildServiceConnectionSummary(rootDir, providers, connection, loadPersistedServiceAuthState(rootDir));
  }

  const providerContext = buildProviderCommandContext(provider, connection, resolution.fields);
  const outcome = executeProviderVerify(rootDir, provider, providerContext);
  const nextState: PersistedConnectionState = {
    providerId: connection.providerId,
    connectionId: connection.connectionId,
    status: resolveVerifiedStatus(outcome),
    lastVerifiedAt: outcome.ok ? new Date().toISOString() : null,
    failureClass: outcome.ok ? null : normalizeFailureClass(outcome.failureClass || 'verification-failed'),
    accountMetadata: sanitizeMetadata({
      ...connection.accountMetadata,
      ...outcome.accountMetadata,
    }),
    capabilityMetadata: sanitizeMetadata({
      ...connection.capabilityMetadata,
      ...provider.capabilityMetadata,
      ...outcome.capabilityMetadata,
    }),
  };
  writePersistedConnectionState(rootDir, nextState);
  return buildServiceConnectionSummary(rootDir, providers, connection, loadPersistedServiceAuthState(rootDir));
}

function createProviderDeployExecution(
  rootDir: string,
  selection: ControlPlaneServiceDeploySelection | null | undefined,
): ProviderDeployExecution | null {
  const config = readControlPlaneConfig(rootDir);
  if (!config) {
    return null;
  }
  const effectiveSelection = normalizeDeploySelection(selection) || normalizeDeploySelection(config.providerDeploy);
  if (!effectiveSelection) {
    return null;
  }
  const providers = listServiceProviders(config);
  const provider = getServiceProvider(providers, effectiveSelection.providerId);
  const connection = getServiceConnection(config, effectiveSelection);
  const resolution = resolveConnectionSecrets(rootDir, provider, connection);
  const missingAlias = resolution.fields.find((field) => field.required && !field.envKey);
  if (missingAlias) {
    throw new Error(`Service connection ${connection.connectionId} is missing an env alias for ${missingAlias.field}.`);
  }
  const unresolved = resolution.fields.find((field) => field.required && !field.value);
  if (unresolved) {
    throw new Error(`Service connection ${connection.connectionId} could not resolve ${unresolved.field} from ${unresolved.envKey || 'its env alias'}.`);
  }
  if (!provider.deployCommand || typeof provider.deployCommand !== 'object' || !provider.deployCommand.command) {
    throw new Error(`Service provider ${provider.providerId} does not define a deployCommand.`);
  }
  const context = buildProviderCommandContext(provider, connection, resolution.fields);
  if (provider.preflightCommand?.command) {
    const preflight = executeProviderCommand(rootDir, provider.preflightCommand.command, context);
    if (!preflight.ok) {
      throw new Error(`Provider preflight failed for ${provider.providerId}/${connection.connectionId}.`);
    }
  }
  const deployCommand = materializeProviderCommand(provider.deployCommand.command, context);
  return {
    selection: effectiveSelection,
    deployCommand,
    redactions: resolution.fields.map((field) => field.value).filter((value): value is string => Boolean(value)),
    postDeployMetadata: provider.postDeployMetadataCommand?.command
      ? ({ deployResult }) => {
        const metadata = executeProviderCommand(
          rootDir,
          provider.postDeployMetadataCommand!.command,
          {
            ...context,
            capabilityMetadata: {
              ...context.capabilityMetadata,
              deployVersion: String(deployResult && deployResult.version && deployResult.version.currentVersion || ''),
            },
          },
        );
        return metadata.ok ? {
          accountMetadata: sanitizeMetadata(metadata.accountMetadata),
          capabilityMetadata: sanitizeMetadata(metadata.capabilityMetadata),
        } : null;
      }
      : null,
  };
}

function buildServiceConnectionSummary(
  rootDir: string,
  providers: Map<string, ControlPlaneServiceProviderRecord>,
  connection: ControlPlaneServiceConnectionRecord,
  persistedState: PersistedServiceAuthState,
): ControlPlaneServiceConnectionSummary {
  const provider = getServiceProvider(providers, connection.providerId);
  const resolution = resolveConnectionSecrets(rootDir, provider, connection);
  const persisted = persistedState.connections[buildPersistedConnectionKey(connection.providerId, connection.connectionId)] || null;
  const missingAlias = resolution.fields.some((field) => field.required && !field.envKey);
  const unresolved = resolution.fields.some((field) => field.required && !field.value);

  let status = persisted?.status || 'pending';
  let failureClass = persisted?.failureClass || null;
  if (missingAlias) {
    status = 'needs-reconnect';
    failureClass = 'missing-env-alias';
  } else if (unresolved) {
    status = 'needs-reconnect';
    failureClass = 'unresolved-secret-field';
  } else if (!persisted) {
    status = 'pending';
    failureClass = null;
  }

  return {
    providerId: connection.providerId,
    providerLabel: provider.label || connection.providerId,
    connectionId: connection.connectionId,
    label: connection.label || connection.connectionId,
    authStrategy: connection.authStrategy,
    status,
    statusLabel: formatConnectionStatus(status),
    lastVerifiedAt: persisted?.lastVerifiedAt || null,
    failureClass,
    failureLabel: failureClass ? formatFailureClass(failureClass) : null,
    accountMetadata: sanitizeMetadata({
      ...connection.accountMetadata,
      ...persisted?.accountMetadata,
    }),
    capabilityMetadata: sanitizeMetadata({
      ...provider.capabilityMetadata,
      ...connection.capabilityMetadata,
      ...persisted?.capabilityMetadata,
    }),
    requiredScopes: Array.isArray(provider.requiredScopes) ? provider.requiredScopes.slice() : [],
    fieldStatuses: resolution.fields.map((field) => ({
      field: field.field,
      label: field.label,
      envKey: field.envKey,
      required: field.required,
      secret: field.secret,
      resolved: Boolean(field.value),
      source: field.value ? field.source : 'unresolved',
    })),
  };
}

function buildProviderCommandContext(
  provider: ControlPlaneServiceProviderRecord,
  connection: ControlPlaneServiceConnectionRecord,
  fields: ResolvedSecretField[],
): ProviderCommandContext {
  const resolvedFields = fields.reduce((record, field) => {
    if (field.value) {
      record[field.field] = field.value;
    }
    return record;
  }, {} as Record<string, string>);
  return {
    providerId: provider.providerId,
    connectionId: connection.connectionId,
    authStrategy: connection.authStrategy,
    fields: resolvedFields,
    accountMetadata: sanitizeMetadata(connection.accountMetadata),
    capabilityMetadata: sanitizeMetadata({
      ...provider.capabilityMetadata,
      ...connection.capabilityMetadata,
    }),
  };
}

function executeProviderVerify(
  rootDir: string,
  provider: ControlPlaneServiceProviderRecord,
  context: ProviderCommandContext,
): ProviderCommandOutcome {
  if (!provider.verifyCommand?.command) {
    return { ok: true, status: 'connected' };
  }
  return executeProviderCommand(rootDir, provider.verifyCommand.command, context);
}

function executeProviderCommand(
  rootDir: string,
  commandConfig: DeployCommandConfig,
  context: ProviderCommandContext,
): ProviderCommandOutcome {
  const materialized = materializeProviderCommand(commandConfig, context);
  const normalized = normalizeCommandConfig(materialized, rootDir);
  if (!normalized) {
    return { ok: true };
  }
  const result = spawnSync(normalized.command, normalized.args, {
    cwd: normalized.cwd,
    encoding: 'utf8',
    shell: normalized.shell,
    timeout: DEFAULT_COMMAND_TIMEOUT_MS,
    env: {
      ...process.env,
      ...normalized.env,
    },
  });
  const stdout = trimCommandOutput(result.stdout);
  const stderr = trimCommandOutput(result.stderr);
  const parsed = parseProviderOutcome(stdout) || parseProviderOutcome(stderr);
  if (result.status === 0) {
    if (parsed) {
      return {
        ok: parsed.ok !== false,
        status: normalizeConnectionStatus(parsed.status || 'connected'),
        failureClass: normalizeFailureClass(parsed.failureClass || null),
        accountMetadata: sanitizeMetadata(parsed.accountMetadata),
        capabilityMetadata: sanitizeMetadata(parsed.capabilityMetadata),
      };
    }
    return { ok: true, status: 'connected' };
  }
  return {
    ok: false,
    status: normalizeConnectionStatus(parsed?.status || 'verification-failed'),
    failureClass: normalizeFailureClass(parsed?.failureClass || 'invalid-credential'),
    accountMetadata: sanitizeMetadata(parsed?.accountMetadata),
    capabilityMetadata: sanitizeMetadata(parsed?.capabilityMetadata),
  };
}

function materializeProviderCommand(commandConfig: DeployCommandConfig, context: ProviderCommandContext): DeployCommandConfig {
  if (typeof commandConfig === 'string') {
    return applyTemplate(commandConfig, context);
  }
  if (Array.isArray(commandConfig)) {
    return commandConfig.map((entry) => applyTemplate(String(entry || ''), context));
  }
  if (!commandConfig || typeof commandConfig !== 'object') {
    return commandConfig;
  }
  const envEntries = Object.entries(commandConfig.env || {}).reduce((record, [key, value]) => {
    record[key] = applyTemplate(String(value ?? ''), context);
    return record;
  }, {} as Record<string, string>);
  return {
    ...commandConfig,
    command: applyTemplate(String(commandConfig.command || ''), context),
    args: Array.isArray(commandConfig.args)
      ? commandConfig.args.map((arg) => applyTemplate(String(arg || ''), context))
      : [],
    cwd: commandConfig.cwd ? applyTemplate(String(commandConfig.cwd), context) : commandConfig.cwd,
    env: envEntries,
  };
}

function normalizeCommandConfig(value: DeployCommandConfig | null | undefined, fallbackCwd: string) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const command = String(value || '').trim();
    return command
      ? {
        command,
        args: [] as string[],
        cwd: fallbackCwd,
        env: {} as Record<string, string>,
        shell: true,
      }
      : null;
  }
  if (Array.isArray(value)) {
    const [rawCommand, ...rawArgs] = value;
    const command = String(rawCommand || '').trim();
    return command
      ? {
        command,
        args: rawArgs.map((arg) => String(arg)),
        cwd: fallbackCwd,
        env: {} as Record<string, string>,
        shell: false,
      }
      : null;
  }
  const command = String(value.command || '').trim();
  if (!command) {
    return null;
  }
  return {
    command,
    args: Array.isArray(value.args) ? value.args.map((arg) => String(arg)) : [],
    cwd: value.cwd ? path.resolve(fallbackCwd, String(value.cwd)) : fallbackCwd,
    env: Object.entries(value.env || {}).reduce((record, [key, entry]) => {
      if (typeof entry === 'undefined' || entry === null) {
        return record;
      }
      record[String(key)] = String(entry);
      return record;
    }, {} as Record<string, string>),
    shell: value.shell === true,
  };
}

function applyTemplate(input: string, context: ProviderCommandContext) {
  return String(input || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, token: string) => {
    if (token === 'providerId') {
      return context.providerId;
    }
    if (token === 'connectionId') {
      return context.connectionId;
    }
    if (token === 'authStrategy') {
      return context.authStrategy;
    }
    if (token.startsWith('accountMetadata.')) {
      return String(context.accountMetadata[token.slice('accountMetadata.'.length)] ?? '');
    }
    if (token.startsWith('capabilityMetadata.')) {
      return String(context.capabilityMetadata[token.slice('capabilityMetadata.'.length)] ?? '');
    }
    return String(context.fields[token] ?? '');
  });
}

function resolveConnectionSecrets(
  rootDir: string,
  provider: ControlPlaneServiceProviderRecord,
  connection: ControlPlaneServiceConnectionRecord,
) {
  const descriptors = new Map<string, { label: string; required: boolean; secret: boolean }>();
  (provider.authFields || []).forEach((field) => {
    descriptors.set(field.field, {
      label: String(field.label || field.field),
      required: field.required !== false,
      secret: field.secret !== false,
    });
  });
  Object.keys(connection.envAliases || {}).forEach((field) => {
    if (!descriptors.has(field)) {
      descriptors.set(field, {
        label: field,
        required: false,
        secret: true,
      });
    }
  });

  const fields = Array.from(descriptors.entries()).map(([field, descriptor]) => {
    const envKey = String(connection.envAliases?.[field] || '').trim() || null;
    const resolved = envKey ? resolveEnvValue(rootDir, envKey) : null;
    return {
      field,
      envKey,
      value: resolved?.value || null,
      source: resolved?.source || 'unresolved',
      required: descriptor.required,
      secret: descriptor.secret,
      label: descriptor.label,
    } satisfies ResolvedSecretField;
  });
  return { fields };
}

function resolveEnvValue(rootDir: string, envKey: string) {
  const normalizedKey = String(envKey || '').trim();
  if (!normalizedKey) {
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(process.env, normalizedKey) && typeof process.env[normalizedKey] !== 'undefined') {
    return {
      value: String(process.env[normalizedKey] || ''),
      source: 'runtime' as const,
    };
  }
  for (const fileName of MACHINE_LOCAL_ENV_FILES) {
    const value = readEnvValueFromFile(path.join(rootDir, fileName), normalizedKey);
    if (value !== null) {
      return {
        value,
        source: 'machine-local' as const,
      };
    }
  }
  for (const fileName of SHARED_ENV_FILES) {
    const value = readEnvValueFromFile(path.join(rootDir, fileName), normalizedKey);
    if (value !== null) {
      return {
        value,
        source: 'shared-file' as const,
      };
    }
  }
  return null;
}

function readEnvValueFromFile(filePath: string, envKey: string) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (key !== envKey) {
      continue;
    }
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    if (
      (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith('\'') && rawValue.endsWith('\''))
    ) {
      return rawValue.slice(1, -1);
    }
    return rawValue;
  }
  return null;
}

function listServiceProviders(config: ControlPlaneConfig) {
  const providers = new Map<string, ControlPlaneServiceProviderRecord>();
  (config.serviceProviders || []).forEach((provider) => {
    const providerId = String(provider && provider.providerId || '').trim();
    if (!providerId) {
      return;
    }
    providers.set(providerId, provider);
  });
  return providers;
}

function listServiceConnections(config: ControlPlaneConfig) {
  return (config.serviceConnections || []).filter((connection) => {
    return Boolean(
      connection
      && String(connection.providerId || '').trim()
      && String(connection.connectionId || '').trim()
      && String(connection.authStrategy || '').trim(),
    );
  });
}

function getServiceProvider(providers: Map<string, ControlPlaneServiceProviderRecord>, providerId: string) {
  const provider = providers.get(String(providerId || '').trim());
  if (!provider) {
    throw new Error(`Unknown service provider "${providerId}".`);
  }
  return provider;
}

function getServiceConnection(config: ControlPlaneConfig, selection: ControlPlaneServiceDeploySelection) {
  const connection = listServiceConnections(config).find((entry) => {
    return String(entry.providerId || '').trim() === String(selection.providerId || '').trim()
      && String(entry.connectionId || '').trim() === String(selection.connectionId || '').trim();
  });
  if (!connection) {
    throw new Error(`Unknown service connection "${selection.connectionId}" for provider "${selection.providerId}".`);
  }
  return connection;
}

function requireControlPlaneConfig(rootDir: string) {
  const config = readControlPlaneConfig(rootDir);
  if (!config) {
    throw new Error('Missing control-plane config.');
  }
  return config;
}

function loadPersistedServiceAuthState(rootDir: string): PersistedServiceAuthState {
  const statePath = getServiceAuthStatePath(rootDir);
  return normalizePersistedServiceAuthState(readJson(statePath, {
    schemaVersion: 1,
    connections: {},
  }));
}

function writePersistedConnectionState(rootDir: string, connectionState: PersistedConnectionState) {
  const statePath = getServiceAuthStatePath(rootDir);
  const state = loadPersistedServiceAuthState(rootDir);
  state.connections[buildPersistedConnectionKey(connectionState.providerId, connectionState.connectionId)] = {
    providerId: connectionState.providerId,
    connectionId: connectionState.connectionId,
    status: normalizeConnectionStatus(connectionState.status),
    lastVerifiedAt: connectionState.lastVerifiedAt || null,
    failureClass: normalizeFailureClass(connectionState.failureClass || null),
    accountMetadata: sanitizeMetadata(connectionState.accountMetadata),
    capabilityMetadata: sanitizeMetadata(connectionState.capabilityMetadata),
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  writeJson(statePath, state);
}

function normalizePersistedServiceAuthState(value: Partial<PersistedServiceAuthState> = {}): PersistedServiceAuthState {
  const connections = Object.entries(value.connections || {}).reduce((record, [key, entry]) => {
    if (!entry || typeof entry !== 'object') {
      return record;
    }
    const providerId = String((entry as PersistedConnectionState).providerId || '').trim();
    const connectionId = String((entry as PersistedConnectionState).connectionId || '').trim();
    if (!providerId || !connectionId) {
      return record;
    }
    record[key] = {
      providerId,
      connectionId,
      status: normalizeConnectionStatus((entry as PersistedConnectionState).status),
      lastVerifiedAt: String((entry as PersistedConnectionState).lastVerifiedAt || '').trim() || null,
      failureClass: normalizeFailureClass((entry as PersistedConnectionState).failureClass || null),
      accountMetadata: sanitizeMetadata((entry as PersistedConnectionState).accountMetadata),
      capabilityMetadata: sanitizeMetadata((entry as PersistedConnectionState).capabilityMetadata),
    };
    return record;
  }, {} as Record<string, PersistedConnectionState>);
  return {
    schemaVersion: 1,
    connections,
  };
}

function getServiceAuthStatePath(rootDir: string) {
  const paths = getAutonomyPaths(rootDir);
  return path.join(paths.runtimeAutonomyDir, 'service-connections.json');
}

function buildPersistedConnectionKey(providerId: string, connectionId: string) {
  return `${String(providerId || '').trim()}:${String(connectionId || '').trim()}`;
}

function sanitizeMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce((record, [key, entry]) => {
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
}

function parseProviderOutcome(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function trimCommandOutput(value: unknown) {
  return String(value || '').trim().slice(0, MAX_PROVIDER_OUTPUT_LENGTH);
}

function normalizeDeploySelection(value: unknown) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const providerId = String((value as ControlPlaneServiceDeploySelection).providerId || '').trim();
  const connectionId = String((value as ControlPlaneServiceDeploySelection).connectionId || '').trim();
  if (!providerId || !connectionId) {
    return null;
  }
  return {
    providerId,
    connectionId,
  } satisfies ControlPlaneServiceDeploySelection;
}

function normalizeConnectionStatus(value: unknown): ControlPlaneServiceConnectionStatus {
  const normalized = String(value || '').trim();
  if (
    normalized === 'connected'
    || normalized === 'verification-failed'
    || normalized === 'expired'
    || normalized === 'revoked'
    || normalized === 'insufficient-scopes'
    || normalized === 'needs-reconnect'
    || normalized === 'pending'
  ) {
    return normalized;
  }
  return 'pending';
}

function normalizeFailureClass(value: unknown): ControlPlaneServiceFailureClass | null {
  const normalized = String(value || '').trim();
  if (
    normalized === 'missing-env-alias'
    || normalized === 'unresolved-secret-field'
    || normalized === 'invalid-credential'
    || normalized === 'insufficient-scopes'
    || normalized === 'expired'
    || normalized === 'revoked'
    || normalized === 'verification-failed'
    || normalized === 'provider-error'
    || normalized === 'needs-reconnect'
  ) {
    return normalized;
  }
  return normalized ? 'provider-error' : null;
}

function formatConnectionStatus(status: ControlPlaneServiceConnectionStatus) {
  if (status === 'connected') {
    return 'Connected';
  }
  if (status === 'verification-failed') {
    return 'Verification failed';
  }
  if (status === 'insufficient-scopes') {
    return 'Insufficient scopes';
  }
  if (status === 'needs-reconnect') {
    return 'Needs reconnect';
  }
  return status.replace(/-/g, ' ');
}

function formatFailureClass(failureClass: ControlPlaneServiceFailureClass) {
  if (failureClass === 'missing-env-alias') {
    return 'Missing env alias';
  }
  if (failureClass === 'unresolved-secret-field') {
    return 'Secret not found';
  }
  if (failureClass === 'invalid-credential') {
    return 'Invalid credential';
  }
  if (failureClass === 'insufficient-scopes') {
    return 'Insufficient scopes';
  }
  if (failureClass === 'needs-reconnect') {
    return 'Needs reconnect';
  }
  return failureClass.replace(/-/g, ' ');
}

function resolveVerifiedStatus(outcome: ProviderCommandOutcome): ControlPlaneServiceConnectionStatus {
  if (outcome.ok) {
    return 'connected';
  }
  if (outcome.status) {
    return normalizeConnectionStatus(outcome.status);
  }
  if (outcome.failureClass === 'insufficient-scopes') {
    return 'insufficient-scopes';
  }
  if (outcome.failureClass === 'expired') {
    return 'expired';
  }
  if (outcome.failureClass === 'revoked') {
    return 'revoked';
  }
  return 'verification-failed';
}

export {
  beginServiceAuth,
  buildServiceConnectionSummaries,
  completeServiceAuth,
  createProviderDeployExecution,
  verifyServiceConnection,
};
