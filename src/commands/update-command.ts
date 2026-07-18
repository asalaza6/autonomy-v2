import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { CliOptions, JsonRecord } from '../types.js';

const PACKAGE_NAME = '@asalaza6/autonomy-v2';
const CUSTOM_AGENT_CONFIG_PATH = path.join(
  'prompts',
  'autonomous',
  'v2',
  'config',
  'custom-agents.json'
);
const SUPPORTED_PACKAGE_MANAGERS = new Set<PackageManager>(['npm', 'pnpm', 'yarn']);

type PackageManager = 'npm' | 'pnpm' | 'yarn';
type DependencyType = 'optionalDependency';

type CommandSpec = {
  file: string;
  args: string[];
};

type CommandRunner = (file: string, args: string[], cwd: string) => string;

type UpdateCommandDependencies = {
  runCommand?: CommandRunner;
};

type RefreshSkipped = {
  skipped: true;
  reason: 'skip-init' | 'not-initialized';
};

type RefreshApplied = {
  skipped: false;
  result: JsonRecord | null;
  raw?: string;
};

type RefreshResult = RefreshSkipped | RefreshApplied;

type UpdatePayload = {
  rootDir: string;
  packageName: string;
  packageManager: PackageManager;
  dependencyType: DependencyType;
  previousVersion: string;
  declaredVersion: string;
  previousDeclaredVersion: string;
  newDeclaredVersion: string;
  installedVersion: string;
  refreshed: boolean;
  refreshStatus: 'applied' | 'skipped';
  refresh: RefreshResult;
  errors: string[];
};

