import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ControlDefinition { preset?: string; frontend?: string; actions?: string; options?: string }
export interface ResolvedControlDefinition { preset?: string; frontend?: string; actions?: string; optionsPath?: string; options: Record<string, unknown> }

function presetDirectory(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error(`Unknown action preset: ${name}`);
  const directory = fileURLToPath(new URL(`../../control-presets/${name}/`, import.meta.url));
  if (!fs.existsSync(directory)) throw new Error(`Unknown action preset: ${name}`);
  return directory;
}

export function resolveControlDefinition(value: unknown, rootDir: string): ResolvedControlDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('controls must be an object.');
  const definition = value as ControlDefinition;
  for (const [key, reference] of Object.entries(definition)) {
    if (!['preset', 'frontend', 'actions', 'options'].includes(key)) throw new Error(`Unknown controls field: ${key}`);
    if (typeof reference !== 'string' || !reference.trim() || reference.includes('\0')) throw new Error(`controls.${key} must be a nonempty path or preset name.`);
  }
  const directory = definition.preset ? presetDirectory(definition.preset) : undefined;
  const defaults = (name: string) => directory && fs.existsSync(path.join(directory, name)) ? path.join(directory, name) : undefined;
  const optionsPath = definition.options ? path.resolve(rootDir, definition.options) : defaults('options.json');
  const settings = optionsPath ? JSON.parse(fs.readFileSync(optionsPath, 'utf8')) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Control options must be an object.');
  return {
    preset: definition.preset,
    frontend: definition.frontend ? path.resolve(rootDir, definition.frontend) : defaults('frontend.js'),
    actions: definition.actions ? path.resolve(rootDir, definition.actions) : defaults('actions.js'),
    optionsPath,
    options: settings,
  };
}
