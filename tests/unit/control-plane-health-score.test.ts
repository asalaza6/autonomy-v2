import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { calculateControlPlaneHealthScore } from '../../src/server/control-plane/control-plane-health-score.js';

test('control plane health score falls back to file-size scoring for non-TypeScript repos', () => {
  const previousRepoMap = process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;
  const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-control-health-manager-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-control-health-rust-'));
  try {
    writeControlPlaneConfig(repoRoot, {
      repoId: 'rusty',
      label: 'Rusty',
    });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'main.rs'), 'fn main() {}\n');
    fs.writeFileSync(path.join(repoRoot, 'src', 'large.rs'), [
      'pub fn large() {',
      '  println!("large");',
      '}',
      '',
    ].join('\n').repeat(20));
    process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP = `rusty=${repoRoot}`;

    const result = calculateControlPlaneHealthScore(managerRoot, 'rusty', {
      maxLines: 10,
      threshold: 80,
      top: 5,
    }) as any;

    assert.equal(result.status, 'completed');
    assert.equal(result.mode, 'file-size-only');
    assert.equal(result.summary.oversizedFileCount, 1);
    assert.equal(result.topLargeFiles[0].file, path.join('src', 'large.rs'));
    assert.ok(result.score < 100);
  } finally {
    if (typeof previousRepoMap === 'undefined') {
      delete process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;
    } else {
      process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP = previousRepoMap;
    }
    fs.rmSync(managerRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('control plane health score builds a Rust import graph for Cargo repos', () => {
  const previousRepoMap = process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;
  const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-control-health-manager-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-control-health-cargo-'));
  try {
    writeControlPlaneConfig(repoRoot, {
      repoId: 'cargo-app',
      label: 'Cargo App',
    });
    fs.writeFileSync(path.join(repoRoot, 'Cargo.toml'), [
      '[package]',
      'name = "cargo-app"',
      'version = "0.1.0"',
      'edition = "2021"',
      '',
    ].join('\n'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'main.rs'), [
      'mod large;',
      'use crate::large::answer;',
      'fn main() {',
      '  answer();',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(repoRoot, 'src', 'large.rs'), [
      'pub fn answer() {',
      '  println!("large");',
      '}',
      '',
    ].join('\n').repeat(20));
    process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP = `cargo-app=${repoRoot}`;

    const result = calculateControlPlaneHealthScore(managerRoot, 'cargo-app', {
      maxLines: 10,
      threshold: 80,
      top: 5,
    }) as any;

    assert.equal(result.status, 'completed');
    assert.equal(result.mode, 'rust-graph');
    assert.equal(result.summary.fileCount, 2);
    assert.ok(result.summary.importEdgeCount >= 1);
    assert.equal(result.summary.oversizedFileCount, 1);
    assert.equal(result.topLargeFiles[0].file, path.join('src', 'large.rs'));
    assert.ok(result.report.metrics.layerFlow);
  } finally {
    if (typeof previousRepoMap === 'undefined') {
      delete process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;
    } else {
      process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP = previousRepoMap;
    }
    fs.rmSync(managerRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('control plane health score combines TypeScript and nested Cargo roots', () => {
  const previousRepoMap = process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;
  const managerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-control-health-manager-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-control-health-mixed-'));
  try {
    writeControlPlaneConfig(repoRoot, {
      repoId: 'mixed-app',
      label: 'Mixed App',
    });
    fs.writeFileSync(path.join(repoRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Node',
        target: 'ES2022',
      },
      include: ['src/**/*.ts'],
    }, null, 2));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), [
      "import { value } from './helper';",
      'export const result = value;',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(repoRoot, 'src', 'helper.ts'), 'export const value = 1;\n');
    const cargoRoot = path.join(repoRoot, 'src-tauri');
    fs.mkdirSync(path.join(cargoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(cargoRoot, 'Cargo.toml'), [
      '[package]',
      'name = "mixed-app"',
      'version = "0.1.0"',
      'edition = "2021"',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(cargoRoot, 'src', 'main.rs'), [
      'mod large;',
      'use crate::large::answer;',
      'fn main() {',
      '  answer();',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(cargoRoot, 'src', 'large.rs'), [
      'pub fn answer() {',
      '  println!("large");',
      '}',
      '',
    ].join('\n').repeat(20));
    process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP = `mixed-app=${repoRoot}`;

    const result = calculateControlPlaneHealthScore(managerRoot, 'mixed-app', {
      maxLines: 10,
      threshold: 80,
      top: 5,
    }) as any;

    assert.equal(result.status, 'completed');
    assert.equal(result.mode, 'mixed-graph');
    assert.equal(result.summary.fileCount, 4);
    assert.ok(result.summary.importEdgeCount >= 2);
    assert.equal(result.summary.oversizedFileCount, 1);
    assert.equal(result.topLargeFiles[0].file, path.join('src-tauri', 'src', 'large.rs'));
    assert.equal(result.subReports.length, 2);
    assert.deepEqual(result.subReports.map((report: any) => report.mode).sort(), ['rust-graph', 'typescript-graph']);
  } finally {
    if (typeof previousRepoMap === 'undefined') {
      delete process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP;
    } else {
      process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP = previousRepoMap;
    }
    fs.rmSync(managerRoot, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

function writeControlPlaneConfig(rootDir: string, config: Record<string, unknown>) {
  const configDir = path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'control-plane.json'),
    `${JSON.stringify(config, null, 2)}\n`
  );
}
