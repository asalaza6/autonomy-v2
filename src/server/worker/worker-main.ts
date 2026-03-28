#!/usr/bin/env node

import { main as runtimeMain } from './worker-runtime.js';
import { fileURLToPath } from 'url';

async function main(argv = process.argv.slice(2)) {
  return runtimeMain(argv);
}


export { main };

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
