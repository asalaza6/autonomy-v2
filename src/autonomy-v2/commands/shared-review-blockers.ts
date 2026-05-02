import fs from 'fs';
import path from 'path';
import type {
  AnyRecord,
  PullRequestRecord,
  ReviewDecisionRecord,
  ReviewerBlockerCheckResultRecord,
  ReviewerBlockerEvidenceRecord,
  ReviewerBlockerRecord,
  ReviewerBlockerStatusRecord,
  ReviewerBlockerVerificationTargetRecord,
  TaskRecord,
} from '../autonomy-types.js';

function normalizeReviewSummaryLines(summary: string): string[] {
  const paragraphs = String(summary || '')
    .split(/\n\s*\n+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const lines: string[] = [];
  paragraphs.forEach((paragraph) => {
    const bulletLines = paragraph
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => entry.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim())
      .filter(Boolean);
    if (bulletLines.length > 1) {
      lines.push(...bulletLines);
      return;
    }
    lines.push(paragraph);
  });
  return lines;
}

function uniqueStrings(values: string[] = []): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function sortStrings(values: string[] = []): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function looksLikeCommand(value: string): boolean {
  return /^(npm|pnpm|yarn|npx|node|pytest|jest|vitest|cargo|go test)\b/i.test(value.trim());
}

function sanitizeCommand(value: string): string {
  return String(value || '')
    .trim()
    .replace(/`.*$/g, '')
    .replace(/[`'".,;:!?]+$/g, '')
    .replace(/\s+(before|after|once|when)\b.*$/i, '')
    .trim();
}

function extractCommands(text: string): string[] {
  const commands: string[] = [];
  const literalMatches = text.match(/`([^`]+)`/g) || [];
  literalMatches.forEach((match) => {
    const candidate = sanitizeCommand(match.slice(1, -1));
    if (looksLikeCommand(candidate)) {
      commands.push(candidate);
    }
  });

  const plainPatterns = [
    /\bnpm run [a-z0-9:_-]+(?:\s+--?[^\n,;]+|\s+[a-z0-9:_./-]+)*/gi,
    /\bnpm test(?:\s+--?[^\n,;]+|\s+[a-z0-9:_./-]+)*/gi,
    /\bpnpm (?:run )?[a-z0-9:_-]+(?:\s+--?[^\n,;]+|\s+[a-z0-9:_./-]+)*/gi,
    /\byarn [a-z0-9:_-]+(?:\s+--?[^\n,;]+|\s+[a-z0-9:_./-]+)*/gi,
    /\bnpx [a-z0-9:_./-]+(?:\s+--?[^\n,;]+|\s+[a-z0-9:_./-]+)*/gi,
  ];
  plainPatterns.forEach((pattern) => {
    const matches = text.match(pattern) || [];
    matches.forEach((match) => {
      const candidate = sanitizeCommand(match);
      if (looksLikeCommand(candidate)) {
        commands.push(candidate);
      }
    });
  });
  return uniqueStrings(commands);
}

function classifyReviewerBlocker(text: string, commands: string[]): ReviewerBlockerRecord['category'] {
  const normalized = text.toLowerCase();
  if (commands.length > 0 || /(test|check|verify|verification|evidence|proof|repro|typecheck|lint)/.test(normalized)) {
    return 'verification';
  }
  if (/(scope|out-of-scope|unexpected file|extra file|unreviewed diff)/.test(normalized)) {
    return 'scope';
  }
  if (/(doc|docs|documentation|readme|comment)/.test(normalized)) {
    return 'documentation';
  }
  if (/(bug|regression|incorrect|wrong|broken|unsafe|fail|missing|block)/.test(normalized)) {
    return 'correctness';
  }
  return 'other';
}

function normalizePathLikeToken(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^[`'"]+|[`'",.;:!?]+$/g, '')
    .replace(/\\/g, '/');
}

function extractReferencedFiles(text: string): string[] {
  const normalized = String(text || '');
  const matches = normalized.match(/(?:^|[\s`'"])([A-Za-z0-9._/-]+\.[A-Za-z0-9_-]+)(?=$|[\s`'",.;:!?])/g) || [];
  return uniqueStrings(matches.map((entry) => normalizePathLikeToken(entry)));
}

function normalizePackageScripts(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, candidate]) => {
    const script = String(candidate || '').trim();
    if (script) {
      acc[key] = script;
    }
    return acc;
  }, {});
}

function readPackageScripts(worktreePath: string): Record<string, string> {
  const manifestPath = path.join(worktreePath, 'package.json');
  if (!worktreePath || !fs.existsSync(manifestPath)) {
    return {};
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return normalizePackageScripts(manifest && manifest.scripts);
  } catch (_) {
    return {};
  }
}

function normalizeTestExecutionPath(filePath: string): string {
  const normalized = normalizePathLikeToken(filePath);
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('dist/')) {
    return normalized;
  }
  if (/^tests\/.+\.tsx?$/i.test(normalized)) {
    return normalized
      .replace(/^tests\//, 'dist/tests/')
      .replace(/\.tsx?$/i, '.js');
  }
  return normalized;
}

const CONTROL_PLANE_SUMMARY_UI_SCRIPT = 'test:control-plane-summary-ui';
const CONTROL_PLANE_SUMMARY_UI_FILES = new Set([
  'src/server/control-plane/control-plane-client.tsx',
  'src/server/control-plane/control-plane-page.tsx',
  'tests/unit/control-plane-summary-ui.test.ts',
  'tests/unit/control-plane-restart-ui.test.ts',
]);

function buildFocusedTestFileCommand(referencedFiles: string[]): string[] {
  const testTargets = uniqueStrings(
    referencedFiles
      .filter((candidate) => /(^|\/)(tests|test)\/.+\.test\.[cm]?[jt]sx?$/i.test(candidate) || /(^|\/).+\.test\.[cm]?[jt]sx?$/i.test(candidate))
      .map((candidate) => normalizeTestExecutionPath(candidate))
      .filter(Boolean)
  );
  if (testTargets.length === 0) {
    return [];
  }
  return [`npm run build && node --test ${testTargets.join(' ')}`];
}

