import path from 'path';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { performLocalDeploy } from './shared-github.js';
import type { RepositoryConfig } from '../autonomy-types.js';
import {
  ensureInitialized,
  getAutonomyPaths,
  printOutput,
  readJson,
} from './shared-core.js';
import { gitRefExists, resolveBaseRef, runGitRead } from './shared-repo.js';

async function run(rootDir, options) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  const controlPlaneConfig = readJson<Partial<RepositoryConfig>>(
    path.join(paths.configDir, 'control-plane.json'),
    {}
  );
  const deployCommand = resolveDeployCommand(rootDir, paths, config, controlPlaneConfig);
  const streamDeployCommandOutput = options.streamDeployCommandOutput === false ? false : options.json !== true;
  const result = await performLocalDeploy(rootDir, {
    ...config,
    deployCommand,
  }, {
    streamDeployCommandOutput,
  });

  if (!result.ok) {
    throw new Error(result.message);
  }

  printOutput(options, result, () => {
    console.log(`Deployed ${result.sourceBranch} to ${result.targetBranch}`);
    console.log(`Commit: ${result.sha}`);
    if (result.pushMessage) {
      console.log(result.pushMessage);
    }
    if (result.deployCommand) {
      console.log(`Ran deploy command: ${result.deployCommand.command}`);
      if (!streamDeployCommandOutput && result.deployCommand.output) {
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
