#!/usr/bin/env node

import runtime from './runtime.js';
import { fileURLToPath } from 'url';

async function main(argv = process.argv.slice(2)) {
  return runtime.main(argv);
}


export { main };
export default {
  main
};

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
