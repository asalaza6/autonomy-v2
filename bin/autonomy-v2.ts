#!/usr/bin/env node

import { main } from '../src/autonomy-v2/index.js';

Promise.resolve(main(process.argv.slice(2))).catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
