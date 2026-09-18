import type { CliOptions } from '../../types.js';
import { run as initRun } from './init.js';

function run(rootDir: string, options: CliOptions) {
  const refreshOptions = {
    ...options,
    force: true,
  };

  return initRun(rootDir, refreshOptions);
}

export { run };
