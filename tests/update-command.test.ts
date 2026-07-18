import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTONOMY_PACKAGE_NAME,
  CUSTOM_AGENT_CONFIG_PATH,
  buildInstallCommand,
  buildPackageManagerRefreshCommand,
  buildRefreshCommand,
  getInstalledCliPath,
  runUpdate,
  selectPackageManager,
  type CommandRunner,
} from '../src/commands/update-command.js';

test('optional install commands are correct for every supported package manager', () => {
  const packageSpec = `${AUTONOMY_PACKAGE_NAME}@latest`;
  assert.deepEqual(buildInstallCommand('npm'), {
    file: 'npm',
    args: ['install', '--save-optional', packageSpec],
  });
  assert.deepEqual(buildInstallCommand('pnpm'), {
    file: 'pnpm',
    args: ['add', '--save-optional', packageSpec],
  });
  assert.deepEqual(buildInstallCommand('yarn'), {
    file: 'yarn',
    args: ['add', '--optional', packageSpec],
  });
});

test('package manager selection honors override, manifest, lockfiles, and validation', () => {
  assert.equal(selectPackageManager({ override: 'PNPM' }), 'pnpm');
  assert.equal(selectPackageManager({ manifestPackageManager: 'yarn@4.9.1' }), 'yarn');
  assert.equal(selectPackageManager({ hasPnpmLock: true, hasYarnLock: true }), 'pnpm');
  assert.equal(selectPackageManager({ hasYarnLock: true }), 'yarn');
  assert.equal(selectPackageManager({}), 'npm');
  assert.throws(
    () => selectPackageManager({ override: 'bun' }),
    /Supported values: npm, pnpm, yarn/
  );
});

test('update installs latest and refreshes an initialized custom-agent repository', () => {
  const rootDir = makeRoot();
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const refreshPayload = {
    rootDir,
    created: [],
    skipped: ['prompts/autonomous/v2/config/custom-agents.json'],
    removed: [],
    updated: [],
  };

  try {
    writeJson(path.join(rootDir, 'package.json'), {
      optionalDependencies: {
        [AUTONOMY_PACKAGE_NAME]: '^1.4.79',
      },
    });
    writeJson(path.join(rootDir, CUSTOM_AGENT_CONFIG_PATH), {
      schemaVersion: 1,
      enabled: true,
      agents: [],
    });

    const runCommand: CommandRunner = (file, args, cwd) => {
      calls.push({ file, args: [...args], cwd });
      if (calls.length === 1) {
        writeJson(path.join(rootDir, 'package.json'), {
          optionalDependencies: {
            [AUTONOMY_PACKAGE_NAME]: '^2.0.0',
          },
        });
        writeJson(path.join(rootDir, 'node_modules', ...AUTONOMY_PACKAGE_NAME.split('/'), 'package.json'), {
          name: AUTONOMY_PACKAGE_NAME,
          version: '2.0.0',
        });
        const installedCliPath = getInstalledCliPath(rootDir);
        fs.mkdirSync(path.dirname(installedCliPath), { recursive: true });
        fs.writeFileSync(installedCliPath, '#!/usr/bin/env node\n', 'utf8');
        return '';
      }
      return JSON.stringify(refreshPayload);
    };

    const payload = runUpdate(rootDir, {}, { runCommand });

    assert.deepEqual(calls, [
      {
        file: 'npm',
        args: ['install', '--save-optional', `${AUTONOMY_PACKAGE_NAME}@latest`],
        cwd: rootDir,
      },
      {
        ...buildRefreshCommand(rootDir),
        cwd: rootDir,
      },
    ]);
    assert.equal(calls[1].args[0], getInstalledCliPath(rootDir));
    assert.deepEqual(payload, {
      rootDir,
      packageName: AUTONOMY_PACKAGE_NAME,
      packageManager: 'npm',
      dependencyType: 'optionalDependency',
      previousVersion: '^1.4.79',
      declaredVersion: '^2.0.0',
      previousDeclaredVersion: '^1.4.79',
      newDeclaredVersion: '^2.0.0',
      installedVersion: '2.0.0',
      refreshed: true,
      refreshStatus: 'applied',
      refresh: {
        skipped: false,
        result: refreshPayload,
      },
      errors: [],
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('skip-init suppresses refresh and package-manager override selects pnpm', () => {
  const rootDir = makeRoot();
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];

  try {
    writeJson(path.join(rootDir, 'package.json'), {
      packageManager: 'yarn@4.9.1',
      optionalDependencies: {
        [AUTONOMY_PACKAGE_NAME]: '2.0.0',
      },
    });
    writeJson(path.join(rootDir, CUSTOM_AGENT_CONFIG_PATH), {
      schemaVersion: 1,
      enabled: true,
      agents: [],
    });

    const runCommand: CommandRunner = (file, args, cwd) => {
      calls.push({ file, args: [...args], cwd });
      return '';
    };
    const payload = runUpdate(rootDir, {
      'package-manager': 'pnpm',
      'skip-init': true,
    }, { runCommand });

    assert.deepEqual(calls, [{
      file: 'pnpm',
      args: ['add', '--save-optional', `${AUTONOMY_PACKAGE_NAME}@latest`],
      cwd: rootDir,
    }]);
    assert.equal(payload.packageManager, 'pnpm');
    assert.equal(payload.refreshed, false);
    assert.equal(payload.refreshStatus, 'skipped');
    assert.deepEqual(payload.refresh, {
      skipped: true,
      reason: 'skip-init',
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('an uninitialized repository installs but reports refresh as not initialized', () => {
  const rootDir = makeRoot();
  let commandCount = 0;

  try {
    writeJson(path.join(rootDir, 'package.json'), {
      packageManager: 'yarn@4.9.1',
    });
    const payload = runUpdate(rootDir, {}, {
      runCommand: () => {
        commandCount += 1;
        return '';
      },
    });

    assert.equal(commandCount, 1);
    assert.equal(payload.packageManager, 'yarn');
    assert.deepEqual(payload.refresh, {
      skipped: true,
      reason: 'not-initialized',
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('Yarn Plug and Play refreshes through the package manager when node_modules is absent', () => {
  const rootDir = makeRoot();
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  try {
    writeJson(path.join(rootDir, 'package.json'), {
      packageManager: 'yarn@4.9.1',
      optionalDependencies: { [AUTONOMY_PACKAGE_NAME]: '^2.0.0' },
    });
    writeJson(path.join(rootDir, CUSTOM_AGENT_CONFIG_PATH), {
      schemaVersion: 1,
      enabled: true,
      agents: [],
    });
    const refreshPayload = { rootDir, created: [], skipped: [], removed: [], updated: [] };
    const payload = runUpdate(rootDir, {}, {
      runCommand: (file, args, cwd) => {
        calls.push({ file, args: [...args], cwd });
        return calls.length === 1 ? '' : JSON.stringify(refreshPayload);
      },
    });
    assert.deepEqual(calls[1], {
      ...buildPackageManagerRefreshCommand('yarn', rootDir),
      cwd: rootDir,
    });
    assert.equal(payload.refreshStatus, 'applied');
    assert.deepEqual(payload.refresh, { skipped: false, result: refreshPayload });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-update-command-'));
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
