import path from 'path';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { performLocalDeploy } from './shared-github.js';
import type { ControlPlaneConfig } from '../autonomy-types.js';
import {
  ensureInitialized,
  getAutonomyPaths,
  printOutput,
  readJson,
} from './shared-core.js';

function run(rootDir, options) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  const controlPlaneConfig = readJson<Partial<ControlPlaneConfig>>(
    path.join(paths.configDir, 'control-plane.json'),
    {}
  );
  const deployCommand = typeof controlPlaneConfig.deployCommand === 'undefined'
    ? config.deployCommand
    : controlPlaneConfig.deployCommand;
  const result = performLocalDeploy(rootDir, {
    ...config,
    deployCommand,
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
      if (result.deployCommand.output) {
        console.log(result.deployCommand.output);
      }
    }
  });

  return result;
}

export { run };
