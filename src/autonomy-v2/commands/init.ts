import shared from './shared.js';

function run(rootDir, options) {
  return shared.handleInit(rootDir, options);
}


export { run };
export default {
  run
};

