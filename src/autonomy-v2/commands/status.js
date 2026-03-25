const shared = require('./shared');

function run(rootDir, options) {
  return shared.handleStatus(rootDir, options);
}

module.exports = {
  run,
};
