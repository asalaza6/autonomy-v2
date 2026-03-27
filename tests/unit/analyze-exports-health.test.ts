import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const WORKSPACE_ROOT = fs.existsSync(path.join(process.cwd(), 'analyze-exports.mjs'))
  ? process.cwd()
  : path.join(process.cwd(), '..');
const FIXTURE_ROOT = path.join(WORKSPACE_ROOT, 'tests', 'fixtures', 'structureness-health');
const ANALYZER_MODULE_URL = pathToFileURL(path.join(WORKSPACE_ROOT, 'analyze-exports.mjs')).href;
const ANALYZER_CLI_PATH = path.join(WORKSPACE_ROOT, 'analyze-exports.mjs');

async function loadAnalyzer() {
  return import(ANALYZER_MODULE_URL);
}

function runAnalyzer(args: string[]) {
  return execFileSync(process.execPath, [ANALYZER_CLI_PATH, ...args], {
    cwd: WORKSPACE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function loadTreeFixture(name: string) {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_ROOT, `${name}.json`), 'utf8')
  );
}

test('clean layered graph has no cycles and a stable depth histogram', async () => {
  const { buildStructuralHealthReport } = await loadAnalyzer();
  const report = buildStructuralHealthReport(loadTreeFixture('clean-layered'), {
    rootFileId: 'all',
    top: 5,
  });

  assert.equal(report.metrics.cycleBurden.filesInCycles, 0);
  assert.equal(report.metrics.layerFlow.wrongWayEdges, 0);
  assert.equal(report.metrics.layerFlow.skipEdges, 0);
  assert.deepEqual(report.histograms.depth, [
    { depth: 0, files: 1 },
    { depth: 1, files: 1 },
    { depth: 2, files: 1 },
    { depth: 3, files: 1 },
  ]);
});

test('cyclic cluster collapses into one SCC depth layer', async () => {
  const { buildCondensedGraph, buildStructuralHealthReport } = await loadAnalyzer();
  const fixture = loadTreeFixture('cyclic-cluster');
  const visibleFiles = new Set(fixture.files.map((file: { id: string }) => file.id));
  const condensed = buildCondensedGraph(visibleFiles, fixture.edges);

  assert.equal(condensed.levelByFile.get('node_2'), condensed.levelByFile.get('node_3'));

  const report = buildStructuralHealthReport(fixture, { rootFileId: 'all', top: 5 });
  assert.equal(report.metrics.cycleBurden.largestSccSize, 2);
  assert.equal(report.metrics.sameLevelCoherence.sameLevelEdges, 2);
  assert.deepEqual(report.topSccs[0].members, [
    'src/domain/a.ts',
    'src/domain/b.ts',
  ]);
});

test('scoped root analysis changes root fanout and file counts', async () => {
  const { buildStructuralHealthReport } = await loadAnalyzer();
  const fixture = loadTreeFixture('multi-root');

  const allReport = buildStructuralHealthReport(fixture, { rootFileId: 'all', top: 5 });
  const scopedReport = buildStructuralHealthReport(fixture, { rootFileId: 'node_2', top: 5 });

  assert.equal(allReport.metrics.rootClarity.rootCount, 2);
  assert.equal(scopedReport.metrics.rootClarity.rootCount, 1);
  assert.equal(allReport.scope.fileCount, 4);
  assert.equal(scopedReport.scope.fileCount, 3);
  assert.equal(scopedReport.scope.root?.relative, 'src/cli/main.ts');
});

test('same-level-heavy graph reports dense same-level imports', async () => {
  const { buildStructuralHealthReport } = await loadAnalyzer();
  const report = buildStructuralHealthReport(loadTreeFixture('same-level-heavy'), {
    rootFileId: 'all',
    top: 5,
  });

  assert.equal(report.metrics.cycleBurden.largestSccSize, 3);
  assert.equal(report.metrics.sameLevelCoherence.sameLevelEdges, 3);
  assert.ok([
    'src/cluster/a.ts',
    'src/cluster/b.ts',
    'src/cluster/c.ts',
  ].includes(report.topOffenders[0].file));
});

test('overloaded depth graph surfaces a wide band and directory spread', async () => {
  const { buildStructuralHealthReport } = await loadAnalyzer();
  const report = buildStructuralHealthReport(loadTreeFixture('overloaded-depth'), {
    rootFileId: 'all',
    top: 5,
  });

  assert.deepEqual(report.metrics.depthBalance.overloadedDepths, [1]);
  assert.equal(report.metrics.depthBalance.widestDepth.depth, 1);
  assert.equal(report.metrics.depthBalance.widestDepth.files, 5);
  const sharedDirectory = report.topDirectories.find(
    (entry: { directory: string }) => entry.directory === 'src/shared'
  );
  assert.ok(sharedDirectory);
  assert.equal(sharedDirectory.depthSpread, 2);
});

test('bridge hub graph raises skip ratio and bridge suspicion', async () => {
  const { buildStructuralHealthReport } = await loadAnalyzer();
  const report = buildStructuralHealthReport(loadTreeFixture('bridge-hub'), {
    rootFileId: 'all',
    top: 5,
  });

  assert.equal(report.metrics.layerFlow.skipEdges, 1);
  assert.ok(report.metrics.layerFlow.skipRatio > 0);
  assert.equal(report.metrics.hubPressure.bridgeSuspectCount, 1);
  assert.equal(report.topOffenders[0].file, 'src/feature/hub.ts');
  assert.match(report.topOffenders[0].reasons.join(' '), /bridges 5 directories/);
});