function extractScriptTestTargets(command: string): string[] {
  const normalizedCommand = String(command || '').trim();
  if (!normalizedCommand || !/\bnode\s+--test\b/.test(normalizedCommand)) {
    return [];
  }

  const tokens = normalizedCommand
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const nodeTestIndex = tokens.findIndex((entry, index) => entry === '--test' && tokens[index - 1] === 'node');
  if (nodeTestIndex < 0) {
    return [];
  }

  return uniqueStrings(
    tokens
      .slice(nodeTestIndex + 1)
      .filter((entry) => entry.startsWith('dist/tests/') && entry.endsWith('.js'))
  );
}

function resolveScriptCommandsForTestFiles(testFiles: string[], scripts: Record<string, string>): string[] {
  const normalizedTestTargets = new Set(
    uniqueStrings(testFiles.map((entry) => normalizeTestExecutionPath(entry)).filter(Boolean))
  );
  if (normalizedTestTargets.size === 0) {
    return [];
  }

  return uniqueStrings(
    Object.entries(scripts)
      .filter(([, command]) => {
        const scriptTargets = extractScriptTestTargets(command);
        return (
          scriptTargets.length > 0
          && scriptTargets.every((target) => normalizedTestTargets.has(target))
        );
      })
      .sort((left, right) => {
        const leftTargets = extractScriptTestTargets(left[1]).length;
        const rightTargets = extractScriptTestTargets(right[1]).length;
        if (leftTargets !== rightTargets) {
          return leftTargets - rightTargets;
        }
        return left[0].localeCompare(right[0]);
      })
      .map(([scriptName]) => `npm run ${scriptName}`)
  );
}

function resolveWorktreePath(options: AnyRecord = {}): string {
  const explicitWorktreePath = String(options.worktreePath || '').trim();
  if (explicitWorktreePath) {
    return explicitWorktreePath;
  }
  return process.cwd();
}

function listUnitTestFiles(options: AnyRecord = {}): string[] {
  const provided = Array.isArray(options.availableTestFiles)
    ? options.availableTestFiles.map((entry) => normalizePathLikeToken(entry)).filter(Boolean)
    : [];
  if (provided.length > 0) {
    return uniqueStrings(provided);
  }

  const worktreePath = resolveWorktreePath(options);
  const unitTestsDir = path.join(worktreePath, 'tests', 'unit');
  if (!fs.existsSync(unitTestsDir)) {
    return [];
  }

  const discovered: string[] = [];
  const visitDirectory = (directoryPath: string) => {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    entries.forEach((entry) => {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(entryPath);
        return;
      }
      if (entry.isFile() && /\.test\.[cm]?[jt]sx?$/i.test(entry.name)) {
        discovered.push(normalizePathLikeToken(path.relative(worktreePath, entryPath)));
      }
    });
  };

  try {
    visitDirectory(unitTestsDir);
    return sortStrings(uniqueStrings(discovered));
  } catch (_) {
    return [];
  }
}

function stripKnownFileExtensions(filePath: string): string {
  return path.basename(filePath).replace(/\.(?:test\.)?[cm]?[jt]sx?$/i, '');
}

function buildChangedFileImportCandidates(testFile: string, changedFile: string): string[] {
  const normalizedTestFile = normalizePathLikeToken(testFile);
  const normalizedChangedFile = normalizePathLikeToken(changedFile);
  if (!normalizedTestFile || !normalizedChangedFile) {
    return [];
  }

  const relativeImportPath = normalizePathLikeToken(
    path.posix.relative(path.posix.dirname(normalizedTestFile), normalizedChangedFile)
  );
  const relativeWithoutExtension = relativeImportPath.replace(/\.[^/.]+$/g, '');
  const prefixedRelativePath = relativeWithoutExtension.startsWith('.')
    ? relativeWithoutExtension
    : `./${relativeWithoutExtension}`;
  const prefixedRelativeJsPath = prefixedRelativePath.endsWith('.js')
    ? prefixedRelativePath
    : `${prefixedRelativePath}.js`;

  return uniqueStrings([
    prefixedRelativePath,
    prefixedRelativeJsPath,
    path.posix.basename(relativeWithoutExtension),
    path.posix.basename(normalizedChangedFile).replace(/\.[^/.]+$/g, ''),
  ]);
}

function resolveReferencedUnitTestFiles(
  changedFiles: string[],
  testFiles: string[],
  options: AnyRecord = {}
): string[] {
  const worktreePath = resolveWorktreePath(options);
  const matchedTests = new Set<string>();

  testFiles.forEach((testFile) => {
    const absoluteTestPath = path.join(worktreePath, testFile);
    if (!fs.existsSync(absoluteTestPath)) {
      return;
    }

    let content = '';
    try {
      content = fs.readFileSync(absoluteTestPath, 'utf8');
    } catch (_) {
      return;
    }

    const referencesChangedFile = changedFiles.some((changedFile) => buildChangedFileImportCandidates(testFile, changedFile)
      .some((candidate) => content.includes(`'${candidate}'`) || content.includes(`"${candidate}"`)));
    if (referencesChangedFile) {
      matchedTests.add(testFile);
    }
  });

  return sortStrings(Array.from(matchedTests));
}

function resolveFocusedChangedFileTestFiles(changedFiles: string[], testFiles: string[], options: AnyRecord = {}): string[] {
  const normalizedChangedFiles = uniqueStrings(changedFiles.map((entry) => normalizePathLikeToken(entry)).filter(Boolean));
  const normalizedTestFiles = uniqueStrings(testFiles.map((entry) => normalizePathLikeToken(entry)).filter(Boolean));
  if (normalizedChangedFiles.length === 0 || normalizedTestFiles.length === 0) {
    return [];
  }

  const exactMatches = new Set<string>();
  const prefixMatches = new Set<string>();

  normalizedChangedFiles.forEach((filePath) => {
    const sourceStem = stripKnownFileExtensions(filePath);
    if (!sourceStem) {
      return;
    }

    normalizedTestFiles.forEach((testFile) => {
      const testStem = stripKnownFileExtensions(testFile);
      if (!testStem) {
        return;
      }
      if (testStem === sourceStem) {
        exactMatches.add(testFile);
        return;
      }
      if (testStem.startsWith(`${sourceStem}-`) || sourceStem.startsWith(`${testStem}-`)) {
        prefixMatches.add(testFile);
      }
    });
  });

  return exactMatches.size > 0
    ? sortStrings(Array.from(exactMatches))
    : prefixMatches.size > 0
      ? sortStrings(Array.from(prefixMatches))
      : resolveReferencedUnitTestFiles(normalizedChangedFiles, normalizedTestFiles, options);
}

