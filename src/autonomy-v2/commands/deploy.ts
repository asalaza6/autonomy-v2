import path from 'path';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { performLocalDeploy } from './shared-github.js';
import type { ControlPlaneConfig } from '../autonomy-types.js';
import { createProviderDeployExecution } from '../control-plane/service-auth.js';
import {
  ensureInitialized,
  getAutonomyPaths,
  printOutput,
  readJson,
} from './shared-core.js';
import { gitRefExists, resolveBaseRef, runGitRead } from './shared-repo.js';

function run(rootDir, options) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  const controlPlaneConfig = readJson<Partial<ControlPlaneConfig>>(
    path.join(paths.configDir, 'control-plane.json'),
    {}
  );
  const providerDeploy = createProviderDeployExecution(rootDir, {
    providerId: String(options.providerId || '').trim() || undefined,
    connectionId: String(options.connectionId || '').trim() || undefined,
  }, {
    runtimeEnv: options.runtimeEnv,
  });
  const deployCommand = providerDeploy?.deployCommand || resolveDeployCommand(rootDir, paths, config, controlPlaneConfig);
  const result = performLocalDeploy(rootDir, {
    ...config,
    deployCommand,
  }, {
    redactions: providerDeploy?.redactions || [],
  });

  if (!result.ok) {
    throw new Error(result.message);
  }
  const mutableResult = result as typeof result & {
    providerConnection?: unknown;
    providerMetadata?: unknown;
  };
  if (providerDeploy?.selection) {
    mutableResult.providerConnection = providerDeploy.selection;
  }
  if (providerDeploy?.postDeployMetadata) {
    mutableResult.providerMetadata = providerDeploy.postDeployMetadata({
      rootDir,
      deployResult: result,
    });
  }

  printOutput(options, result, () => {
    console.log(`Deployed ${result.sourceBranch} to ${result.targetBranch}`);
    console.log(`Commit: ${result.sha}`);
    if (result.pushMessage) {
      console.log(result.pushMessage);
    }
    if (result.deployCommand) {
      console.log(`Ran deploy command: ${result.deployCommand.command}`);
      if (result.deployCommand.output) {
        console.log(result.deployCommand.output);
      }
    }
  });

  return result;
}

function resolveDeployCommand(rootDir, paths, config, controlPlaneConfig) {
  const sourceDeployCommand = readDeployCommandFromSourceRef(rootDir, paths, config);
  if (typeof sourceDeployCommand !== 'undefined') {
    return sourceDeployCommand;
  }
  if (Object.prototype.hasOwnProperty.call(controlPlaneConfig, 'deployCommand')) {
    return controlPlaneConfig.deployCommand;
  }
  return config.deployCommand;
}

function readDeployCommandFromSourceRef(rootDir, paths, config) {
  const sourceBranch = String(config.integrationBranch || 'dev').trim() || 'dev';
  let sourceRef = '';
  try {
    sourceRef = gitRefExists(rootDir, sourceBranch)
      ? sourceBranch
      : resolveBaseRef(rootDir, sourceBranch);
  } catch (_) {
    return undefined;
  }

  const controlPlaneDeployCommand = readDeployCommandFromGitRef(
    rootDir,
    sourceRef,
    path.relative(rootDir, path.join(paths.configDir, 'control-plane.json'))
  );
  if (typeof controlPlaneDeployCommand !== 'undefined') {
    return controlPlaneDeployCommand;
  }

  return readDeployCommandFromGitRef(
    rootDir,
    sourceRef,
    path.relative(rootDir, paths.agentsConfig)
  );
}

function readDeployCommandFromGitRef(rootDir, ref, relativePath) {
  const normalizedPath = String(relativePath || '').replace(/\\/g, '/');
  if (!normalizedPath) {
    return undefined;
  }
  try {
    const raw = runGitRead(rootDir, ['show', `${ref}:${normalizedPath}`]);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'deployCommand')) {
      return parsed.deployCommand;
    }
  } catch (_) {
    return undefined;
  }
  return undefined;
}

export { run };
