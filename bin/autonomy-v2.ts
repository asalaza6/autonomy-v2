#!/usr/bin/env node

import { main } from '../src/autonomy-v2/index.js';
import { extractError } from '../src/runtime.js';

main(process.argv.slice(2)).catch((error) => {
  console.error(`ERROR: ${extractError(error)}`);
  process.exit(1);
});
