import fs from 'fs';
import path from 'path';
import { getAutonomyPaths, readJson } from '../../autonomy-v2/commands/shared-core.js';
import { normalizeControlPlaneConfig } from './control-plane-validation.js';

function getControlPlaneConfigPath(rootDir: string) {
  const paths = getAutonomyPaths(rootDir);
  return path.join(paths.configDir, 'control-plane.json');
}

function loadControlPlaneConfig(rootDir: string) {
  const configPath = getControlPlaneConfigPath(rootDir);
  if (!fs.existsSync(configPath)) {
    return normalizeControlPlaneConfig();
  }
  return normalizeControlPlaneConfig(readJson(configPath));
}

export {
  getControlPlaneConfigPath,
  loadControlPlaneConfig,
};
