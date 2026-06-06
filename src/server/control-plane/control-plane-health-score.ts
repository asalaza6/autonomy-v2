import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadControlPlaneConfig } from './control-plane-config.js';
import { getRepoStatuses } from './control-plane-store.js';

const DEFAULT_MAX_LINES = 800;
const DEFAULT_THRESHOLD = 80;
const MAX_ANALYZER_BUFFER_BYTES = 50 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.autonomy', '.git', 'dist', 'node_modules', 'target']);
const ALLOWED_OVERSIZED_PATHS = new Set(['package-lock.json']);

type HealthScoreOptions = {
  maxLines?: number;
  threshold?: number;
  top?: number;
};

function calculateControlPlaneHealthScore(
  managerRootDir: string,
  repoId: string,
  options: HealthScoreOptions = {}
) {
  const normalizedRepoId = String(repoId || '').trim();
  if (!normalizedRepoId) {
    throw new Error('Missing repoId.');
  }

  const maxLines = normalizePositiveInteger(options.maxLines, DEFAULT_MAX_LINES);
  const threshold = normalizePositiveNumber(options.threshold, DEFAULT_THRESHOLD);
  const top = normalizePositiveInteger(options.top, 10);
  const repoRoot = resolveControlPlaneHealthRepoRoot(managerRootDir, normalizedRepoId);
  const calculatedAt = new Date().toISOString();
  if (!repoRoot) {
    return {
      repoId: normalizedRepoId,
      status: 'unavailable',
      mode: 'unavailable',
      calculatedAt,
      threshold,
      maxLines,
      message: 'Repo root is not available to this control-plane server.',
    };
  }

  const analyzerPath = findAnalyzerPath();
  const tsconfigPath = path.join(repoRoot, 'tsconfig.json');
  const cargoRoots = findCargoRoots(repoRoot);
  const analyzerResults = [];
  const analyzerErrors: string[] = [];

  if (analyzerPath && fs.existsSync(tsconfigPath)) {
    try {
      analyzerResults.push(normalizeAnalyzerHealthReport({
        repoId: normalizedRepoId,
        repoRoot,
        calculatedAt,
        threshold,
        maxLines,
        mode: 'typescript-graph',
        report: runTypeScriptHealthAnalyzer({
          analyzerPath,
          repoRoot,
          tsconfigPath,
          threshold,
          maxLines,
          top,
        }),
      }));
    } catch (error) {
      analyzerErrors.push(`TypeScript: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (analyzerPath && cargoRoots.length > 0) {
    try {
      analyzerResults.push(normalizeAnalyzerHealthReport({
        repoId: normalizedRepoId,
        repoRoot,
        calculatedAt,
        threshold,
        maxLines,
        mode: 'rust-graph',
        report: runRustHealthAnalyzer({
          analyzerPath,
          repoRoot,
          cargoRoots,
          threshold,
          maxLines,
          top,
        }),
      }));
    } catch (error) {
      analyzerErrors.push(`Rust: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (analyzerResults.length > 1) {
    return combineAnalyzerHealthResults({
      repoId: normalizedRepoId,
      repoRoot,
      calculatedAt,
      threshold,
      maxLines,
      reports: analyzerResults,
      analyzerErrors,
      top,
    });
  }

  if (analyzerResults.length === 1) {
    return analyzerErrors.length > 0
      ? {
        ...analyzerResults[0],
        analyzerError: analyzerErrors.join(' | '),
      }
      : analyzerResults[0];
  }

  return {
    ...buildFileSizeOnlyHealthReport(repoRoot, {
      maxLines,
      threshold,
      top,
    }),
    repoId: normalizedRepoId,
    repoRoot,
    calculatedAt,
    status: 'completed',
    mode: 'file-size-only',
    ...(analyzerErrors.length > 0 ? { analyzerError: analyzerErrors.join(' | ') } : {}),
  };
}

function normalizeAnalyzerHealthReport({
  repoId,
  repoRoot,
  calculatedAt,
  threshold,
  maxLines,
  mode,
  report,
}: {
  repoId: string;
  repoRoot: string;
  calculatedAt: string;
  threshold: number;
  maxLines: number;
  mode: string;
  report: any;
}) {
  const score = Number(report && report.score && report.score.value);
  const metrics = report && report.metrics ? report.metrics : {};
  const fileSize = metrics.fileSize || {};
  const topLargeFiles = Array.isArray(report && report.topLargeFiles)
    ? report.topLargeFiles
    : [];
  return {
    repoId,
    repoRoot,
    calculatedAt,
    status: 'completed',
    mode,
    score: Number.isFinite(score) ? score : null,
    threshold,
    passed: Boolean(report && report.score && report.score.passed),
    maxLines,
    summary: {
      fileCount: Number(report && report.scope && report.scope.fileCount) || 0,
      importEdgeCount: Number(report && report.scope && report.scope.importEdgeCount) || 0,
      cyclicComponentCount: Number(metrics.cycleBurden && metrics.cycleBurden.cyclicComponentCount) || 0,
      filesInCycles: Number(metrics.cycleBurden && metrics.cycleBurden.filesInCycles) || 0,
      largestSccSize: Number(metrics.cycleBurden && metrics.cycleBurden.largestSccSize) || 0,
      wrongWayEdges: Number(metrics.layerFlow && metrics.layerFlow.wrongWayEdges) || 0,
      sameLevelEdges: Number(metrics.layerFlow && metrics.layerFlow.sameLevelEdges) || 0,
      oversizedFileCount: Number(fileSize.oversizedFileCount) || 0,
      measuredFiles: Number(fileSize.measuredFiles) || 0,
      maxLineCount: Number(fileSize.maxLineCount) || 0,
    },
    scoreDrag: report && report.score && report.score.drag ? report.score.drag : null,
    components: report && report.score && report.score.components ? report.score.components : {},
    topLargeFiles,
    topOffenders: Array.isArray(report && report.topOffenders) ? report.topOffenders : [],
    topSccs: Array.isArray(report && report.topSccs) ? report.topSccs : [],
    report,
  };
}

function buildFileSizeOnlyHealthReport(
  repoRoot: string,
  options: Required<Pick<HealthScoreOptions, 'maxLines' | 'threshold' | 'top'>>
) {
  const measuredFiles = listCandidateFiles(repoRoot)
    .map((filePath) => {
      const relativePath = path.relative(repoRoot, filePath);
      if (ALLOWED_OVERSIZED_PATHS.has(relativePath)) {
        return null;
      }
      const lineCount = measureFileLineCount(filePath);
      if (lineCount === null) {
        return null;
      }
      return {
        path: filePath,
        file: relativePath,
        directory: path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath),
        lineCount,
        lineOverage: Math.max(0, lineCount - options.maxLines),
      };
    })
    .filter((entry): entry is {
      path: string;
      file: string;
      directory: string;
      lineCount: number;
      lineOverage: number;
    } => Boolean(entry));
  const oversizedFiles = measuredFiles.filter((entry) => entry.lineOverage > 0);
  const maxLineCount = measuredFiles.reduce((max, entry) => Math.max(max, entry.lineCount), 0);
  const maxLineOverage = Math.max(0, maxLineCount - options.maxLines);
  const totalLineOverage = oversizedFiles.reduce((sum, entry) => sum + entry.lineOverage, 0);
  const oversizedFileRatio = ratio(oversizedFiles.length, measuredFiles.length);
  const averageLineOverageRatio = ratio(totalLineOverage, measuredFiles.length * options.maxLines);
  const maxLineOverageRatio = ratio(maxLineOverage, options.maxLines);
  const score = clampScore(
    measuredFiles.length === 0
      ? 100
      : 100 -
          oversizedFileRatio * 100 * 1.2 -
          Math.min(1, averageLineOverageRatio) * 100 * 1.2 -
          Math.min(1, maxLineOverageRatio) * 100 * 0.8
  );
  const topLargeFiles = oversizedFiles
    .sort((left, right) => right.lineCount - left.lineCount || left.file.localeCompare(right.file))
    .slice(0, options.top);

  return {
    repoRoot,
    threshold: options.threshold,
    maxLines: options.maxLines,
    score,
    passed: score >= options.threshold,
    summary: {
      fileCount: measuredFiles.length,
      importEdgeCount: 0,
      cyclicComponentCount: 0,
      filesInCycles: 0,
      largestSccSize: 0,
      wrongWayEdges: 0,
      sameLevelEdges: 0,
      oversizedFileCount: oversizedFiles.length,
      measuredFiles: measuredFiles.length,
      maxLineCount,
    },
    components: {
      fileSize: score,
    },
    scoreDrag: {
      totalPointsLost: roundMetric(100 - score),
      byComponent: [
        {
          key: 'fileSize',
          label: 'File size',
          score,
          weight: 1,
          pointsLost: roundMetric(100 - score),
        },
      ],
      byCause: [
        {
          key: 'fileSize.oversizedFiles',
          component: 'fileSize',
          componentLabel: 'File size',
          label: 'files over line limit',
          pointsLost: roundMetric((100 - score) * ratio(oversizedFiles.length, Math.max(1, oversizedFiles.length + 1))),
          signal: `${oversizedFiles.length} files over ${options.maxLines} lines`,
        },
      ],
    },
    topLargeFiles,
    topOffenders: [],
    topSccs: [],
    report: {
      score: {
        value: score,
        threshold: options.threshold,
        passed: score >= options.threshold,
      },
      metrics: {
        fileSize: {
          maxLines: options.maxLines,
          measuredFiles: measuredFiles.length,
          oversizedFileCount: oversizedFiles.length,
          oversizedFileRatio: roundMetric(oversizedFileRatio),
          maxLineCount,
          maxLineOverage,
          maxLineOverageRatio: roundMetric(maxLineOverageRatio),
          totalLineOverage,
          averageLineOverage: roundMetric(ratio(totalLineOverage, measuredFiles.length)),
          averageLineOverageRatio: roundMetric(averageLineOverageRatio),
        },
      },
      topLargeFiles,
    },
  };
}

function runTypeScriptHealthAnalyzer({
  analyzerPath,
  repoRoot,
  tsconfigPath,
  threshold,
  maxLines,
  top,
}: {
  analyzerPath: string;
  repoRoot: string;
  tsconfigPath: string;
  threshold: number;
  maxLines: number;
  top: number;
}) {
  const stdout = execFileSync(process.execPath, [
    analyzerPath,
    '--format',
    'health',
    '--health-output',
    'json',
    '--threshold',
    String(threshold),
    '--top',
    String(top),
    '--max-lines',
    String(maxLines),
    '--tsconfig',
    tsconfigPath,
    '--relative-to',
    repoRoot,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: MAX_ANALYZER_BUFFER_BYTES,
  });
  return JSON.parse(stdout);
}

function combineAnalyzerHealthResults({
  repoId,
  repoRoot,
  calculatedAt,
  threshold,
  maxLines,
  reports,
  analyzerErrors,
  top,
}: {
  repoId: string;
  repoRoot: string;
  calculatedAt: string;
  threshold: number;
  maxLines: number;
  reports: any[];
  analyzerErrors: string[];
  top: number;
}) {
  const weightedReports = reports.map((report) => ({
    report,
    weight: Math.max(
      1,
      Number(report && report.summary && (report.summary.fileCount || report.summary.measuredFiles)) || 0
    ),
  }));
  const totalWeight = weightedReports.reduce((sum, entry) => sum + entry.weight, 0) || 1;
  const score = clampScore(
    weightedReports.reduce((sum, entry) => (
      sum + (Number(entry.report && entry.report.score) || 0) * entry.weight
    ), 0) / totalWeight
  );
  const summary = combineHealthSummaries(reports.map((report) => report.summary || {}));
  const components = combineHealthComponents(weightedReports, totalWeight);
  const topLargeFiles = reports
    .flatMap((report) => Array.isArray(report.topLargeFiles) ? report.topLargeFiles : [])
    .sort((left, right) => Number(right.lineCount || 0) - Number(left.lineCount || 0) || String(left.file || '').localeCompare(String(right.file || '')))
    .slice(0, top);
  const topOffenders = reports
    .flatMap((report) => Array.isArray(report.topOffenders) ? report.topOffenders.map((entry: any) => ({
      ...entry,
      analyzerMode: report.mode,
    })) : [])
    .sort((left, right) => Number(right.severity || 0) - Number(left.severity || 0))
    .slice(0, top);
  const topSccs = reports
    .flatMap((report) => Array.isArray(report.topSccs) ? report.topSccs.map((entry: any) => ({
      ...entry,
      analyzerMode: report.mode,
    })) : [])
    .sort((left, right) => Number(right.size || 0) - Number(left.size || 0))
    .slice(0, top);
  const byCause = weightedReports
    .flatMap(({ report, weight }) => {
      const causes = report && report.scoreDrag && Array.isArray(report.scoreDrag.byCause)
        ? report.scoreDrag.byCause
        : [];
      const weightRatio = weight / totalWeight;
      return causes.map((cause: any) => ({
        ...cause,
        componentLabel: `${formatAnalyzerModeLabel(report.mode)} ${cause.componentLabel || cause.component || ''}`.trim(),
        pointsLost: roundMetric((Number(cause.pointsLost) || 0) * weightRatio),
        analyzerMode: report.mode,
      }));
    })
    .filter((cause) => Number(cause.pointsLost) > 0)
    .sort((left, right) => Number(right.pointsLost || 0) - Number(left.pointsLost || 0))
    .slice(0, top);

  return {
    repoId,
    repoRoot,
    calculatedAt,
    status: 'completed',
    mode: 'mixed-graph',
    score,
    threshold,
    passed: score >= threshold,
    maxLines,
    summary,
    scoreDrag: {
      totalPointsLost: roundMetric(100 - score),
      byComponent: [],
      byCause,
    },
    components,
    topLargeFiles,
    topOffenders,
    topSccs,
    report: {
      score: {
        value: score,
        threshold,
        passed: score >= threshold,
      },
      metrics: {
        adapters: reports.map((report) => ({
          mode: report.mode,
          score: report.score,
          summary: report.summary,
          components: report.components,
        })),
      },
      topLargeFiles,
      topOffenders,
      topSccs,
    },
    subReports: reports,
    ...(analyzerErrors.length > 0 ? { analyzerError: analyzerErrors.join(' | ') } : {}),
  };
}

function combineHealthSummaries(summaries: any[]) {
  return {
    fileCount: sumSummaryNumber(summaries, 'fileCount'),
    importEdgeCount: sumSummaryNumber(summaries, 'importEdgeCount'),
    cyclicComponentCount: sumSummaryNumber(summaries, 'cyclicComponentCount'),
    filesInCycles: sumSummaryNumber(summaries, 'filesInCycles'),
    largestSccSize: maxSummaryNumber(summaries, 'largestSccSize'),
    wrongWayEdges: sumSummaryNumber(summaries, 'wrongWayEdges'),
    sameLevelEdges: sumSummaryNumber(summaries, 'sameLevelEdges'),
    oversizedFileCount: sumSummaryNumber(summaries, 'oversizedFileCount'),
    measuredFiles: sumSummaryNumber(summaries, 'measuredFiles'),
    maxLineCount: maxSummaryNumber(summaries, 'maxLineCount'),
  };
}

function combineHealthComponents(
  weightedReports: Array<{ report: any; weight: number }>,
  totalWeight: number
) {
  const keys = new Set<string>();
  weightedReports.forEach(({ report }) => {
    Object.keys(report && report.components || {}).forEach((key) => keys.add(key));
  });
  return Object.fromEntries(Array.from(keys).sort().map((key) => {
    const value = weightedReports.reduce((sum, { report, weight }) => (
      sum + (Number(report && report.components && report.components[key]) || 0) * weight
    ), 0) / totalWeight;
    return [key, clampScore(value)];
  }));
}

function sumSummaryNumber(summaries: any[], key: string) {
  return summaries.reduce((sum, summary) => sum + (Number(summary && summary[key]) || 0), 0);
}

function maxSummaryNumber(summaries: any[], key: string) {
  return summaries.reduce((max, summary) => Math.max(max, Number(summary && summary[key]) || 0), 0);
}

function formatAnalyzerModeLabel(mode: string) {
  if (mode === 'typescript-graph') {
    return 'TypeScript';
  }
  if (mode === 'rust-graph') {
    return 'Rust';
  }
  return String(mode || 'Analyzer');
}

function runRustHealthAnalyzer({
  analyzerPath,
  repoRoot,
  cargoRoots,
  threshold,
  maxLines,
  top,
}: {
  analyzerPath: string;
  repoRoot: string;
  cargoRoots: string[];
  threshold: number;
  maxLines: number;
  top: number;
}) {
  const exportMap = buildRustExportMap(repoRoot, cargoRoots);
  const tempPath = path.join(
    os.tmpdir(),
    `autonomy-rust-health-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
  );
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(exportMap, null, 2)}\n`, 'utf8');
    const stdout = execFileSync(process.execPath, [
      analyzerPath,
      '--input',
      tempPath,
      '--format',
      'health',
      '--health-output',
      'json',
      '--threshold',
      String(threshold),
      '--top',
      String(top),
      '--max-lines',
      String(maxLines),
      '--relative-to',
      repoRoot,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: MAX_ANALYZER_BUFFER_BYTES,
    });
    return JSON.parse(stdout);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function buildRustExportMap(repoRoot: string, cargoRoots: string[]) {
  return Object.assign({}, ...cargoRoots.map((cargoRoot) => buildRustExportMapForCargoRoot(repoRoot, cargoRoot)));
}

function findCargoRoots(repoRoot: string) {
  const roots = new Set<string>();
  const queue = [repoRoot];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }
    const cargoTomlPath = path.join(currentDir, 'Cargo.toml');
    if (fs.existsSync(cargoTomlPath)) {
      roots.add(currentDir);
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.forEach((entry) => {
      if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
        queue.push(path.join(currentDir, entry.name));
      }
    });
  }
  return Array.from(roots).sort((left, right) => left.localeCompare(right));
}

function buildRustExportMapForCargoRoot(repoRoot: string, cargoRoot: string) {
  const rustFiles = listCandidateFiles(cargoRoot)
    .filter((filePath) => filePath.endsWith('.rs'))
    .sort();
  const modulePathByFile = new Map<string, string>();
  const fileByModulePath = new Map<string, string>();
  rustFiles.forEach((filePath) => {
    const modulePath = rustModulePathForFile(cargoRoot, filePath);
    modulePathByFile.set(filePath, modulePath);
    if (!fileByModulePath.has(modulePath)) {
      fileByModulePath.set(modulePath, filePath);
    }
  });

  const importsByFile = new Map<string, Set<string>>();
  rustFiles.forEach((filePath) => {
    importsByFile.set(filePath, collectRustFileImports({
      cargoRoot,
      filePath,
      modulePath: modulePathByFile.get(filePath) || 'crate',
      fileByModulePath,
    }));
  });

  const importedByFile = new Map<string, Set<string>>();
  rustFiles.forEach((filePath) => {
    importedByFile.set(filePath, new Set());
  });
  importsByFile.forEach((imports, importerPath) => {
    imports.forEach((importedPath) => {
      const importers = importedByFile.get(importedPath) || new Set<string>();
      importers.add(importerPath);
      importedByFile.set(importedPath, importers);
    });
  });

  return Object.fromEntries(rustFiles.map((filePath) => [
    rustExportMapKey(repoRoot, filePath),
    {
      exportedFrom: filePath,
      importedBy: Array.from(importedByFile.get(filePath) || []).sort(),
      imports: Array.from(importsByFile.get(filePath) || []).sort(),
    },
  ]));
}

function rustExportMapKey(repoRoot: string, filePath: string) {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function rustModulePathForFile(cargoRoot: string, filePath: string) {
  const relativePath = path.relative(path.join(cargoRoot, 'src'), filePath).replace(/\\/g, '/');
  if (relativePath === 'lib.rs' || relativePath === 'main.rs') {
    return 'crate';
  }
  if (relativePath.startsWith('bin/')) {
    return `crate::bin::${relativePath.slice('bin/'.length).replace(/\.rs$/, '').replace(/\//g, '::')}`;
  }
  if (relativePath.endsWith('/mod.rs')) {
    return `crate::${relativePath.slice(0, -'/mod.rs'.length).replace(/\//g, '::')}`;
  }
  return `crate::${relativePath.replace(/\.rs$/, '').replace(/\//g, '::')}`;
}

function collectRustFileImports({
  cargoRoot,
  filePath,
  modulePath,
  fileByModulePath,
}: {
  cargoRoot: string;
  filePath: string;
  modulePath: string;
  fileByModulePath: Map<string, string>;
}) {
  const source = stripRustComments(fs.readFileSync(filePath, 'utf8'));
  const imports = new Set<string>();

  collectRustModImports(cargoRoot, filePath, source).forEach((importedPath) => {
    if (importedPath !== filePath) {
      imports.add(importedPath);
    }
  });

  collectRustUsePaths(source).forEach((usePath) => {
    const resolved = resolveRustUsePath(modulePath, usePath, fileByModulePath);
    if (resolved && resolved !== filePath) {
      imports.add(resolved);
    }
  });

  const explicitPathRegex = /\b(?:crate|self|super)::[A-Za-z_][A-Za-z0-9_:]*/g;
  for (const match of source.matchAll(explicitPathRegex)) {
    const resolved = resolveRustUsePath(modulePath, match[0], fileByModulePath);
    if (resolved && resolved !== filePath) {
      imports.add(resolved);
    }
  }

  return imports;
}

function collectRustModImports(cargoRoot: string, filePath: string, source: string) {
  const imports = new Set<string>();
  const modRegex = /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g;
  for (const match of source.matchAll(modRegex)) {
    const moduleName = match[1];
    const resolved = resolveRustSiblingModuleFile(cargoRoot, filePath, moduleName);
    if (resolved) {
      imports.add(resolved);
    }
  }
  return imports;
}

function resolveRustSiblingModuleFile(cargoRoot: string, filePath: string, moduleName: string) {
  const baseName = path.basename(filePath);
  const directory = baseName === 'mod.rs' || baseName === 'lib.rs' || baseName === 'main.rs'
    ? path.dirname(filePath)
    : path.join(path.dirname(filePath), path.basename(filePath, '.rs'));
  const candidates = [
    path.join(directory, `${moduleName}.rs`),
    path.join(directory, moduleName, 'mod.rs'),
  ];
  for (const candidate of candidates) {
    if (candidate.startsWith(cargoRoot) && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function collectRustUsePaths(source: string) {
  const paths = new Set<string>();
  const useRegex = /(?:^|\n)\s*(?:pub\s+)?use\s+([^;]+);/g;
  for (const match of source.matchAll(useRegex)) {
    expandRustUseExpression(match[1]).forEach((entry) => paths.add(entry));
  }
  return paths;
}

function expandRustUseExpression(expression: string) {
  const compact = String(expression || '').replace(/\s+/g, '');
  return expandRustUsePath(compact);
}

function expandRustUsePath(value: string): string[] {
  const braceIndex = value.indexOf('{');
  if (braceIndex === -1) {
    return [trimRustUseAlias(value)].filter(Boolean);
  }
  const prefix = value.slice(0, braceIndex).replace(/::$/, '');
  const endIndex = findMatchingBrace(value, braceIndex);
  if (endIndex === -1) {
    return [trimRustUseAlias(value)].filter(Boolean);
  }
  const inner = value.slice(braceIndex + 1, endIndex);
  return splitRustUseList(inner).flatMap((entry) => {
    if (entry === 'self') {
      return [prefix].filter(Boolean);
    }
    const expandedEntry = expandRustUsePath(entry);
    return expandedEntry.map((child) => [prefix, child].filter(Boolean).join('::'));
  }).filter(Boolean);
}

function findMatchingBrace(value: string, startIndex: number) {
  let depth = 0;
  for (let index = startIndex; index < value.length; index += 1) {
    const character = value[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function splitRustUseList(value: string) {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      entries.push(value.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(value.slice(start));
  return entries.map(trimRustUseAlias).filter(Boolean);
}

function trimRustUseAlias(value: string) {
  return String(value || '')
    .replace(/\sas\s.*$/u, '')
    .replace(/::\*$/u, '')
    .trim();
}

function resolveRustUsePath(
  currentModulePath: string,
  rawUsePath: string,
  fileByModulePath: Map<string, string>
) {
  const absolutePath = normalizeRustUsePath(currentModulePath, rawUsePath);
  if (!absolutePath) {
    return null;
  }
  const segments = absolutePath.split('::');
  for (let length = segments.length; length >= 1; length -= 1) {
    const candidate = segments.slice(0, length).join('::');
    const filePath = fileByModulePath.get(candidate);
    if (filePath) {
      return filePath;
    }
  }
  return null;
}

function normalizeRustUsePath(currentModulePath: string, rawUsePath: string) {
  const parts = String(rawUsePath || '')
    .split('::')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return '';
  }
  const currentParts = currentModulePath.split('::').filter(Boolean);
  const first = parts[0];
  if (first === 'crate') {
    return parts.join('::');
  }
  if (first === 'self') {
    return [...currentParts, ...parts.slice(1)].join('::');
  }
  if (first === 'super') {
    const base = currentParts.slice();
    let rest = parts.slice();
    while (rest[0] === 'super') {
      rest = rest.slice(1);
      if (base.length > 1) {
        base.pop();
      }
    }
    return [...base, ...rest].join('::');
  }
  return '';
}

function stripRustComments(source: string) {
  return String(source || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function resolveControlPlaneHealthRepoRoot(managerRootDir: string, repoId: string) {
  const normalizedRepoId = String(repoId || '').trim();
  const roots = parseRepoRootMap(process.env.AUTONOMY_CONTROL_PLANE_REPO_MAP || '', managerRootDir);
  for (const [configuredRepoId, repoRoot] of Object.entries(roots)) {
    const resolvedRoot = path.resolve(repoRoot);
    if (!fs.existsSync(resolvedRoot)) {
      continue;
    }
    if (!configuredRepoId.startsWith('__path_') && configuredRepoId === normalizedRepoId) {
      return resolvedRoot;
    }
    try {
      const config = loadControlPlaneConfig(resolvedRoot);
      if (String(config.repoId || '').trim() === normalizedRepoId) {
        return resolvedRoot;
      }
    } catch {
      // Keep trying other configured roots.
    }
  }

  try {
    const managerConfig = loadControlPlaneConfig(managerRootDir);
    if (String(managerConfig.repoId || '').trim() === normalizedRepoId) {
      return path.resolve(managerRootDir);
    }
  } catch {
    // Fall back to status snapshots.
  }

  const status = getRepoStatuses(managerRootDir)[normalizedRepoId] || null;
  const snapshotRoot = String(
    status
      && status.snapshot
      && ((status.snapshot as Record<string, unknown>).rootDir || (status.snapshot as Record<string, unknown>).repoRoot)
      || ''
  ).trim();
  if (snapshotRoot && fs.existsSync(snapshotRoot)) {
    return path.resolve(snapshotRoot);
  }

  return null;
}

function parseRepoRootMap(value: string, fallbackRepoRoot = '') {
  const repoRoots: Record<string, string> = {};
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry, index) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) {
        repoRoots[`__path_${index}`] = entry;
        return;
      }
      const repoId = entry.slice(0, separatorIndex).trim();
      const rootDir = entry.slice(separatorIndex + 1).trim();
      if (repoId && rootDir) {
        repoRoots[repoId] = rootDir;
      }
    });
  if (Object.keys(repoRoots).length === 0 && fallbackRepoRoot) {
    repoRoots.__path_0 = fallbackRepoRoot;
  }
  return repoRoots;
}

function findAnalyzerPath() {
  const candidates = [
    process.cwd(),
    path.dirname(fileURLToPath(import.meta.url)),
  ];
  for (const startDir of candidates) {
    let current = path.resolve(startDir);
    for (let index = 0; index < 8; index += 1) {
      const candidate = path.join(current, 'analyze-exports.mjs');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return null;
}

function listCandidateFiles(repoRoot: string) {
  try {
    const output = execFileSync('git', [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: MAX_ANALYZER_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .split('\0')
      .filter(Boolean)
      .map((relativePath) => path.resolve(repoRoot, relativePath));
  } catch {
    return walkFiles(repoRoot);
  }
}

function walkFiles(rootDir: string) {
  const results: string[] = [];
  const queue = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.forEach((entry) => {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          queue.push(entryPath);
        }
        return;
      }
      if (entry.isFile()) {
        results.push(entryPath);
      }
    });
  }
  return results;
}

function measureFileLineCount(filePath: string) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (isBinaryBuffer(buffer)) {
      return null;
    }
    return countLines(buffer);
  } catch {
    return null;
  }
}

function isBinaryBuffer(buffer: Buffer) {
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function countLines(buffer: Buffer) {
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

function normalizePositiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizePositiveNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function ratio(count: number, total: number) {
  return total > 0 ? count / total : 0;
}

function roundMetric(value: number, digits = 4) {
  return Number(value.toFixed(digits));
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, roundMetric(value, 2)));
}

export {
  calculateControlPlaneHealthScore,
  resolveControlPlaneHealthRepoRoot,
};
