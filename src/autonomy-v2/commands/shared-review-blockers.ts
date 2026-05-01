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

function detectReferencedAreas(text: string, referencedFiles: string[] = [], changedFiles: string[] = []): string[] {
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
  const controlPlaneSummaryUiFiles = new Set([
    'src/server/control-plane/control-plane-client.tsx',
    'src/server/control-plane/control-plane-page.tsx',
    'tests/unit/control-plane-summary-ui.test.ts',
    'tests/unit/control-plane-restart-ui.test.ts',
  ]);
  const summaryUiFiles = referencedFiles.concat(changedFiles).map((entry) => normalizePathLikeToken(entry));
  if (
    /\bcontrol plane summary ui\b|\bsummary ui\b|\brestart ui\b/.test(normalized)
    || summaryUiFiles.some((filePath) => controlPlaneSummaryUiFiles.has(filePath))
  ) {
    areas.push('control-plane-summary-ui');
  }
  return uniqueStrings(areas);
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
      pushScript('test:control-plane-summary-ui');
    } else if (area === 'unit') {
      commands.push('npm run build && node --test dist/tests/unit/*.test.js');
    }
  });
  return uniqueStrings(commands);
}

function resolveVerificationTarget(text: string, options: AnyRecord = {}): ReviewerBlockerVerificationTargetRecord {
  const optionScripts = normalizePackageScripts(options.packageScripts);
  const scripts = Object.keys(optionScripts).length > 0
    ? optionScripts
    : readPackageScripts(String(options.worktreePath || ''));
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

  const referencedAreas = detectReferencedAreas(text, referencedFiles, changedFiles);
  const areaCommands = resolveAreaCommands(referencedAreas, scripts);
  if (areaCommands.length > 0) {
    return {
      source: referencedAreas.length > 0 ? 'mentioned_area' : 'changed_files',
      referencedFiles,
      referencedAreas,
      changedFiles,
      resolvedCommands: areaCommands,
      unresolvedReason: null,
    };
  }

  const ambiguityReason = referencedFiles.length > 0
    ? `No runnable verification command could be resolved from: ${referencedFiles.join(', ')}`
    : 'Reviewer requested verification, but no runnable command, test file, or known area could be resolved.';
  return {
    source: 'unresolved',
    referencedFiles,
    referencedAreas,
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
};
