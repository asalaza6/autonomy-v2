import { handlePrepareWorktree } from './shared.js';

function run(rootDir, options) {
  return handlePrepareWorktree(rootDir, options);
}


export { run };
