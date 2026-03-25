import { handleArchiveCompletedPrds, handlePrdAdd, handlePrdList } from './shared.js';

function run(rootDir, options, command) {
  if (command === 'prd:add') {
    return handlePrdAdd(rootDir, options);
  }
  if (command === 'prd:list') {
    return handlePrdList(rootDir, options);
  }
  return handleArchiveCompletedPrds(rootDir, options);
}


export { run };
