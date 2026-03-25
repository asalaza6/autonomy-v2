import { handleRuntimeStatus } from './shared.js';

function run(rootDir, options) {
  return handleRuntimeStatus(rootDir, options);
}


export { run };
