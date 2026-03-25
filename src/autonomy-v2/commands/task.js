const shared = require('./shared');

function run(rootDir, options, command) {
  if (command === 'task:add') {
    return shared.handleTaskAdd(rootDir, options);
  }
  if (command === 'task:finish') {
    return shared.handleTaskFinish(rootDir, options);
  }
  return shared.handleTaskList(rootDir, options);
}

module.exports = {
  run,
};
