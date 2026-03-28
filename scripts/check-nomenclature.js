import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function listProjectFiles() {
  try {
    return execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8' }
    )
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
  } catch (error) {
    console.error('Failed to enumerate project files with git.');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const duplicates = new Map();

for (const filePath of listProjectFiles()) {
  if (!existsSync(filePath)) {
    continue;
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension !== '.ts' && extension !== '.js') {
    continue;
  }

  const fileName = path.basename(filePath);
  const key = fileName.toLowerCase();
  const matches = duplicates.get(key) ?? [];
  matches.push(filePath);
  duplicates.set(key, matches);
}

const conflicts = [...duplicates.entries()]
  .map(([key, paths]) => ({
    key,
    paths: paths.sort((left, right) => left.localeCompare(right)),
  }))
  .filter(({ paths }) => paths.length > 1)
  .sort(
    (left, right) =>
      right.paths.length - left.paths.length || left.key.localeCompare(right.key)
  );

if (conflicts.length === 0) {
  console.log('Nomenclature check passed: all file names are unique.');
  process.exit(0);
}

console.error('Nomenclature check failed: duplicate file names found.\n');

for (const conflict of conflicts) {
  console.error(`${path.basename(conflict.paths[0])} (${conflict.paths.length})`);
  for (const filePath of conflict.paths) {
    console.error(`  - ${filePath}`);
  }
  console.error('');
}

process.exit(1);
