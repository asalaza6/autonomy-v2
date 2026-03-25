#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const TARGET_DIRS = ['src', 'tests', 'bin'];

function main() {
  const files = TARGET_DIRS.flatMap((dir) => listCheckableFiles(path.join(ROOT_DIR, dir)));

  if (files.length === 0) {
    console.error('No files found for syntax check.');
    process.exit(1);
  }

  const failures = [];

  files.forEach((filePath) => {
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
  return filePath.endsWith('.js');
}

main();
