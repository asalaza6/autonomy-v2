#!/usr/bin/env node

import { main } from '../src/autonomy-v2/index.js';
import { extractError } from '../src/runtime.js';

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
