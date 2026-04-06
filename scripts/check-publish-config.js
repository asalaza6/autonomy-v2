import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolvePublishConfig } from './publish-config.js';

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

  return loaded;
}

function buildNpmEnv() {
  const env = { ...process.env };
  const publishConfig = resolvePublishConfig(env);

  if (!env.NPM_TOKEN) {
    return { env, cleanup: () => {}, publishConfig };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-npmrc-'));
  const userConfigPath = path.join(tempDir, '.npmrc');
  writeFileSync(userConfigPath, publishConfig.userConfigContent.replace('${NPM_TOKEN}', env.NPM_TOKEN));

  env.NPM_CONFIG_USERCONFIG = userConfigPath;
  env.npm_config_userconfig = userConfigPath;

  return {
    env,
    cleanup: () => rmSync(tempDir, { force: true, recursive: true }),
    publishConfig
  };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const loadedEnvFiles = loadPublishEnv();
const { env, cleanup, publishConfig } = buildNpmEnv();

try {
  const username = execFileSync(
    'npm',
    ['whoami', `--registry=${publishConfig.registry}`],
    {
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  ).trim();

  if (!username) {
    fail(
      'npm publish preflight failed: `npm whoami` returned an empty username. Check your npm auth before releasing.'
    );
  }

  if (loadedEnvFiles.length) {
    console.log(`Loaded publish env from ${loadedEnvFiles.join(', ')}.`);
  }
  console.log(`npm publish preflight passed for "${username}" via ${publishConfig.registry}.`);
} catch (error) {
  const details =
    error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);

  fail(
    [
      'npm publish preflight failed: this shell is not authenticated to npmjs.org.',
      `Resolved registry: ${publishConfig.registry}`,
      'Set `NPM_TOKEN` in `.env.publish.local` or `.env.publish`, or run `npm login`, then retry.',
      loadedEnvFiles.length ? `Loaded env: ${loadedEnvFiles.join(', ')}.` : 'Loaded env: none.',
      process.env.NPM_TOKEN ? 'NPM_TOKEN was present.' : 'NPM_TOKEN was missing.',
      details ? `npm said: ${details}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  );
} finally {
  cleanup();
}
