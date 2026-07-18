#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { main as cliMain } from '../cli.js';
import { extractError } from '../runtime.js';

async function main(argv = process.argv.slice(2)) {
  return cliMain(argv);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  main(argv).catch((error) => {
    const message = extractError(error);
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: { message } }, null, 2)}\n`);
    } else {
      console.error(`ERROR: ${message}`);
    }
    process.exit(1);
  });
}

export { main };
export type * from '../types.js';
