import shared from './shared.js';

async function run(rootDir, options) {
  return shared.handleMerge(rootDir, options);
}


export { run };
export default {
  run
};

