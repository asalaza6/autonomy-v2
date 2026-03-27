import { syncPrdSpecsFromIntegrationBranch } from '../../sync/syncer.js';
import { validateAutonomyConfig } from '../../config/config-main.js';
import type { AnyRecord, AutonomyConfig } from '../autonomy-types.js';
import { getAutonomyPaths, readJson } from './shared-core.js';

function syncIntegrationSpecs(rootDir: string, options: AnyRecord = {}) {
  if (options.sync !== true) {
    return null;
  }
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig) as AutonomyConfig;
  return syncPrdSpecsFromIntegrationBranch(rootDir, config.integrationBranch);
}

export { syncIntegrationSpecs };
