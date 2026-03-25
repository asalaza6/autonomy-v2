const shared = require('./shared');

function run(rootDir, options) {
  return shared.handleScopeValidate(rootDir, options);
}

module.exports = {
  run,
};
