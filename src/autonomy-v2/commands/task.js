import shared from './shared.js';

function run(rootDir, options, command) {
  if (command === 'task:add') {
    return shared.handleTaskAdd(rootDir, options);
  }
  if (command === 'task:finish') {
    return shared.handleTaskFinish(rootDir, options);
  }
  return shared.handleTaskList(rootDir, options);
}


export { run };
export default {
  run
};

