#!/usr/bin/env node

const commands = require('./commands');

async function main(argv = process.argv.slice(2)) {
  return commands.main(argv);
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
