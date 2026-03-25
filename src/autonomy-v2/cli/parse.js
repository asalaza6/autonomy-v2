import shared from '../commands/shared.js';


const isMutatingCommand = shared.isMutatingCommand;
export { isMutatingCommand };
const parseCli = shared.parseCli;
export { parseCli };
const resolveRootDir = shared.resolveRootDir;
export { resolveRootDir };
export default {
  isMutatingCommand: shared.isMutatingCommand,
  parseCli: shared.parseCli,
  resolveRootDir: shared.resolveRootDir
};

