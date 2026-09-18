import fs from 'node:fs';
import path from 'node:path';
import { createLocalRuntime } from './local-runtime.js';
import { createActionRegistry, type ActionPreset } from './actions.js';
import type { FrontendContext, LocalAction } from './runtime-types.js';

/** The host creates one runtime for a repository; configuration selects its actions. */
export function createFrontendRuntime(options: {
  rootDir: string;
  configPath?: string;
  agentKey?: string;
  actionOverrides?: Record<string, LocalAction | null>;
}) {
  const rootDir = path.resolve(options.rootDir);
  const configPath = options.configPath || 'prompts/autonomous/v2/config/control-plane.json';
  const config = JSON.parse(fs.readFileSync(path.resolve(rootDir, configPath), 'utf8'));
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Frontend configuration must be an object.');
  }
  const presets = config.actionPresets ?? ['shared'];
  if (!Array.isArray(presets) || presets.some((preset) => typeof preset !== 'string')) {
    throw new Error('actionPresets must be an array of preset names.');
  }
  const runtime = createLocalRuntime({
    rootDir,
    actions: createActionRegistry({ presets: presets as ActionPreset[], overrides: options.actionOverrides }),
  });
  const context: FrontendContext = {
    repository: {
      id: String(config.repoId || path.basename(rootDir)),
      rootDir,
      name: String(config.label || path.basename(rootDir)),
    },
    ...(options.agentKey ? { agentKey: options.agentKey } : {}),
  };
  return { runtime, context, configPath };
}
