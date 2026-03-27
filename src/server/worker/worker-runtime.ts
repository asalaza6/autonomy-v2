#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { main as runtimeMain } from './worker-runtime-core.js';

async function main(argv: string[] = process.argv.slice(2)) {
  return runtimeMain(argv);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}

export { main };
