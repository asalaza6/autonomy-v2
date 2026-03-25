#!/usr/bin/env node

const runtime = require('./runtime');

async function main(argv = process.argv.slice(2)) {
  return runtime.main(argv);
}

module.exports = {
  main,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
