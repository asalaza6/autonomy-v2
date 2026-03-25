const shared = require('./shared');

async function run(rootDir, options) {
  return shared.handlePrRecord(rootDir, options);
}

module.exports = {
  run,
};
