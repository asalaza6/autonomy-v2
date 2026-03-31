import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { getAutonomyPaths, getStringOption, printOutput, readJson } from './shared-core.js';

const PACKAGE_NAME = '@asalaza6/autonomy-v2';
const SUPPORTED_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);

function run(rootDir, options) {
  const manifestPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing package.json at ${manifestPath}. Run "autonomy-v2 update" from a Node project root or pass --root.`);
  }

  const manifest = readJson(manifestPath, {});
  const packageManager = resolvePackageManager(rootDir, options, manifest);
  const dependencyType = resolveDependencyType(manifest);
  const previousVersion = resolveDeclaredVersion(manifest);
  const installCommand = buildInstallCommand(packageManager, dependencyType, `${PACKAGE_NAME}@latest`);

  execCommand(installCommand.file, installCommand.args, rootDir);

  const updatedManifest = readJson(manifestPath, {});
  const declaredVersion = resolveDeclaredVersion(updatedManifest);
  const installedVersion = readInstalledVersion(rootDir);
  const initialized = fs.existsSync(getAutonomyPaths(rootDir).agentsConfig);
  const shouldRefresh = initialized && options['skip-init'] !== true;
  const refresh = shouldRefresh
    ? runRefresh(rootDir, packageManager)
    : {
      skipped: true,
      reason: initialized ? 'skip-init' : 'not-initialized',
    };

  const payload = {
    rootDir,
    packageName: PACKAGE_NAME,
    packageManager,
    dependencyType,
    previousVersion,
    declaredVersion,
    installedVersion,
    refreshed: refresh.skipped !== true,
    refresh,
  };

  printOutput(options, payload, () => {
    console.log(`Updated ${PACKAGE_NAME} with ${packageManager}.`);
    console.log(`Declared version: ${declaredVersion || '(unchanged)'}`);
    if (installedVersion) {
      console.log(`Installed version: ${installedVersion}`);
    }
    if (refresh.skipped === true) {
      console.log(`Scaffold refresh: skipped (${refresh.reason})`);
      return;
    }
    console.log('Scaffold refresh: applied via init --force');
  });
}

function resolvePackageManager(rootDir, options, manifest) {
  const override = getStringOption(options, 'package-manager', '').trim().toLowerCase();
  if (override) {
    return assertSupportedPackageManager(override, '--package-manager');
  }

  const manifestPackageManager = String(manifest.packageManager || '').trim().toLowerCase();
  if (manifestPackageManager) {
    return assertSupportedPackageManager(manifestPackageManager.split('@')[0], 'package.json packageManager');
  }

  if (fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) {
    return 'yarn';
  }
  return 'npm';
}

function assertSupportedPackageManager(value, source) {
  if (SUPPORTED_PACKAGE_MANAGERS.has(value)) {
    return value;
  }
  throw new Error(`Unsupported package manager "${value}" from ${source}. Supported values: npm, pnpm, yarn.`);
}

function resolveDependencyType(manifest) {
  if (manifest.devDependencies && manifest.devDependencies[PACKAGE_NAME]) {
    return 'devDependency';
  }
  if (manifest.dependencies && manifest.dependencies[PACKAGE_NAME]) {
    return 'dependency';
  }
  if (manifest.optionalDependencies && manifest.optionalDependencies[PACKAGE_NAME]) {
    return 'optionalDependency';
  }
  return 'devDependency';
}

function resolveDeclaredVersion(manifest) {
  if (manifest.devDependencies && manifest.devDependencies[PACKAGE_NAME]) {
    return String(manifest.devDependencies[PACKAGE_NAME]);
  }
  if (manifest.dependencies && manifest.dependencies[PACKAGE_NAME]) {
    return String(manifest.dependencies[PACKAGE_NAME]);
  }
  if (manifest.optionalDependencies && manifest.optionalDependencies[PACKAGE_NAME]) {
    return String(manifest.optionalDependencies[PACKAGE_NAME]);
  }
  return '';
}

function buildInstallCommand(packageManager, dependencyType, packageSpec) {
  if (packageManager === 'pnpm') {
    return {
      file: 'pnpm',
      args: dependencyType === 'dependency'
        ? ['add', packageSpec]
        : dependencyType === 'optionalDependency'
          ? ['add', '--save-optional', packageSpec]
          : ['add', '-D', packageSpec],
    };
  }

  if (packageManager === 'yarn') {
    return {
      file: 'yarn',
      args: dependencyType === 'dependency'
        ? ['add', packageSpec]
        : dependencyType === 'optionalDependency'
          ? ['add', '--optional', packageSpec]
          : ['add', '-D', packageSpec],
    };
  }

  return {
    file: 'npm',
    args: dependencyType === 'dependency'
      ? ['install', packageSpec]
      : dependencyType === 'optionalDependency'
        ? ['install', '--save-optional', packageSpec]
        : ['install', '--save-dev', packageSpec],
  };
}

function readInstalledVersion(rootDir) {
  const installedManifestPath = path.join(rootDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json');
  if (!fs.existsSync(installedManifestPath)) {
    return '';
  }
  const installedManifest = readJson(installedManifestPath, {});
  return String(installedManifest.version || '');
}

function runRefresh(rootDir, packageManager) {
  const installedCliPath = path.join(rootDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'dist', 'bin', 'autonomy-v2.js');
  const result = fs.existsSync(installedCliPath)
    ? execCommand(process.execPath, [installedCliPath, 'init', '--root', rootDir, '--force', '--json'], rootDir)
    : execCommand(...buildRefreshCommand(packageManager, rootDir), rootDir);

  try {
    return {
      skipped: false,
      result: JSON.parse(result || '{}'),
    };
  } catch (_) {
    return {
      skipped: false,
      result: null,
      raw: result,
    };
  }
}

function buildRefreshCommand(packageManager, rootDir): [string, string[]] {
  if (packageManager === 'pnpm') {
    return ['pnpm', ['exec', 'autonomy-v2', 'init', '--root', rootDir, '--force', '--json']];
  }
  if (packageManager === 'yarn') {
    return ['yarn', ['run', 'autonomy-v2', 'init', '--root', rootDir, '--force', '--json']];
  }
  return ['npm', ['exec', '--', 'autonomy-v2', 'init', '--root', rootDir, '--force', '--json']];
}

function execCommand(file, args, cwd) {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    const renderedCommand = [file, ...args].join(' ');
    throw new Error(`Failed to run "${renderedCommand}": ${detail || 'command failed'}`);
  }
}

export { run };
