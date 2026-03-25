import shared from './shared.js';

function run(rootDir, options) {
  return shared.handleScopeValidate(rootDir, options);
}


export { run };
export default {
  run
};

