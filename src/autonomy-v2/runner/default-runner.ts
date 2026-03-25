#!/usr/bin/env node

import runner from './index.js';
import { fileURLToPath } from 'url';

export * from './index.js';
export default runner;
export { runner };

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runner.main().catch((error) => {
    const summary = runner.publishRunnerFailure(error);
    console.error(`ERROR: ${summary}`);
    process.exit(1);
  });
}
