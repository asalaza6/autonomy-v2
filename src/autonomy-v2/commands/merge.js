const shared = require('./shared');

async function run(rootDir, options) {
  return shared.handleMerge(rootDir, options);
}

module.exports = {
  run,
};
