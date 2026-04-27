import fs from 'fs';
import path from 'path';
import { getAutonomyPaths, readJson } from '../../autonomy-v2/commands/shared-core.js';
import { assertControlPlaneRepoId, normalizeControlPlaneConfig } from './control-plane-validation.js';

function getControlPlaneConfigPath(rootDir: string) {
  const paths = getAutonomyPaths(rootDir);
  return path.join(paths.configDir, 'control-plane.json');
}

function loadControlPlaneConfig(rootDir: string) {
  const configPath = getControlPlaneConfigPath(rootDir);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing control-plane repo config at ${configPath}`);
  }
  const config = normalizeControlPlaneConfig(readJson(configPath));
  assertControlPlaneRepoId(config);
  return config;
}

function readControlPlaneConfig(rootDir: string) {
  try {
    return loadControlPlaneConfig(rootDir);
  } catch {
    return null;
  }
}

export {
  getControlPlaneConfigPath,
  loadControlPlaneConfig,
  readControlPlaneConfig,
};
