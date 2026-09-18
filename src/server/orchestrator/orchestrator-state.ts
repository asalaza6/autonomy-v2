import { validateAutonomyConfig } from '../../config/config-main.js';
import type { AnyRecord, AutonomyConfig, RuntimeState } from '../server-types.js';
import { getPaths, readJson, writeJson } from './paths.js';

function loadConfig(rootDir: string): { config: AutonomyConfig; sprint: AnyRecord } {
  const paths = getPaths(rootDir);
  return {
    config: validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig),
    sprint: readJson(paths.sprintConfig, {}),
  };
}

function loadRuntime(rootDir): RuntimeState {
  const paths = getPaths(rootDir);
  return readJson(paths.runtimeState, { workers: {} });
}

function writeRuntime(rootDir, runtime) {
  const paths = getPaths(rootDir);
  writeJson(paths.runtimeState, runtime);
}

export {
  loadConfig,
  loadRuntime,
  writeRuntime,
};
