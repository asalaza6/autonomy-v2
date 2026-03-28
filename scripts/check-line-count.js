#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_MAX_LINES = 500;
const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'dist',
  'node_modules',
]);
const DEFAULT_ALLOWED_PATHS = new Set([
  'package-lock.json',
]);

function parseArgs(argv) {
  const options = {
    maxLines: DEFAULT_MAX_LINES,
    rootDir: process.cwd(),
  };

  for (const arg of argv) {
    if (arg.startsWith('--max-lines=')) {
      const value = Number.parseInt(arg.slice('--max-lines='.length), 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --max-lines value: ${arg}`);
      }
      options.maxLines = value;
      continue;
    }

    if (arg.startsWith('--root=')) {
      const value = arg.slice('--root='.length).trim();
      if (!value) {
        throw new Error(`Invalid --root value: ${arg}`);
      }
      options.rootDir = path.resolve(value);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function getCandidateFiles(rootDir) {
  try {
    const output = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: rootDir,
        encoding: 'utf8',
      },
    );

    return output
      .split('\0')
      .filter(Boolean)
      .map((relativePath) => path.resolve(rootDir, relativePath));
  } catch {
    return walkFiles(rootDir);
  }
}

function walkFiles(rootDir) {
  const results = [];
  const queue = [rootDir];

  while (queue.length > 0) {
    const currentDir = queue.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRS.has(entry.name)) {
          queue.push(entryPath);
        }
        continue;
      }

      if (entry.isFile()) {
        results.push(entryPath);
      }
    }
  }

  return results;
}

function isBinaryBuffer(buffer) {
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }

  return false;
}

function countLines(buffer) {
  if (buffer.length === 0) {
    return 0;
  }

  let lines = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    const nextByte = buffer[index + 1];

    if (byte === 10) {
      lines += 1;
      continue;
    }

    if (byte === 13 && nextByte !== 10) {
      lines += 1;
    }
  }

  const lastByte = buffer[buffer.length - 1];
  if (lastByte !== 10 && lastByte !== 13) {
    lines += 1;
  }

  return lines;
}

function terminalLink(label, absolutePath) {
  const url = pathToFileURL(absolutePath).href;
  return `\u001B]8;;${url}\u0007${label}\u001B]8;;\u0007`;
}

function analyzeFiles(rootDir, maxLines) {
  const violations = [];
  const files = getCandidateFiles(rootDir);

  for (const filePath of files) {
    const relativePath = path.relative(rootDir, filePath);
    if (DEFAULT_ALLOWED_PATHS.has(relativePath)) {
      continue;
    }

    const stats = fs.statSync(filePath, { throwIfNoEntry: false });
    if (!stats || !stats.isFile()) {
      continue;
    }

    const buffer = fs.readFileSync(filePath);
    if (isBinaryBuffer(buffer)) {
      continue;
    }

    const lineCount = countLines(buffer);
    if (lineCount <= maxLines) {
      continue;
    }

    violations.push({
      filePath,
      relativePath,
      lineCount,
    });
  }

  return violations.sort((left, right) => right.lineCount - left.lineCount);
}

function main() {
  const { maxLines, rootDir } = parseArgs(process.argv.slice(2));
  const violations = analyzeFiles(rootDir, maxLines);

  if (violations.length === 0) {
    console.log(`All repo files are within ${maxLines} lines.`);
    return;
  }

  console.error(`Found ${violations.length} file(s) over ${maxLines} lines:`);
  for (const violation of violations) {
    const link = terminalLink(violation.relativePath, violation.filePath);
    console.error(`- ${String(violation.lineCount).padStart(4, ' ')} lines  ${link}`);
  }

  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
