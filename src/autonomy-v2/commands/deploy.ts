import { validateAutonomyConfig } from '../../config/config-main.js';
import { performLocalDeploy } from './shared-github.js';
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
  const result = performLocalDeploy(rootDir, config);

  if (!result.ok) {
    throw new Error(result.message);
  }

  printOutput(options, result, () => {
    console.log(`Deployed ${result.sourceBranch} to ${result.targetBranch}`);
    console.log(`Commit: ${result.sha}`);
    if (result.pushMessage) {
      console.log(result.pushMessage);
    }
  });

  return result;
}

export { run };
