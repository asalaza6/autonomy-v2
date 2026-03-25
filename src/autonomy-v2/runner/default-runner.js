#!/usr/bin/env node

const runner = require('.');

module.exports = runner;

if (require.main === module) {
  runner.main().catch((error) => {
    const summary = runner.publishRunnerFailure(error);
    console.error(`ERROR: ${summary}`);
    process.exit(1);
  });
}
