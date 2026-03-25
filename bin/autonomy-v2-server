#!/usr/bin/env node

import server from '../src/server/index.js';

Promise.resolve(server.main(process.argv.slice(2))).catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});

