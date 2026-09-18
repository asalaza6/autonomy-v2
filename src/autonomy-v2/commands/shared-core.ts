import fs from 'node:fs';
import path from 'node:path';
export function ensureDir(directory: string) { fs.mkdirSync(directory, { recursive: true }); }
export function ensureInitialized(root: string) {
  if (!fs.existsSync(path.join(root, 'prompts/autonomous/v2/config/control-plane.json'))) throw new Error('Initialize this repository with autonomy-v2 init first.');
}
export function requireOption(options, name: string) {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required --${name}.`);
  return value;
}
export function printOutput(options, payload, text: () => void) {
  if (options.json === true) console.log(JSON.stringify(payload, null, 2));
  else text();
}
