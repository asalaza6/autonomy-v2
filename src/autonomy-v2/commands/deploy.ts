import path from 'path';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { performLocalDeploy } from './shared-github.js';
import type { ControlPlaneConfig } from '../autonomy-types.js';
import { createProviderDeployExecution } from '../control-plane/service-auth.js';
import {
  ensureInitialized,
  getStringOption,
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
  const deployAutoStash = resolveDeployAutoStashOption(options, rootDir, paths, config, controlPlaneConfig);
  const result = performLocalDeploy(rootDir, {
    ...config,
    deployCommand,
    deployAutoStash,
  }, {
    redactions: providerDeploy?.redactions || [],
  });

  const mutableResult = result as typeof result & {
    providerConnection?: unknown;
    providerMetadata?: unknown;
  };
  if (result.ok && providerDeploy?.selection) {
    mutableResult.providerConnection = providerDeploy.selection;
  }
  if (result.ok && providerDeploy?.postDeployMetadata) {
    mutableResult.providerMetadata = providerDeploy.postDeployMetadata({
      rootDir,
      deployResult: result,
    });
  }

  printOutput(options, result, () => {
    console.log(`Starting deploy ${result.sourceBranch} -> ${result.targetBranch}`);
    if (result.autoStash?.used) {
      console.log(`Created auto-stash before deploy: ${result.autoStash.stashRef}`);
    }
    if (result.ok) {
      console.log(`Deployed ${result.sourceBranch} to ${result.targetBranch}`);
      console.log(`Commit: ${result.sha}`);
      if (result.pushMessage) {
        console.log(result.pushMessage);
      }
    } else if (result.deploySucceeded) {
      console.log(`Deploy completed, but auto-stash restore did not finish cleanly: ${result.message}`);
    } else {
      console.log(`Deploy failed: ${result.message}`);
    }
    if (result.deployCommand) {
      console.log(`Ran deploy command: ${result.deployCommand.command}`);
      if (result.deployCommand.output) {
        console.log(result.deployCommand.output);
      }
    }
    if (result.autoStash?.used) {
      if (result.autoStash.restore?.ok) {
        console.log(`Restored auto-stash: ${result.autoStash.stashRef}`);
      } else if (result.autoStash.restore?.conflict) {
        console.log(`WARNING: Auto-stash restore conflicted: ${result.autoStash.restore.message}`);
        if (result.autoStash.restore.recovery) {
          console.log(result.autoStash.restore.recovery);
        }
      } else if (result.autoStash.restore) {
        console.log(`WARNING: Auto-stash restore failed: ${result.autoStash.restore.message}`);
        if (result.autoStash.restore.recovery) {
          console.log(result.autoStash.restore.recovery);
        }
      }
    }
  });

  if (!result.ok) {
    throw new Error(result.message);
  }

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

function resolveDeployAutoStashOption(options, rootDir, paths, config, controlPlaneConfig) {
  const cliValue = parseBooleanOption(getStringOption(options, 'auto-stash', ''), options['auto-stash'] === true);
  if (typeof cliValue === 'boolean') {
    return cliValue;
  }
  const sourceDeployAutoStash = readDeployAutoStashFromSourceRef(rootDir, paths, config);
  if (typeof sourceDeployAutoStash === 'boolean') {
    return sourceDeployAutoStash;
  }
  if (typeof controlPlaneConfig.deployAutoStash === 'boolean') {
    return controlPlaneConfig.deployAutoStash;
  }
  if (typeof config.deployAutoStash === 'boolean') {
    return config.deployAutoStash;
  }
  return false;
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

function readDeployAutoStashFromSourceRef(rootDir, paths, config) {
  const sourceBranch = String(config.integrationBranch || 'dev').trim() || 'dev';
  let sourceRef = '';
  try {
    sourceRef = gitRefExists(rootDir, sourceBranch)
      ? sourceBranch
      : resolveBaseRef(rootDir, sourceBranch);
  } catch (_) {
    return undefined;
  }

  const controlPlaneAutoStash = readConfigPropertyFromGitRef(
    rootDir,
    sourceRef,
    path.relative(rootDir, path.join(paths.configDir, 'control-plane.json')),
    'deployAutoStash'
  );
  if (typeof controlPlaneAutoStash === 'boolean') {
    return controlPlaneAutoStash;
  }

  const configAutoStash = readConfigPropertyFromGitRef(
    rootDir,
    sourceRef,
    path.relative(rootDir, paths.agentsConfig),
    'deployAutoStash'
  );
  return typeof configAutoStash === 'boolean' ? configAutoStash : undefined;
}

function readDeployCommandFromGitRef(rootDir, ref, relativePath) {
  return readConfigPropertyFromGitRef(rootDir, ref, relativePath, 'deployCommand');
}

function readConfigPropertyFromGitRef(rootDir, ref, relativePath, propertyName) {
  const normalizedPath = String(relativePath || '').replace(/\\/g, '/');
  if (!normalizedPath) {
    return undefined;
  }
  try {
    const raw = runGitRead(rootDir, ['show', `${ref}:${normalizedPath}`]);
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, propertyName)) {
      return parsed[propertyName];
    }
  } catch (_) {
    return undefined;
  }
  return undefined;
}

function parseBooleanOption(value, implicitTrue = false) {
  if (implicitTrue) {
    return true;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid value for --auto-stash: ${value}. Expected true or false.`);
}

export { run };
