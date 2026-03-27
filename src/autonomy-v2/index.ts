#!/usr/bin/env node

import { main as commandsMain } from './commands/commands-main.js';
import { fileURLToPath } from 'url';

async function main(argv = process.argv.slice(2)) {
  return commandsMain(argv);
}


export { main };

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
