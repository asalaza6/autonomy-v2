import { handleTaskAdd, handleTaskFinish, handleTaskList } from './shared.js';

function run(rootDir, options, command) {
  if (command === 'task:add') {
    return handleTaskAdd(rootDir, options);
  }
  if (command === 'task:finish') {
    return handleTaskFinish(rootDir, options);
  }
  return handleTaskList(rootDir, options);
}


export { run };
