import fs from 'node:fs';

const source = new URL('../control-presets/', import.meta.url);
const destination = new URL('../dist/control-presets/', import.meta.url);
for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const options = new URL(`${entry.name}/options.json`, source);
  if (!fs.existsSync(options)) continue;
  const target = new URL(`${entry.name}/options.json`, destination);
  fs.mkdirSync(new URL('.', target), { recursive: true });
  fs.copyFileSync(options, target);
}
