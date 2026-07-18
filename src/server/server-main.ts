#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { main as serverMain } from '../server.js';
import { extractError } from '../runtime.js';

async function main(argv = process.argv.slice(2)) {
  return serverMain(argv);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${extractError(error)}`);
    process.exit(1);
  });
}

export { main };
export type * from '../types.js';
