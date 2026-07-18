#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { main as cliMain } from '../cli.js';
import { extractError } from '../runtime.js';

async function main(argv = process.argv.slice(2)) {
  return cliMain(argv);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${extractError(error)}`);
    process.exit(1);
  });
}

export { main };
export type * from '../types.js';