function detectReferencedAreas(text: string): string[] {
  const normalized = String(text || '').toLowerCase();
  const areas: string[] = [];
  if (/\btypecheck\b|\btypes?\b/.test(normalized)) {
    areas.push('typecheck');
  }
  if (/\blint\b/.test(normalized)) {
    areas.push('lint');
  }
  if (/\bsmoke\b/.test(normalized)) {
    areas.push('smoke');
  }
  if (/\bunit tests?\b|\bunit verification\b/.test(normalized)) {
    areas.push('unit');
  }
  if (/\bcontrol plane summary ui\b|\bsummary ui\b|\brestart ui\b/.test(normalized)) {
    areas.push('control-plane-summary-ui');
  }
  return uniqueStrings(areas);
}

function detectChangedFileAreas(changedFiles: string[] = []): string[] {
  const normalizedChangedFiles = uniqueStrings(changedFiles.map((entry) => normalizePathLikeToken(entry)).filter(Boolean));
  const areas: string[] = [];
  if (normalizedChangedFiles.some((filePath) => CONTROL_PLANE_SUMMARY_UI_FILES.has(filePath))) {
    areas.push('control-plane-summary-ui');
  }
  if (normalizedChangedFiles.some((filePath) => /(^|\/)(package\.json|tsconfig(?:\.[^.]+)?\.json)$/.test(filePath))) {
    areas.push('typecheck');
  }
  if (normalizedChangedFiles.some((filePath) => filePath.startsWith('tests/smoke/'))) {
    areas.push('smoke');
  }
  const hasSpecificArea = areas.some((area) => !['typecheck', 'lint', 'smoke', 'unit'].includes(area));
  if (
    !hasSpecificArea
    && normalizedChangedFiles.some((filePath) => /^(src\/(autonomy-v2|agents|sync)\/|tests\/unit\/)/.test(filePath))
  ) {
    areas.push('unit');
  }
  return uniqueStrings(areas);
}

function hasSpecificVerificationArea(areas: string[]): boolean {
  return areas.some((area) => !['typecheck', 'lint', 'smoke', 'unit'].includes(area));
}

function resolveAreaCommands(areas: string[], scripts: Record<string, string>): string[] {
  const commands: string[] = [];
  const pushScript = (scriptName: string) => {
    if (typeof scripts[scriptName] === 'string' && scripts[scriptName].trim()) {
      commands.push(`npm run ${scriptName}`);
    }
  };
  areas.forEach((area) => {
    if (area === 'typecheck') {
      pushScript('typecheck');
    } else if (area === 'lint') {
      pushScript('lint');
    } else if (area === 'smoke') {
      pushScript('smoke');
    } else if (area === 'control-plane-summary-ui') {
      pushScript(CONTROL_PLANE_SUMMARY_UI_SCRIPT);
    } else if (area === 'unit') {
      commands.push('npm run build && node --test dist/tests/unit/*.test.js');
    }
  });
  return uniqueStrings(commands);
}

function resolveChangedFileAreaCommands(changedFiles: string[], scripts: Record<string, string>): {
  areas: string[];
  commands: string[];
} {
  const areas = detectChangedFileAreas(changedFiles);
  return {
    areas,
    commands: resolveAreaCommands(areas, scripts),
  };
}

function resolveFocusedChangedFileCommands(
  changedFiles: string[],
  scripts: Record<string, string>,
  options: AnyRecord = {}
): string[] {
  const normalizedChangedFiles = uniqueStrings(changedFiles.map((entry) => normalizePathLikeToken(entry)).filter(Boolean));
  if (normalizedChangedFiles.length === 0) {
    return [];
  }

  const directTestCommands = buildFocusedTestFileCommand(normalizedChangedFiles);
  if (directTestCommands.length > 0) {
    return directTestCommands;
  }

  const focusedChangedTests = resolveFocusedChangedFileTestFiles(
    normalizedChangedFiles,
    listUnitTestFiles(options),
    options
  );
  const focusedScriptCommands = resolveScriptCommandsForTestFiles(focusedChangedTests, scripts);
  if (focusedScriptCommands.length > 0) {
    return focusedScriptCommands;
  }

  const focusedSourceTestCommands = buildFocusedTestFileCommand(focusedChangedTests);
  if (focusedSourceTestCommands.length > 0) {
    return focusedSourceTestCommands;
  }

  return [];
}

function resolveChangedFileCommands(
  changedFiles: string[],
  scripts: Record<string, string>,
  options: AnyRecord = {}
): {
  commands: string[];
  specificity: 'direct' | 'inferred' | 'fallback';
} {
  const normalizedChangedFiles = uniqueStrings(changedFiles.map((entry) => normalizePathLikeToken(entry)).filter(Boolean));
  if (normalizedChangedFiles.length === 0) {
    return { commands: [], specificity: 'fallback' };
  }

  const directTestCommands = buildFocusedTestFileCommand(normalizedChangedFiles);
  if (directTestCommands.length > 0) {
    return {
      commands: directTestCommands,
      specificity: 'direct',
    };
  }

  const focusedChangedFileCommands = resolveFocusedChangedFileCommands(normalizedChangedFiles, scripts, options);
  if (focusedChangedFileCommands.length > 0) {
    return {
      commands: focusedChangedFileCommands,
      specificity: 'inferred',
    };
  }

  if (normalizedChangedFiles.some((filePath) => filePath.startsWith('src/server/control-plane/'))) {
    return {
      commands: ['npm run build && node --test dist/tests/unit/control-plane-*.test.js'],
      specificity: 'fallback',
    };
  }

  if (normalizedChangedFiles.some((filePath) => /^(src\/(autonomy-v2|agents|sync)\/|tests\/unit\/)/.test(filePath))) {
    return {
      commands: ['npm run build && node --test dist/tests/unit/*.test.js'],
      specificity: 'fallback',
    };
  }

  if (
    normalizedChangedFiles.some((filePath) => /(^|\/)(package\.json|tsconfig(?:\.[^.]+)?\.json)$/.test(filePath))
    && typeof scripts.typecheck === 'string'
    && scripts.typecheck.trim()
  ) {
    return {
      commands: ['npm run typecheck'],
      specificity: 'fallback',
    };
  }

  return {
    commands: [],
    specificity: 'fallback',
  };
}

