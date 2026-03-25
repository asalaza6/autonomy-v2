import shared from './shared.js';

async function run(rootDir, options) {
  return shared.handleReviewRecord(rootDir, options);
}


export { run };
export default {
  run
};

