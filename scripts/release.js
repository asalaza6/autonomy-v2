import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const mode = process.argv[2];
const cwd = process.cwd();
const envFiles = ['.env.publish.local', '.env.publish'];

function parseEnvFile(content) {
  const values = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      values[key] = value;
    }
  }

  return values;
}

function loadPublishEnv() {
  const loaded = [];

  for (const file of envFiles) {
    const fullPath = path.join(cwd, file);
    if (!existsSync(fullPath)) {
      continue;
    }

    const parsed = parseEnvFile(readFileSync(fullPath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
    loaded.push(file);
  }

  if (loaded.length) {
    console.log(`Loaded publish env from ${loaded.join(', ')}.`);
  }
}

function runNpm(args) {
  execFileSync('npm', args, {
    cwd,
    env: process.env,
    stdio: 'inherit'
  });
}

if (!['patch', 'minor', 'major', 'tag'].includes(mode)) {
  console.error('Usage: node scripts/release.js <patch|minor|major|tag>');
  process.exit(1);
}

loadPublishEnv();
runNpm(['run', 'check:publish']);
runNpm(['run', 'smoke']);

if (mode === 'tag') {
  const tag = process.env.npm_config_tag || 'latest';
  runNpm(['publish', '--access', 'public', '--tag', tag]);
  process.exit(0);
}

runNpm(['version', mode]);
runNpm(['publish', '--access', 'public']);
