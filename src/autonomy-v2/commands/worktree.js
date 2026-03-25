const shared = require('./shared');

function run(rootDir, options) {
  return shared.handlePrepareWorktree(rootDir, options);
}

module.exports = {
  run,
};
