import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveControlDefinition } from './control-config.js';
import type { LocalAction } from './runtime-types.js';

export type ActionPreset = string;
export interface ActionModule {
  default: Record<string, LocalAction>;
  execution?: 'inline' | 'worker';
}
export type ActionModuleLoader = (modulePath: string) => Promise<ActionModule>;
export interface ActionRegistryOptions {
  presets?: ActionPreset[];
  modules?: { path: string; options?: Record<string, unknown> }[];
  importModule?: ActionModuleLoader;
  overrides?: Record<string, LocalAction | null>;
}

export async function loadActionModule(modulePath: string): Promise<ActionModule> {
  if (/\.[cm]?tsx?$/.test(modulePath)) throw new Error('TypeScript action modules require a host importModule loader; worker actions require compiled JavaScript.');
  return import(pathToFileURL(modulePath).href);
}

function runWorker(modulePath: string, name: string, input: unknown, settings: Record<string, unknown>, context: Parameters<LocalAction['run']>[1]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./action-worker.js', import.meta.url))], {
      cwd: context.rootDir, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-1048576); context.log(data.toString()); });
    child.stderr.on('data', (data: Buffer) => context.log(data.toString()));
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) return reject(new Error(`${name} failed (${signal || code}). See operation logs.`));
      try { resolve(JSON.parse(output)); } catch { resolve({ output: output.trim() }); }
    });
    child.stdin.end(JSON.stringify({ modulePath, name, input, options: settings, rootDir: context.rootDir }));
  });
}

export async function createActionRegistry(options: ActionRegistryOptions = {}): Promise<Record<string, LocalAction>> {
  const registry: Record<string, LocalAction> = Object.create(null);
  const modules = options.modules ?? (options.presets ?? ['shared']).map((preset) => {
    const definition = resolveControlDefinition({ preset }, process.cwd());
    if (!definition.actions) throw new Error(`Control preset has no actions: ${preset}`);
    return { path: definition.actions, options: definition.options };
  });
  for (const reference of modules) {
    const module = await (options.importModule || loadActionModule)(reference.path);
    if (!module.default || typeof module.default !== 'object' || Array.isArray(module.default)) throw new Error(`Action module must default-export named actions: ${reference.path}`);
    if (module.execution !== undefined && !['worker', 'inline'].includes(module.execution)) throw new Error('Invalid action module execution mode.');
    if (module.execution === 'worker' && /\.[cm]?tsx?$/.test(reference.path)) throw new Error('Worker actions require compiled JavaScript.');
    for (const [name, action] of Object.entries(module.default)) {
      if (typeof action?.validate !== 'function' || typeof action?.run !== 'function') throw new Error(`Invalid action definition: ${name}`);
      registry[name] = {
        validate: action.validate,
        lockKey: action.lockKey,
        run: (input, context) => module.execution === 'worker'
          ? runWorker(reference.path, name, input, reference.options || {}, context)
          : action.run(input, { ...context, options: reference.options || {} }),
      };
    }
  }
  for (const [name, action] of Object.entries(options.overrides || {})) {
    if (action === null) delete registry[name];
    else registry[name] = action;
  }
  return registry;
}
