import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
const GITHUB_PACKAGES_REGISTRY = 'https://npm.pkg.github.com/';

function getPackageName() {
  const packageJsonPath = path.join(process.cwd(), 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  return packageJson.name;
}

export function resolvePublishConfig(env = process.env) {
  const packageName = getPackageName();
  const scope = packageName.startsWith('@') ? packageName.slice(1).split('/')[0] : null;
  const token = env.NPM_TOKEN ?? '';
  const forcedRegistry = env.NPM_PUBLISH_REGISTRY?.trim();

  const registry = forcedRegistry
    ? forcedRegistry.endsWith('/') ? forcedRegistry : `${forcedRegistry}/`
    : token.startsWith('ghp_') || token.startsWith('github_pat_')
      ? GITHUB_PACKAGES_REGISTRY
      : NPMJS_REGISTRY;

  const authLine = registry === GITHUB_PACKAGES_REGISTRY
    ? '//npm.pkg.github.com/:_authToken=${NPM_TOKEN}'
    : '//registry.npmjs.org/:_authToken=${NPM_TOKEN}';

  const userConfigLines = [`registry=${registry}`, authLine];

  if (registry === GITHUB_PACKAGES_REGISTRY && scope) {
    userConfigLines.unshift(`@${scope}:registry=${registry}`);
  }

  return {
    packageName,
    registry,
    scope,
    isGitHubPackages: registry === GITHUB_PACKAGES_REGISTRY,
    userConfigContent: userConfigLines.join('\n')
  };
}
