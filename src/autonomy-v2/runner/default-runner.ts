#!/usr/bin/env node

import { main, publishRunnerFailure } from './index.js';
import { fileURLToPath } from 'url';

export * from './index.js';

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const summary = publishRunnerFailure(error);
    console.error(`ERROR: ${summary}`);
    process.exit(1);
  });
}
