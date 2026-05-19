import { run as initRun } from './init.js';
import type { CliOptions } from '../autonomy-types.js';

function run(rootDir: string, options: CliOptions) {
  const refreshOptions = {
    ...options,
    force: true,
  };

  return initRun(rootDir, refreshOptions);
}

export { run };