function reviewerAreasAreBroadVerificationBuckets(areas: string[]): boolean {
  if (areas.length === 0) {
    return false;
  }
  return areas.every((area) => ['unit', 'smoke', 'lint', 'typecheck'].includes(area));
}

function reviewRequestsChangedFileVerification(text: string): boolean {
  const normalized = String(text || '').toLowerCase();
  return /\b(files?\s+(?:touched|changed|modified)|touched here|files?\s+in\s+(?:this\s+)?(?:diff|pr|patch)|changed files?|affected files?)\b/.test(normalized);
}

function changedFileAreasCoverReferencedAreas(referencedAreas: string[], changedFileAreas: string[]): boolean {
  if (referencedAreas.length === 0 || changedFileAreas.length === 0) {
    return false;
  }
  const changedAreaSet = new Set(changedFileAreas);
  return referencedAreas.every((area) => changedAreaSet.has(area));
}

function shouldPreferChangedFileVerificationTarget(
  referencedFiles: string[],
  changedFiles: string[],
  referencedAreas: string[],
  changedFileAreas: string[]
): boolean {
  const changedFileSet = new Set(changedFiles);
  return (
    referencedFiles.some((filePath) => changedFileSet.has(filePath))
    || changedFileAreasCoverReferencedAreas(referencedAreas, changedFileAreas)
    || reviewerAreasAreBroadVerificationBuckets(referencedAreas)
    || referencedAreas.length === 0
  );
}

function shouldUseChangedFileVerificationTarget(
  text: string,
  referencedFiles: string[],
  changedFiles: string[],
  referencedAreas: string[],
  changedFileTarget: ReviewerBlockerVerificationTargetRecord | null
): boolean {
  if (!changedFileTarget || changedFiles.length === 0) {
    return false;
  }

  if (referencedFiles.length === 0 && referencedAreas.length === 0) {
    return true;
  }

  if (reviewRequestsChangedFileVerification(text)) {
    return true;
  }

  return shouldPreferChangedFileVerificationTarget(
    referencedFiles,
    changedFiles,
    referencedAreas,
    Array.isArray(changedFileTarget.referencedAreas) ? changedFileTarget.referencedAreas : []
  );
}

function selectChangedFilesForVerification(referencedFiles: string[], changedFiles: string[]): string[] {
  const normalizedChangedFiles = uniqueStrings(changedFiles.map((entry) => normalizePathLikeToken(entry)).filter(Boolean));
  if (normalizedChangedFiles.length === 0) {
    return [];
  }

  const changedFileSet = new Set(normalizedChangedFiles);
  const referencedChangedFiles = uniqueStrings(
    referencedFiles
      .map((entry) => normalizePathLikeToken(entry))
      .filter((entry) => changedFileSet.has(entry))
  );

  return referencedChangedFiles.length > 0
    ? referencedChangedFiles
    : normalizedChangedFiles;
}

function resolveDeterministicChangedFileVerification(
  changedFiles: string[],
  scripts: Record<string, string>,
  options: AnyRecord = {}
): {
  areas: string[];
  commands: string[];
  specificity: 'direct' | 'inferred' | 'fallback';
} {
  const normalizedChangedFiles = uniqueStrings(changedFiles.map((entry) => normalizePathLikeToken(entry)).filter(Boolean));
  const { areas: changedFileAreas, commands: changedFileAreaCommands } = resolveChangedFileAreaCommands(
    normalizedChangedFiles,
    scripts
  );
  const changedFileCommandTarget = resolveChangedFileCommands(normalizedChangedFiles, scripts, options);

  if (changedFileCommandTarget.specificity === 'direct') {
    return {
      areas: changedFileAreas,
      commands: changedFileCommandTarget.commands,
      specificity: changedFileCommandTarget.specificity,
    };
  }

  if (
    changedFileCommandTarget.specificity === 'inferred'
    && !(hasSpecificVerificationArea(changedFileAreas) && changedFileAreaCommands.length > 0)
  ) {
    return {
      areas: changedFileAreas,
      commands: changedFileCommandTarget.commands,
      specificity: changedFileCommandTarget.specificity,
    };
  }

  return {
    areas: changedFileAreas,
    commands: changedFileAreaCommands.length > 0
      ? changedFileAreaCommands
      : changedFileCommandTarget.commands,
    specificity: changedFileCommandTarget.specificity,
  };
}

function resolveChangedFileVerificationTarget(
  referencedFiles: string[],
  changedFiles: string[],
  scripts: Record<string, string>,
  options: AnyRecord = {}
): ReviewerBlockerVerificationTargetRecord | null {
  const targetFiles = selectChangedFilesForVerification(referencedFiles, changedFiles);
  const changedFileResolution = resolveDeterministicChangedFileVerification(targetFiles, scripts, options);
  const resolvedCommands = changedFileResolution.commands;
  if (resolvedCommands.length > 0) {
    return {
      source: 'changed_files',
      referencedFiles,
      referencedAreas: changedFileResolution.areas,
      changedFiles: targetFiles,
      resolvedCommands,
      unresolvedReason: null,
    };
  }

  return null;
}

function resolveVerificationCommandsFromChangedFiles(
  changedFiles: string[],
  options: AnyRecord = {}
): ReviewerBlockerVerificationTargetRecord | null {
  const optionScripts = normalizePackageScripts(options.packageScripts);
  const scripts = Object.keys(optionScripts).length > 0
    ? optionScripts
    : readPackageScripts(resolveWorktreePath(options));
  return resolveChangedFileVerificationTarget([], changedFiles, scripts, options);
}

