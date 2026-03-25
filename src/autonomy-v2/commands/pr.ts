import { handlePrRecord } from './shared.js';

async function run(rootDir, options) {
  return handlePrRecord(rootDir, options);
}


export { run };
