const shared = require('./shared');

async function run(rootDir, options) {
  return shared.handleReviewRecord(rootDir, options);
}

module.exports = {
  run,
};
