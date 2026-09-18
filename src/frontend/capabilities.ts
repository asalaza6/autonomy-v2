import { run as controlServer } from '../server/server-controller.js';
import { runCodexStructured } from '../codex/cli.js';
import { setCustomAgentEnabledOverride } from '../server/orchestrator/custom-agents.js';
import type { ActionCapabilities } from './runtime-types.js';

/** Generic host facilities available equally to repository and packaged controls. */
export function createActionCapabilities(rootDir: string): ActionCapabilities {
  return {
    controlServer: (command, options) => controlServer(rootDir, options, command),
    executeModel: (request) => runCodexStructured({ ...request, cwd: rootDir, readOnly: request.readOnly === true }),
    setAgentEnabled: (key, enabled) => setCustomAgentEnabledOverride(rootDir, key, enabled),
  };
}
