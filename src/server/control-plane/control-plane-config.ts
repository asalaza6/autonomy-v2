import fs from 'fs';
import path from 'path';
import { getAutonomyPaths, readJson } from '../../autonomy-v2/commands/shared-core.js';
import { normalizeControlPlaneConfig } from './control-plane-validation.js';

function getControlPlaneConfigPath(rootDir: string) {
  const paths = getAutonomyPaths(rootDir);
  return path.join(paths.configDir, 'control-plane.json');
}

function loadControlPlaneConfig(rootDir: string) {
  const envConfig = loadControlPlaneConfigFromEnv();
  if (envConfig) {
    return envConfig;
  }

  const configPath = getControlPlaneConfigPath(rootDir);
  if (!fs.existsSync(configPath)) {
    return normalizeControlPlaneConfig();
  }
  return normalizeControlPlaneConfig(readJson(configPath));
}

function loadControlPlaneConfigFromEnv() {
  const configJson = String(process.env.AUTONOMY_CONTROL_PLANE_CONFIG_JSON || '').trim();
  if (configJson) {
    try {
      return normalizeControlPlaneConfig(JSON.parse(configJson));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid AUTONOMY_CONTROL_PLANE_CONFIG_JSON: ${message}`);
    }
  }

  const configPath = String(process.env.AUTONOMY_CONTROL_PLANE_CONFIG_PATH || '').trim();
  if (!configPath) {
    return null;
  }
  if (!fs.existsSync(configPath)) {
    return null;
  }
  return normalizeControlPlaneConfig(readJson(configPath));
}

export {
  getControlPlaneConfigPath,
  loadControlPlaneConfig,
  loadControlPlaneConfigFromEnv,
};