function resolveMentionedAreaVerificationTarget(
  referencedFiles: string[],
  referencedAreas: string[],
  changedFiles: string[],
  scripts: Record<string, string>
): ReviewerBlockerVerificationTargetRecord | null {
  const resolvedCommands = resolveAreaCommands(referencedAreas, scripts);
  if (resolvedCommands.length === 0) {
    return null;
  }
  return {
    source: 'mentioned_area',
    referencedFiles,
    referencedAreas,
    changedFiles,
    resolvedCommands,
    unresolvedReason: null,
  };
}

function resolveVerificationTargetFromReviewIntent(
  text: string,
  referencedFiles: string[],
  referencedAreas: string[],
  changedFiles: string[],
  scripts: Record<string, string>,
  options: AnyRecord = {}
): ReviewerBlockerVerificationTargetRecord | null {
  const changedFileTarget = resolveChangedFileVerificationTarget(referencedFiles, changedFiles, scripts, options);
  const mentionedAreaTarget = resolveMentionedAreaVerificationTarget(
    referencedFiles,
    referencedAreas,
    changedFiles,
    scripts
  );

  if (!changedFileTarget) {
    return mentionedAreaTarget;
  }

  if (reviewRequestsChangedFileVerification(text)) {
    return changedFileTarget;
  }

  if (!mentionedAreaTarget) {
    return changedFileTarget;
  }

  return shouldUseChangedFileVerificationTarget(
    text,
    referencedFiles,
    changedFiles,
    referencedAreas,
    changedFileTarget
  )
    ? changedFileTarget
    : mentionedAreaTarget;
}

function resolveVerificationTarget(text: string, options: AnyRecord = {}): ReviewerBlockerVerificationTargetRecord {
  const optionScripts = normalizePackageScripts(options.packageScripts);
  const scripts = Object.keys(optionScripts).length > 0
    ? optionScripts
    : readPackageScripts(resolveWorktreePath(options));
  const changedFiles = uniqueStrings(Array.isArray(options.changedFiles) ? options.changedFiles.map((entry) => normalizePathLikeToken(entry)) : []);
  const referencedFiles = extractReferencedFiles(text);
  const literalCommands = extractCommands(text);
  if (literalCommands.length > 0) {
    return {
      source: 'literal_command',
      referencedFiles,
      changedFiles,
      resolvedCommands: literalCommands,
      unresolvedReason: null,
    };
  }

  const testFileCommands = buildFocusedTestFileCommand(referencedFiles);
  if (testFileCommands.length > 0) {
    return {
      source: 'mentioned_test_file',
      referencedFiles,
      changedFiles,
      resolvedCommands: testFileCommands,
      unresolvedReason: null,
    };
  }

  const referencedAreas = detectReferencedAreas(text);
  const intentResolvedTarget = resolveVerificationTargetFromReviewIntent(
    text,
    referencedFiles,
    referencedAreas,
    changedFiles,
    scripts,
    options
  );
  if (intentResolvedTarget) {
    return intentResolvedTarget;
  }

  const ambiguityReason = referencedFiles.length > 0
    ? `No runnable verification command could be resolved from: ${referencedFiles.join(', ')}`
    : changedFiles.length > 0
      ? `Reviewer requested verification for changed files, but no runnable command could be resolved for: ${changedFiles.join(', ')}`
      : 'Reviewer requested verification, but no runnable command, test file, or known area could be resolved.';
  return {
    source: 'unresolved',
    referencedFiles,
    referencedAreas: detectChangedFileAreas(changedFiles),
    changedFiles,
    resolvedCommands: [],
    unresolvedReason: ambiguityReason,
  };
}

function buildRequiredEvidence(
  category: ReviewerBlockerRecord['category'],
  text: string,
  commands: string[],
  verificationTarget?: ReviewerBlockerVerificationTargetRecord
): ReviewerBlockerEvidenceRecord[] {
  if (commands.length > 0) {
    return commands.map((command) => ({
      kind: 'command_output',
      label: `Record output for ${command}`,
      command,
    }));
  }
  if (category === 'verification') {
    return [{
      kind: 'note',
      label: 'Provide focused verification evidence',
      detail: String(verificationTarget && verificationTarget.unresolvedReason || text).trim(),
    }];
  }
  if (category === 'documentation') {
    return [{
      kind: 'code_change',
      label: 'Update the requested documentation or comments',
      detail: text,
    }];
  }
  return [{
    kind: 'code_change',
    label: 'Implement the requested code change',
    detail: text,
  }];
}

function buildReviewerBlockersFromReview(
  pr: { id?: string; reviews?: unknown[] },
  decisionRecord: ReviewDecisionRecord,
  options: AnyRecord = {}
): ReviewerBlockerRecord[] {
  const summaryLines = normalizeReviewSummaryLines(String(decisionRecord.summary || ''));
  const explicitReviewRound = Number((decisionRecord as any).reviewRound || 0);
  const reviewRound = Number.isFinite(explicitReviewRound) && explicitReviewRound > 0
    ? explicitReviewRound
    : Math.max(1, Array.isArray(pr && pr.reviews) ? pr.reviews.length : 0);
  return summaryLines.map((summary, index) => {
    const literalCommands = extractCommands(summary);
    const category = classifyReviewerBlocker(summary, literalCommands);
    const verificationTarget = category === 'verification'
      ? resolveVerificationTarget(summary, options)
      : undefined;
    const requiredChecks = category === 'verification'
      ? uniqueStrings(Array.isArray(verificationTarget && verificationTarget.resolvedCommands) ? verificationTarget.resolvedCommands : literalCommands)
      : literalCommands;
    const unresolvedReason = category === 'verification'
      ? String(verificationTarget && verificationTarget.unresolvedReason || '').trim() || null
      : null;
    return {
      id: `${String(pr && pr.id || 'pr').trim() || 'pr'}-review-blocker-${reviewRound || 1}-${index + 1}`,
      category,
      summary,
      requiredChecks,
      requiredEvidence: buildRequiredEvidence(category, summary, requiredChecks, verificationTarget),
      verificationTarget,
      status: {
        state: 'open',
        satisfiedAt: null,
        satisfiedByTaskId: null,
        dismissedAt: null,
        dismissalReason: null,
        evidence: [],
        unresolvedReason,
        lastCheckResults: [],
      },
      sourceReview: {
        reviewerId: decisionRecord.reviewerId,
        reviewRound: reviewRound || 1,
        reviewedAt: decisionRecord.reviewedAt,
        conversationId: decisionRecord.conversationId,
      },
    };
  });
}

