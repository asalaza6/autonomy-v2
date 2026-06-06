import { calculateControlPlaneHealthScoreForRepoRoot } from '../../server/control-plane/control-plane-health-score.js';
import type { CliOptions } from '../autonomy-types.js';
import { printOutput } from './shared-core.js';

function run(rootDir: string, options: CliOptions = {}, command = 'health:score') {
  if (options.help === true || command === 'health:help') {
    printHealthHelp();
    return;
  }

  const repoId = String(options['repo-id'] || options.repoId || 'local').trim() || 'local';
  const result = calculateControlPlaneHealthScoreForRepoRoot(rootDir, repoId, {
    maxLines: Number(options['max-lines'] || options.maxLines),
    threshold: Number(options.threshold),
    top: Number(options.top),
  });

  if (options['score-only'] === true || options.scoreOnly === true) {
    if (options.json === true) {
      console.log(JSON.stringify({
        score: result.score ?? null,
        passed: result.passed ?? null,
        threshold: result.threshold ?? null,
        status: result.status || null,
      }, null, 2));
      return;
    }
    console.log(`${formatScore(result.score)} ${result.passed ? 'PASS' : 'FAIL'}`);
    return;
  }

  printOutput(options, result, () => {
    printHealthSummary(result, command === 'health:why');
  });
}

function printHealthSummary(result: any, explain: boolean) {
  if (result.status === 'unavailable' || result.status === 'failed') {
    console.log(`Health score unavailable: ${result.message || result.error || 'unknown error'}`);
    return;
  }

  console.log(`Health score: ${formatScore(result.score)} / 100 (${result.passed ? 'PASS' : 'FAIL'})`);
  console.log(`Mode: ${formatMode(result.mode)}`);
  console.log(`Threshold: ${result.threshold || 80}`);
  console.log(`Max file lines: ${result.maxLines || 800}`);

  const summary = result.summary || {};
  console.log(`Files: ${summary.fileCount || summary.measuredFiles || 0}`);
  console.log(`Imports: ${summary.importEdgeCount || 0}`);
  console.log(`Files over limit: ${summary.oversizedFileCount || 0}`);
  console.log(`Files in cycles: ${summary.filesInCycles || 0}`);
  console.log(`Max lines: ${summary.maxLineCount || 0}`);

  const causes = result.scoreDrag && Array.isArray(result.scoreDrag.byCause)
    ? result.scoreDrag.byCause.slice(0, explain ? 10 : 5)
    : [];
  if (causes.length > 0) {
    console.log('');
    console.log(explain ? 'Why the score is lower:' : 'Top score drag:');
    causes.forEach((cause: any, index: number) => {
      const label = [cause.componentLabel, cause.label].filter(Boolean).join(' - ');
      console.log(`${index + 1}. ${label || 'score drag'} (${formatScore(cause.pointsLost)} pts): ${cause.signal || ''}`.trim());
    });
  }

  const largeFiles = Array.isArray(result.topLargeFiles)
    ? result.topLargeFiles.slice(0, explain ? 10 : 5)
    : [];
  if (largeFiles.length > 0) {
    console.log('');
    console.log('Top large files:');
    largeFiles.forEach((file: any, index: number) => {
      console.log(`${index + 1}. ${file.file || file.path} - ${file.lineCount || 0} lines (${file.lineOverage || 0} over)`);
    });
  }
}

function formatScore(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : 'n/a';
}

function formatMode(value: unknown) {
  const mode = String(value || '').trim();
  if (mode === 'mixed-graph') {
    return 'TypeScript + Rust graph';
  }
  if (mode === 'typescript-graph') {
    return 'TypeScript graph';
  }
  if (mode === 'rust-graph') {
    return 'Rust graph';
  }
  if (mode === 'file-size-only') {
    return 'File size only';
  }
  return mode || 'unknown';
}

function printHealthHelp() {
  console.log(`
Autonomy v2 health commands

Usage:
  autonomy-v2 health:score [options]
  autonomy-v2 health:why [options]
  autonomy-v2 health:help

Common commands:
  autonomy-v2 health:score
      Print the current repo health score and a compact summary.

  autonomy-v2 health:score --score-only
      Print only the numeric score and PASS/FAIL.

  autonomy-v2 health:score --json
      Print the full machine-readable health report.

  autonomy-v2 health:why
      Print the score plus the main reasons it is lower.

Options:
  --max-lines <n>     Maximum allowed lines per file. Default: 800
  --threshold <n>     Passing score threshold. Default: 80
  --top <n>           Number of causes/files to show. Default: 10
  --repo-id <id>      Label used in JSON output. Default: local
  --root <path>       Analyze a repo at another local path
  --json              Print JSON instead of text
  --score-only        Only print score and pass/fail

What it measures:
  - file size, especially files over the max line limit
  - import cycles
  - import graph shape for TypeScript and Rust when available

More detail:
  docs/health-score.md
`);
}

export { run };
