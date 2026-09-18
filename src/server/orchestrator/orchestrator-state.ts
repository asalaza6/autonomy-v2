import type { RuntimeState } from '../server-types.js';
import { getPaths, readJson, writeJson } from './paths.js';

function loadRuntime(rootDir): RuntimeState {
  const paths = getPaths(rootDir);
  return readJson(paths.runtimeState, {});
}

function writeRuntime(rootDir, runtime) {
  const paths = getPaths(rootDir);
  writeJson(paths.runtimeState, runtime);
}

export {
loadRuntime,
writeRuntime
};
