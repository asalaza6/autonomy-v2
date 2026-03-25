import { handleMerge } from './shared.js';

async function run(rootDir, options) {
  return handleMerge(rootDir, options);
}


export { run };
