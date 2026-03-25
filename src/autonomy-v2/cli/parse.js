const shared = require('../commands/shared');

module.exports = {
  isMutatingCommand: shared.isMutatingCommand,
  parseCli: shared.parseCli,
  resolveRootDir: shared.resolveRootDir,
};