function runUpdate(
  rootDir: string,
  options: CliOptions = {},
  dependencies: UpdateCommandDependencies = {}
): UpdatePayload {
  const manifestPath = path.join(rootDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Missing package.json at ${manifestPath}. Run "autonomy-v2 update" from a Node project root or pass --root.`
    );
  }

  const runCommand = dependencies.runCommand || executeCommand;
  const manifest = readJson(manifestPath);
  const packageManager = resolvePackageManager(rootDir, options, manifest);
  const dependencyType: DependencyType = 'optionalDependency';
  const previousVersion = resolveDeclaredVersion(manifest);
  const installCommand = buildInstallCommand(packageManager, `${PACKAGE_NAME}@latest`);

  runCommand(installCommand.file, installCommand.args, rootDir);

  const updatedManifest = readJson(manifestPath);
  const declaredVersion = resolveDeclaredVersion(updatedManifest);
  const installedVersion = readInstalledVersion(rootDir);
  const initialized = fs.existsSync(path.join(rootDir, CUSTOM_AGENT_CONFIG_PATH));
  const shouldRefresh = initialized && options['skip-init'] !== true;
  const refresh = shouldRefresh
    ? runRefresh(rootDir, packageManager, runCommand)
    : {
      skipped: true as const,
      reason: initialized ? 'skip-init' as const : 'not-initialized' as const,
    };
  const refreshStatus = refresh.skipped ? 'skipped' : 'applied';

  return {
    rootDir,
    packageName: PACKAGE_NAME,
    packageManager,
    dependencyType,
    previousVersion,
    declaredVersion,
    previousDeclaredVersion: previousVersion,
    newDeclaredVersion: declaredVersion,
    installedVersion,
    refreshed: !refresh.skipped,
    refreshStatus,
    refresh,
    errors: [],
  };
}

function runRefresh(
  rootDir: string,
  packageManager: PackageManager,
  runCommand: CommandRunner
): RefreshApplied {
  const refreshCommand = fs.existsSync(getInstalledCliPath(rootDir))
    ? buildRefreshCommand(rootDir)
    : buildPackageManagerRefreshCommand(packageManager, rootDir);
  const raw = runCommand(refreshCommand.file, refreshCommand.args, rootDir).trim();
  return parseRefreshOutput(raw);
}

function resolvePackageManager(
  rootDir: string,
  options: CliOptions,
  manifest: JsonRecord
): PackageManager {
  return selectPackageManager({
    override: getStringOption(options, 'package-manager'),
    manifestPackageManager: String(manifest.packageManager || ''),
    hasPnpmLock: fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml')),
    hasYarnLock: fs.existsSync(path.join(rootDir, 'yarn.lock')),
  });
}

function selectPackageManager(input: {
  override?: string;
  manifestPackageManager?: string;
  hasPnpmLock?: boolean;
  hasYarnLock?: boolean;
}): PackageManager {
  const override = String(input.override || '').trim().toLowerCase();
  if (override) {
    return assertSupportedPackageManager(override, '--package-manager');
  }

  const manifestPackageManager = String(input.manifestPackageManager || '').trim().toLowerCase();
  if (manifestPackageManager) {
    return assertSupportedPackageManager(
      manifestPackageManager.split('@')[0],
      'package.json packageManager'
    );
  }

  if (input.hasPnpmLock) return 'pnpm';
  if (input.hasYarnLock) return 'yarn';
  return 'npm';
}

function assertSupportedPackageManager(value: string, source: string): PackageManager {
  if (SUPPORTED_PACKAGE_MANAGERS.has(value as PackageManager)) {
    return value as PackageManager;
  }
  throw new Error(
    `Unsupported package manager "${value}" from ${source}. Supported values: npm, pnpm, yarn.`
  );
}

function buildInstallCommand(
  packageManager: PackageManager,
  packageSpec = `${PACKAGE_NAME}@latest`
): CommandSpec {
  if (packageManager === 'pnpm') {
    return {
      file: 'pnpm',
      args: ['add', '--save-optional', packageSpec],
    };
  }
  if (packageManager === 'yarn') {
    return {
      file: 'yarn',
      args: ['add', '--optional', packageSpec],
    };
  }
  return {
    file: 'npm',
    args: ['install', '--save-optional', packageSpec],
  };
}

function buildRefreshCommand(
  rootDir: string,
  nodeExecutable = process.execPath
): CommandSpec {
  return {
    file: nodeExecutable,
    args: [
      getInstalledCliPath(rootDir),
      'refresh',
      '--root',
      rootDir,
      '--json',
    ],
  };
}

function buildPackageManagerRefreshCommand(
  packageManager: PackageManager,
  rootDir: string
): CommandSpec {
  const args = ['autonomy-v2', 'refresh', '--root', rootDir, '--json'];
  if (packageManager === 'pnpm') {
    return { file: 'pnpm', args: ['exec', ...args] };
  }
  if (packageManager === 'yarn') {
    return { file: 'yarn', args: ['run', ...args] };
  }
  return { file: 'npm', args: ['exec', '--', ...args] };
}

function getInstalledCliPath(rootDir: string): string {
  return path.join(
    rootDir,
    'node_modules',
    ...PACKAGE_NAME.split('/'),
    'dist',
    'bin',
    'autonomy-v2.js'
  );
}

function resolveDeclaredVersion(manifest: JsonRecord): string {
  if (manifest.devDependencies?.[PACKAGE_NAME]) {
    return String(manifest.devDependencies[PACKAGE_NAME]);
  }
  if (manifest.dependencies?.[PACKAGE_NAME]) {
    return String(manifest.dependencies[PACKAGE_NAME]);
  }
  if (manifest.optionalDependencies?.[PACKAGE_NAME]) {
    return String(manifest.optionalDependencies[PACKAGE_NAME]);
  }
  return '';
}

function parseRefreshOutput(raw: string): RefreshApplied {
  try {
    return {
      skipped: false,
      result: JSON.parse(raw || '{}') as JsonRecord,
    };
  } catch {
    return {
      skipped: false,
      result: null,
      raw,
    };
  }
}

function readInstalledVersion(rootDir: string): string {
  const installedManifestPath = path.join(
    rootDir,
    'node_modules',
    ...PACKAGE_NAME.split('/'),
    'package.json'
  );
  if (!fs.existsSync(installedManifestPath)) return '';
  return String(readJson(installedManifestPath).version || '');
}

function readJson(filePath: string): JsonRecord {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as JsonRecord;
}

function getStringOption(options: CliOptions, key: string): string {
  const value = options[key];
  return typeof value === 'string' ? value : '';
}

function executeCommand(file: string, args: string[], cwd: string): string {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const failure = error as Error & {
      stderr?: string | Buffer;
      stdout?: string | Buffer;
    };
    const detail = String(failure.stderr || failure.stdout || failure.message || '').trim();
    throw new Error(
      `Failed to run "${[file, ...args].join(' ')}": ${detail || 'command failed'}`
    );
  }
}

export {
  CUSTOM_AGENT_CONFIG_PATH,
  PACKAGE_NAME as AUTONOMY_PACKAGE_NAME,
  buildInstallCommand,
  buildPackageManagerRefreshCommand,
  buildRefreshCommand,
  getInstalledCliPath,
  parseRefreshOutput,
  resolveDeclaredVersion,
  runUpdate,
  selectPackageManager,
};

export type {
  CommandRunner,
  CommandSpec,
  PackageManager,
  RefreshResult,
  UpdateCommandDependencies,
  UpdatePayload,
};
