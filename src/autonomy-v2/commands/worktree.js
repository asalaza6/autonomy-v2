import shared from './shared.js';

function run(rootDir, options) {
  return shared.handlePrepareWorktree(rootDir, options);
}


export { run };
export default {
  run
};