function collectReviewerBlockerChecks(blockers: ReviewerBlockerRecord[] = []): string[] {
  return uniqueStrings(blockers.flatMap((blocker) => Array.isArray(blocker.requiredChecks) ? blocker.requiredChecks : []));
}

function normalizeReviewerBlockerEvidence(evidence: ReviewerBlockerEvidenceRecord): ReviewerBlockerEvidenceRecord {
  return {
    kind: evidence.kind,
    label: String(evidence.label || '').trim(),
    command: evidence.command ? String(evidence.command).trim() : undefined,
    detail: evidence.detail ? String(evidence.detail).trim() : undefined,
  };
}

function normalizeReviewerBlockerCheckResult(result: ReviewerBlockerCheckResultRecord): ReviewerBlockerCheckResultRecord {
  return {
    command: String(result && result.command || '').trim(),
    status: String(result && result.status || '').trim(),
    code: result && result.code !== undefined ? Number(result.code) : undefined,
    output: result && result.output ? String(result.output).trim() : undefined,
  };
}

function normalizeReviewerBlockerVerificationTarget(value: ReviewerBlockerVerificationTargetRecord | null | undefined): ReviewerBlockerVerificationTargetRecord | undefined {
  if (!value) {
    return undefined;
  }
  const source = String(value.source || '').trim();
  if (!source) {
    return undefined;
  }
  return {
    source: ([
      'literal_command',
      'mentioned_test_file',
      'mentioned_area',
      'changed_files',
      'unresolved',
    ].includes(source) ? source : 'unresolved') as ReviewerBlockerVerificationTargetRecord['source'],
    referencedFiles: uniqueStrings(Array.isArray(value.referencedFiles) ? value.referencedFiles.map((entry) => normalizePathLikeToken(entry)) : []),
    referencedAreas: uniqueStrings(Array.isArray(value.referencedAreas) ? value.referencedAreas.map((entry) => String(entry || '').trim()) : []),
    changedFiles: uniqueStrings(Array.isArray(value.changedFiles) ? value.changedFiles.map((entry) => normalizePathLikeToken(entry)) : []),
    resolvedCommands: uniqueStrings(Array.isArray(value.resolvedCommands) ? value.resolvedCommands.map((entry) => String(entry || '').trim()) : []),
    unresolvedReason: value.unresolvedReason ? String(value.unresolvedReason).trim() : null,
  };
}

function normalizeReviewerBlockerStatus(status: ReviewerBlockerStatusRecord | null | undefined): ReviewerBlockerStatusRecord {
  return {
    state: status && (status.state === 'satisfied' || status.state === 'dismissed') ? status.state : 'open',
    satisfiedAt: status && status.satisfiedAt ? String(status.satisfiedAt) : null,
    satisfiedByTaskId: status && status.satisfiedByTaskId ? String(status.satisfiedByTaskId) : null,
    dismissedAt: status && status.dismissedAt ? String(status.dismissedAt) : null,
    dismissalReason: status && status.dismissalReason ? String(status.dismissalReason) : null,
    evidence: Array.isArray(status && status.evidence)
      ? status.evidence.map((entry) => normalizeReviewerBlockerEvidence(entry))
      : [],
    unresolvedReason: status && status.unresolvedReason ? String(status.unresolvedReason).trim() : null,
    lastCheckResults: Array.isArray(status && status.lastCheckResults)
      ? status.lastCheckResults.map((entry) => normalizeReviewerBlockerCheckResult(entry)).filter((entry) => entry.command && entry.status)
      : [],
  };
}

function normalizeReviewerBlocker(blocker: ReviewerBlockerRecord): ReviewerBlockerRecord {
  return {
    ...blocker,
    id: String(blocker && blocker.id || '').trim(),
    category: blocker && blocker.category || 'other',
    summary: String(blocker && blocker.summary || '').trim(),
    requiredChecks: uniqueStrings(Array.isArray(blocker && blocker.requiredChecks) ? blocker.requiredChecks : []),
    requiredEvidence: Array.isArray(blocker && blocker.requiredEvidence)
      ? blocker.requiredEvidence.map((entry) => normalizeReviewerBlockerEvidence(entry))
      : [],
    verificationTarget: normalizeReviewerBlockerVerificationTarget(blocker && blocker.verificationTarget),
    status: normalizeReviewerBlockerStatus(blocker && blocker.status),
    sourceReview: blocker && blocker.sourceReview ? { ...blocker.sourceReview } : undefined,
  };
}

function isReviewerBlockerResolved(blocker: ReviewerBlockerRecord | null | undefined): boolean {
  const state = normalizeReviewerBlockerStatus(blocker && blocker.status).state;
  return state === 'satisfied' || state === 'dismissed';
}

function listUnresolvedReviewerBlockers(blockers: ReviewerBlockerRecord[] = []): ReviewerBlockerRecord[] {
  return blockers
    .map((blocker) => normalizeReviewerBlocker(blocker))
    .filter((blocker) => !isReviewerBlockerResolved(blocker));
}

function buildEvidenceIdentity(evidence: ReviewerBlockerEvidenceRecord): string {
  return [
    evidence.kind,
    String(evidence.label || '').trim(),
    String(evidence.command || '').trim(),
    String(evidence.detail || '').trim(),
  ].join('::');
}

