import shared from './shared.js';

function run(rootDir, options) {
  return shared.handleRuntimeStatus(rootDir, options);
}


export { run };
export default {
  run
};

