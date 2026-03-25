import shared from './shared.js';

function run(rootDir, options) {
  return shared.handleStatus(rootDir, options);
}


export { run };
export default {
  run
};

