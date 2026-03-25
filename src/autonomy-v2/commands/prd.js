const shared = require('./shared');

function run(rootDir, options, command) {
  if (command === 'prd:add') {
    return shared.handlePrdAdd(rootDir, options);
  }
  if (command === 'prd:list') {
    return shared.handlePrdList(rootDir, options);
  }
  return shared.handleArchiveCompletedPrds(rootDir, options);
}

module.exports = {
  run,
};