function mergeReviewerBlockerEvidence(
  existingEvidence: ReviewerBlockerEvidenceRecord[] = [],
  newEvidence: ReviewerBlockerEvidenceRecord[] = []
): { evidence: ReviewerBlockerEvidenceRecord[]; addedCount: number; } {
  const merged: ReviewerBlockerEvidenceRecord[] = [];
  const seen = new Set<string>();

  existingEvidence.concat(newEvidence).forEach((entry) => {
    const normalized = normalizeReviewerBlockerEvidence(entry);
    const identity = buildEvidenceIdentity(normalized);
    if (!normalized.label || seen.has(identity)) {
      return;
    }
    seen.add(identity);
    merged.push(normalized);
  });

  let addedCount = 0;
  const existingIds = new Set(existingEvidence.map((entry) => buildEvidenceIdentity(normalizeReviewerBlockerEvidence(entry))));
  merged.forEach((entry) => {
    if (!existingIds.has(buildEvidenceIdentity(entry))) {
      addedCount += 1;
    }
  });
  return { evidence: merged, addedCount };
}

function buildCommandEvidence(command: string, result: AnyRecord | null | undefined): ReviewerBlockerEvidenceRecord {
  const status = String(result && result.status || 'passed').trim() || 'passed';
  const detail = [
    `Command passed: ${command}`,
    result && result.code !== undefined ? `(exit ${result.code})` : '',
  ].filter(Boolean).join(' ');
  return {
    kind: 'command_output',
    label: `Record output for ${command}`,
    command,
    detail: status === 'passed' ? detail : `Command status ${status}: ${command}`,
  };
}

function buildCodeChangeEvidence(blocker: ReviewerBlockerRecord, changedFiles: string[]): ReviewerBlockerEvidenceRecord {
  const blockerReferenceText = String(
    blocker.summary
    || (blocker.requiredEvidence && blocker.requiredEvidence[0] && blocker.requiredEvidence[0].detail)
    || ''
  );
  const referencedFiles = extractReferencedFiles(blockerReferenceText);
  const matchedFiles = referencedFiles.length > 0
    ? changedFiles.filter((file) => referencedFiles.includes(normalizePathLikeToken(file)))
    : [];
  return {
    kind: 'code_change',
    label: blocker.category === 'documentation'
      ? 'Update the requested documentation or comments'
      : 'Implement the requested code change',
    detail: referencedFiles.length > 0
      ? ['Matched requested files:', matchedFiles.join(', ')].filter(Boolean).join(' ')
      : `Changed files: ${changedFiles.join(', ')}`,
  };
}

function extractChangedFilesFromEvidenceDetail(detail: string): string[] {
  const normalized = String(detail || '').trim();
  const prefix = normalized.startsWith('Matched requested files:')
    ? 'Matched requested files:'
    : normalized.startsWith('Changed files:')
      ? 'Changed files:'
      : '';
  if (!prefix) {
    return [];
  }
  return uniqueStrings(
    normalized
      .slice(prefix.length)
      .split(',')
      .map((entry) => normalizePathLikeToken(entry))
      .filter(Boolean)
  );
}

function blockerEvidenceRequirementSatisfied(
  requirement: ReviewerBlockerEvidenceRecord,
  evidence: ReviewerBlockerEvidenceRecord[]
): boolean {
  return evidence.some((entry) => {
    if (entry.kind !== requirement.kind) {
      return false;
    }
    if (requirement.command) {
      return String(entry.command || '').trim() === String(requirement.command || '').trim();
    }
    if (requirement.kind === 'code_change') {
      const requiredFiles = extractReferencedFiles(requirement.detail || '');
      if (requiredFiles.length === 0) {
        return false;
      }
      const changedFiles = extractChangedFilesFromEvidenceDetail(entry.detail || '');
      return requiredFiles.every((file) => changedFiles.includes(file));
    }
    const requiredDetail = String(requirement.detail || '').trim();
    return !requiredDetail || String(entry.detail || '').trim() === requiredDetail;
  });
}

function findPassingCheckResult(command: string, checkResults: AnyRecord[] = []): AnyRecord | null {
  return checkResults.find((entry) => {
    return String(entry && entry.command || '').trim() === String(command || '').trim()
      && String(entry && entry.status || '').trim() === 'passed';
  }) || null;
}

function findBlockerCheckResults(command: string, checkResults: AnyRecord[] = []): ReviewerBlockerCheckResultRecord[] {
  return checkResults
    .filter((entry) => String(entry && entry.command || '').trim() === String(command || '').trim())
    .map((entry) => normalizeReviewerBlockerCheckResult({
      command,
      status: entry && entry.status,
      code: entry && entry.code,
      output: entry && entry.output,
    }))
    .filter((entry) => entry.command && entry.status);
}

function deriveTaskEvidenceForBlocker(
  blocker: ReviewerBlockerRecord,
  changedFiles: string[] = [],
  checkResults: AnyRecord[] = []
): ReviewerBlockerEvidenceRecord[] {
  const evidence: ReviewerBlockerEvidenceRecord[] = [];
  const requiredEvidence = Array.isArray(blocker.requiredEvidence) ? blocker.requiredEvidence : [];
  requiredEvidence.forEach((requirement) => {
    if (requirement.kind === 'command_output' && requirement.command) {
      const result = findPassingCheckResult(requirement.command, checkResults);
      if (result) {
        evidence.push(buildCommandEvidence(requirement.command, result));
      }
    } else if (requirement.kind === 'code_change' && changedFiles.length > 0) {
      evidence.push(buildCodeChangeEvidence(blocker, changedFiles));
    }
  });
  if (requiredEvidence.length === 0 && blocker.requiredChecks && blocker.requiredChecks.length > 0) {
    blocker.requiredChecks.forEach((command) => {
      const result = findPassingCheckResult(command, checkResults);
      if (result) {
        evidence.push(buildCommandEvidence(command, result));
      }
    });
  }
  return evidence;
}

