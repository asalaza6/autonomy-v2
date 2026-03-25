const shared = require('./shared');

function run(rootDir, options) {
  return shared.handleInit(rootDir, options);
}

module.exports = {
  run,
};
