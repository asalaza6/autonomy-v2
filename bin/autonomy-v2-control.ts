#!/usr/bin/env node

import { main } from '../src/server/control-plane/control-plane-main.js';
import { fileURLToPath } from 'url';

async function run(argv = process.argv.slice(2)) {
  return main(argv);
}

export { run as main };

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