function applyTaskCompletionToReviewerBlockers(
  blockers: ReviewerBlockerRecord[] = [],
  options: AnyRecord = {}
): {
  blockers: ReviewerBlockerRecord[];
  unresolvedBlockers: ReviewerBlockerRecord[];
  recordedEvidenceCount: number;
  satisfiedBlockerIds: string[];
} {
  const changedFiles = uniqueStrings(options.changedFiles || []);
  const checkResults = Array.isArray(options.checkResults) ? options.checkResults : [];
  const completedAt = String(options.completedAt || new Date().toISOString());
  const taskId = String(options.taskId || '').trim() || null;
  const satisfiedBlockerIds: string[] = [];
  let recordedEvidenceCount = 0;

  const nextBlockers = blockers.map((candidate) => {
    const blocker = normalizeReviewerBlocker(candidate);
    if (!blocker.id) {
      return blocker;
    }
    if (blocker.status.state === 'dismissed') {
      return blocker;
    }
    const derivedEvidence = deriveTaskEvidenceForBlocker(blocker, changedFiles, checkResults);
    const mergedEvidence = mergeReviewerBlockerEvidence(blocker.status.evidence || [], derivedEvidence);
    recordedEvidenceCount += mergedEvidence.addedCount;
    const nextStatus = normalizeReviewerBlockerStatus(blocker.status);
    nextStatus.evidence = mergedEvidence.evidence;
    nextStatus.lastCheckResults = uniqueStrings(blocker.requiredChecks || [])
      .flatMap((command) => findBlockerCheckResults(command, checkResults));
    nextStatus.unresolvedReason = String(
      blocker.verificationTarget && blocker.verificationTarget.unresolvedReason
      || blocker.status && blocker.status.unresolvedReason
      || ''
    ).trim() || null;

    const requiredEvidence = Array.isArray(blocker.requiredEvidence) ? blocker.requiredEvidence : [];
    const evidenceSatisfied = requiredEvidence.every((requirement) => blockerEvidenceRequirementSatisfied(requirement, nextStatus.evidence || []));
    const checksSatisfied = (blocker.requiredChecks || []).every((command) => Boolean(findPassingCheckResult(command, checkResults)));
    if ((requiredEvidence.length > 0 || (blocker.requiredChecks || []).length > 0) && evidenceSatisfied && checksSatisfied) {
      nextStatus.state = 'satisfied';
      nextStatus.satisfiedAt = completedAt;
      nextStatus.satisfiedByTaskId = taskId;
      nextStatus.dismissedAt = null;
      nextStatus.dismissalReason = null;
      nextStatus.unresolvedReason = null;
      satisfiedBlockerIds.push(blocker.id);
    }

    return {
      ...blocker,
      status: nextStatus,
    };
  });

  return {
    blockers: nextBlockers,
    unresolvedBlockers: listUnresolvedReviewerBlockers(nextBlockers),
    recordedEvidenceCount,
    satisfiedBlockerIds: uniqueStrings(satisfiedBlockerIds),
  };
}

function dismissReviewerBlockersByPolicy(
  blockers: ReviewerBlockerRecord[] = [],
  options: AnyRecord = {}
): {
  blockers: ReviewerBlockerRecord[];
  dismissedBlockerIds: string[];
} {
  const dismissedAt = String(options.dismissedAt || new Date().toISOString());
  const dismissalReason = String(options.dismissalReason || '').trim() || 'policy-dismissed';
  const allowedIds = new Set(uniqueStrings(Array.isArray(options.blockerIds) ? options.blockerIds : []));
  const dismissAll = allowedIds.size === 0 && options.dismissAll === true;
  const dismissedBlockerIds: string[] = [];

  const nextBlockers = blockers.map((candidate) => {
    const blocker = normalizeReviewerBlocker(candidate);
    if (!blocker.id) {
      return blocker;
    }
    if (blocker.status.state === 'dismissed') {
      return blocker;
    }
    if (!dismissAll && !allowedIds.has(blocker.id)) {
      return blocker;
    }
    dismissedBlockerIds.push(blocker.id);
    return {
      ...blocker,
      status: {
        ...normalizeReviewerBlockerStatus(blocker.status),
        state: 'dismissed' as const,
        dismissedAt,
        dismissalReason,
        satisfiedAt: null,
        satisfiedByTaskId: null,
      },
    };
  });

  return {
    blockers: nextBlockers,
    dismissedBlockerIds: uniqueStrings(dismissedBlockerIds),
  };
}

function collectCurrentReviewerBlockers(pr: PullRequestRecord | null | undefined, tasks: TaskRecord[] = []): ReviewerBlockerRecord[] {
  const blockersById = new Map<string, ReviewerBlockerRecord>();
  const insert = (candidate: ReviewerBlockerRecord | null | undefined) => {
    if (!candidate) {
      return;
    }
    const blocker = normalizeReviewerBlocker(candidate);
    if (!blocker.id) {
      return;
    }
    blockersById.set(blocker.id, blocker);
  };

  (pr && Array.isArray(pr.reviewerBlockers) ? pr.reviewerBlockers : []).forEach(insert);
  (pr && Array.isArray(pr.reviews) ? pr.reviews : []).forEach((review) => {
    const decision = review as ReviewDecisionRecord;
    (Array.isArray(decision.reviewerBlockers) ? decision.reviewerBlockers : []).forEach((blocker) => {
      if (!blockersById.has(String(blocker && blocker.id || '').trim())) {
        insert(blocker);
      }
    });
  });

  const sortedTasks = tasks
    .filter(Boolean)
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(String(left.completedAt || left.updatedAt || left.createdAt || ''));
      const rightTime = Date.parse(String(right.completedAt || right.updatedAt || right.createdAt || ''));
      return (Number.isFinite(leftTime) ? leftTime : 0) - (Number.isFinite(rightTime) ? rightTime : 0);
    });
  sortedTasks.forEach((task) => {
    (Array.isArray(task.reviewerBlockers) ? task.reviewerBlockers : []).forEach(insert);
  });

  return Array.from(blockersById.values()).sort((left, right) => {
    const leftRound = Number(left.sourceReview && left.sourceReview.reviewRound || 0);
    const rightRound = Number(right.sourceReview && right.sourceReview.reviewRound || 0);
    if (leftRound !== rightRound) {
      return leftRound - rightRound;
    }
    return String(left.id).localeCompare(String(right.id));
  });
}

export {
  applyTaskCompletionToReviewerBlockers,
  buildReviewerBlockersFromReview,
  collectCurrentReviewerBlockers,
  collectReviewerBlockerChecks,
  dismissReviewerBlockersByPolicy,
  isReviewerBlockerResolved,
  listUnresolvedReviewerBlockers,
  normalizeReviewerBlocker,
  resolveVerificationCommandsFromChangedFiles,
};
