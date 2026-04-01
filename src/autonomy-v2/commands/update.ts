import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { AnyRecord, CliOptions } from '../autonomy-types.js';
import { getAutonomyPaths, getStringOption, printOutput, readJson } from './shared-core.js';

const PACKAGE_NAME = '@asalaza6/autonomy-v2';
const SUPPORTED_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn']);

type PackageManager = 'npm' | 'pnpm' | 'yarn';
type DependencyType = 'dependency' | 'devDependency' | 'optionalDependency';

interface CommandSpec {
  file: string;
  args: string[];
}

interface RefreshSkipped {
  skipped: true;
  reason: string;
}

interface RefreshApplied {
  skipped: false;
  result: AnyRecord | null;
  raw?: string;
}

type RefreshResult = RefreshSkipped | RefreshApplied;

function run(rootDir: string, options: CliOptions) {
  const manifestPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Missing package.json at ${manifestPath}. Run "autonomy-v2 update" from a Node project root or pass --root.`);
  }

  const manifest = readJson<AnyRecord>(manifestPath, {});
  const packageManager = resolvePackageManager(rootDir, options, manifest);
  const dependencyType = resolveDependencyType(manifest);
  const previousVersion = resolveDeclaredVersion(manifest);
  const installCommand = buildInstallCommand(packageManager, dependencyType, `${PACKAGE_NAME}@latest`);

  execCommand(installCommand.file, installCommand.args, rootDir);

  const updatedManifest = readJson<AnyRecord>(manifestPath, {});
  const declaredVersion = resolveDeclaredVersion(updatedManifest);
  const installedVersion = readInstalledVersion(rootDir);
  const initialized = fs.existsSync(getAutonomyPaths(rootDir).agentsConfig);
  const shouldRefresh = initialized && options['skip-init'] !== true;
  const refresh: RefreshResult = shouldRefresh
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

function resolvePackageManager(rootDir: string, options: CliOptions, manifest: AnyRecord): PackageManager {
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

function assertSupportedPackageManager(value: string, source: string): PackageManager {
  if (SUPPORTED_PACKAGE_MANAGERS.has(value)) {
    return value as PackageManager;
  }
  throw new Error(`Unsupported package manager "${value}" from ${source}. Supported values: npm, pnpm, yarn.`);
}

function resolveDependencyType(manifest: AnyRecord): DependencyType {
  // Keep autonomy-v2 out of the hard install path so consumers can omit it on
  // hosted builds that do not have GitHub Packages auth available.
  return 'optionalDependency';
}

function resolveDeclaredVersion(manifest: AnyRecord): string {
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

function buildInstallCommand(
  packageManager: PackageManager,
  dependencyType: DependencyType,
  packageSpec: string
): CommandSpec {
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

function readInstalledVersion(rootDir: string): string {
  const installedManifestPath = path.join(rootDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'package.json');
  if (!fs.existsSync(installedManifestPath)) {
    return '';
  }
  const installedManifest = readJson<AnyRecord>(installedManifestPath, {});
  return String(installedManifest.version || '');
}

function runRefresh(rootDir: string, packageManager: PackageManager): RefreshResult {
  const installedCliPath = path.join(rootDir, 'node_modules', ...PACKAGE_NAME.split('/'), 'dist', 'bin', 'autonomy-v2.js');
  let result = '';
  if (fs.existsSync(installedCliPath)) {
    result = execCommand(process.execPath, [installedCliPath, 'init', '--root', rootDir, '--force', '--json'], rootDir);
  } else {
    const refreshCommand = buildRefreshCommand(packageManager, rootDir);
    result = execCommand(refreshCommand.file, refreshCommand.args, rootDir);
  }

  try {
    return {
      skipped: false,
      result: JSON.parse(result || '{}') as AnyRecord,
    };
  } catch (_) {
    return {
      skipped: false,
      result: null,
      raw: result,
    };
  }
}

function buildRefreshCommand(packageManager: PackageManager, rootDir: string): CommandSpec {
  if (packageManager === 'pnpm') {
    return {
      file: 'pnpm',
      args: ['exec', 'autonomy-v2', 'init', '--root', rootDir, '--force', '--json'],
    };
  }
  if (packageManager === 'yarn') {
    return {
      file: 'yarn',
      args: ['run', 'autonomy-v2', 'init', '--root', rootDir, '--force', '--json'],
    };
  }
  return {
    file: 'npm',
    args: ['exec', '--', 'autonomy-v2', 'init', '--root', rootDir, '--force', '--json'],
  };
}

function execCommand(file: string, args: string[], cwd: string): string {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer; stdout?: string | Buffer };
    const detail = String(failure.stderr || failure.stdout || failure.message || '').trim();
    const renderedCommand = [file, ...args].join(' ');
    throw new Error(`Failed to run "${renderedCommand}": ${detail || 'command failed'}`);
  }
}

export { run };
