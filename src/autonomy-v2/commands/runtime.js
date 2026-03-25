const shared = require('./shared');

function run(rootDir, options) {
  return shared.handleRuntimeStatus(rootDir, options);
}

module.exports = {
  run,
};
