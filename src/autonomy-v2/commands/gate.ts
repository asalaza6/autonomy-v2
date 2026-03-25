import { handleReviewRecord } from './shared.js';

async function run(rootDir, options) {
  return handleReviewRecord(rootDir, options);
}


export { run };