test('wrong-way imports are counted only when imports climb to shallower layers', async () => {
  const { buildStructuralHealthReport } = await loadAnalyzer();
  const report = buildStructuralHealthReport(loadTreeFixture('wrong-way'), {
    rootFileId: 'all',
    top: 5,
  });

  assert.equal(report.metrics.layerFlow.wrongWayEdges, 1);
  assert.equal(report.metrics.layerFlow.wrongWaySeverityTotal, 2);
  assert.equal(report.metrics.layerFlow.skipEdges, 0);
  assert.equal(report.topOffenders[0].file, 'src/domain/model.ts');
});

test('health text output is stable for a small cyclic export-map fixture', () => {
  const output = runAnalyzer([
    '--input',
    path.join(FIXTURE_ROOT, 'export-map-cyclic.json'),
    '--format',
    'health',
    '--health-output',
    'text',
    '--relative-to',
    '/repo',
    '--top',
    '3',
  ]);

  assert.equal(output, [
    'Structureness Health (all)',
    'Score: 61.25/100',
    '4 files, 4 graph edges, 4 import edges',
    '1 SCCs, max depth 2, 1 roots',
    '',
    'Strengths',
    '- Layer direction is mostly consistent across imports.',
    '- Directories stay within tight depth bands.',
    '',
    'Penalties',
    '- 50.0% of files sit inside SCCs.',
    '- Depth 1 holds 50.0% of analyzed files.',
    '',
    'Top Offenders',
    '- src/domain/a.ts (D1, severity 3.5): cycle cluster of 2 files',
    '- src/domain/b.ts (D1, severity 3.5): cycle cluster of 2 files',
    '',
    'Top SCCs',
    '- size 2, depth 1, density 1: src/domain/a.ts, src/domain/b.ts',
    '',
    'Depth Histogram',
    '- D0: 1',
    '- D1: 2',
    '- D2: 1',
    '',
    'Directory Depth Summary',
    '- src/domain: 2 files, depth 1-1, median 1, spread 0, cross-dir wrong-way 0.0%',
    '- src/app: 1 files, depth 0-0, median 0, spread 0, cross-dir wrong-way 0.0%',
    '- src/shared: 1 files, depth 2-2, median 2, spread 0, cross-dir wrong-way 0.0%',
    '',
    'Metric Summary',
    '- Layer flow: 0 wrong-way, 0 skips, 2 same-level',
    '- Cycle burden: 2 files in cycles, largest SCC 2',
    '- Root clarity: top root fanout ratio 100.0%',
    '- Hub pressure: 0 bridge suspects',
  ].join('\n'));
});

test('health threshold emits an explicit fail message when the score misses the target', () => {
  const output = runAnalyzer([
    '--input',
    path.join(FIXTURE_ROOT, 'export-map-cyclic.json'),
    '--format',
    'health',
    '--health-output',
    'text',
    '--relative-to',
    '/repo',
    '--threshold',
    '80',
    '--top',
    '3',
  ]);

  assert.match(output, /Score: 61.25\/100/);
  assert.match(output, /FAIL: score 61.25 is below threshold 80\./);
});

test('health json output matches the report shape', () => {
  const output = runAnalyzer([
    '--input',
    path.join(FIXTURE_ROOT, 'export-map-cyclic.json'),
    '--format',
    'health',
    '--health-output',
    'json',
    '--relative-to',
    '/repo',
    '--top',
    '3',
  ]);
  const report = JSON.parse(output);

  assert.equal(report.scope.fileCount, 4);
  assert.equal(report.score.value, 61.25);
  assert.equal(report.score.threshold, null);
  assert.equal(report.score.passed, null);
  assert.equal(report.score.message, null);
  assert.equal(report.score.components.layerFlow, 87.5);
  assert.ok(report.metrics.layerFlow);
  assert.ok(report.metrics.cycleBurden);
  assert.ok(Array.isArray(report.findings.strengths));
  assert.ok(Array.isArray(report.topOffenders));
  assert.ok(Array.isArray(report.topDirectories));
  assert.ok(Array.isArray(report.topSccs));
  assert.ok(Array.isArray(report.histograms.depth));
});

test('health CLI succeeds against the current repo for all files and one scoped root', async () => {
  const analyzer = await loadAnalyzer();
  const entries = analyzer.filterEntries(
    await analyzer.buildExportMap(path.join(WORKSPACE_ROOT, 'tsconfig.json')),
    {
      focus: null,
      includeOrphans: true,
      minImporters: 0,
    }
  );
  const treeGridData = analyzer.buildTreeGridData(
    analyzer.buildGraphContext(entries, {
      layout: 'LR',
      relativeTo: WORKSPACE_ROOT,
    })
  );
  const scopedRoot = treeGridData.roots[0];

  const allOutput = JSON.parse(runAnalyzer([
    '--format',
    'health',
    '--health-output',
    'json',
    '--top',
    '5',
  ]));
  const scopedOutput = JSON.parse(runAnalyzer([
    '--format',
    'health',
    '--health-output',
    'json',
    '--root',
    scopedRoot,
    '--top',
    '5',
  ]));

  assert.ok(allOutput.scope.fileCount > 0);
  assert.ok(allOutput.scope.edgeCount > 0);
  assert.ok(allOutput.metrics.cycleBurden);
  assert.ok(Array.isArray(allOutput.topOffenders));
  assert.ok(Array.isArray(allOutput.topSccs));
  assert.ok(Array.isArray(allOutput.histograms.depth));
  assert.equal(scopedOutput.scope.root.id, scopedRoot);
  assert.ok(scopedOutput.scope.fileCount > 0);
});
