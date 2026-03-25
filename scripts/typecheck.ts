#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const TARGET_DIRS = ['src', 'tests', 'bin', 'scripts'];
const TS_COMPILER = path.join(ROOT_DIR, 'node_modules', 'typescript', 'bin', 'tsc');

function main() {
  const files = TARGET_DIRS.flatMap((dir) => listCheckableFiles(path.join(ROOT_DIR, dir)));
  const jsFiles = files.filter((file) => file.endsWith('.js'));
  const tsFiles = files.filter((file) => file.endsWith('.ts'));
  const failures = [];

  if (files.length === 0) {
    console.error('No files found for syntax check.');
    process.exit(1);
  }

  jsFiles.forEach((filePath) => {
    const result = spawnSync(process.execPath, ['--check', filePath], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: 'pipe',
    });

    if (result.status !== 0) {
      failures.push({
        filePath,
        output: String(result.stderr || result.stdout || '').trim(),
      });
    }
  });

  if (tsFiles.length > 0) {
    const result = spawnSync(
      process.execPath,
      [TS_COMPILER, '--pretty', 'false', '--noEmit', ...tsFiles],
      {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        stdio: 'pipe',
      }
    );

    if (result.status !== 0) {
      failures.push({
        filePath: 'TypeScript files',
        output: String(result.stderr || result.stdout || '').trim(),
      });
    }
  }

  if (failures.length > 0) {
    failures.forEach(({ filePath, output }) => {
      const relativePath = path.relative(ROOT_DIR, filePath);
      console.error(`\n${relativePath}`);
      if (output) {
        console.error(output);
      }
    });
    process.exit(1);
  }

  console.log(`Checked ${files.length} files.`);
}

function listCheckableFiles(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return [];
  }

  const stats = fs.statSync(targetPath);
  if (stats.isDirectory()) {
    return fs.readdirSync(targetPath, { withFileTypes: true })
      .flatMap((entry) => listCheckableFiles(path.join(targetPath, entry.name)));
  }

  if (isCheckableFile(targetPath)) {
    return [targetPath];
  }

  return [];
}

function isCheckableFile(filePath) {
  const relativePath = path.relative(ROOT_DIR, filePath);
  if (relativePath.startsWith(`bin${path.sep}`)) {
    return true;
  }
  return filePath.endsWith('.ts') || filePath.endsWith('.js');
}

main();
