import type { ReviewDecisionRecord, ReviewerBlockerEvidenceRecord, ReviewerBlockerRecord } from '../autonomy-types.js';

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

function buildRequiredEvidence(category: ReviewerBlockerRecord['category'], text: string, commands: string[]): ReviewerBlockerEvidenceRecord[] {
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
      detail: text,
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

function buildReviewerBlockersFromReview(pr: { id?: string; reviews?: unknown[] }, decisionRecord: ReviewDecisionRecord): ReviewerBlockerRecord[] {
  const summaryLines = normalizeReviewSummaryLines(String(decisionRecord.summary || ''));
  const explicitReviewRound = Number((decisionRecord as any).reviewRound || 0);
  const reviewRound = Number.isFinite(explicitReviewRound) && explicitReviewRound > 0
    ? explicitReviewRound
    : Math.max(1, Array.isArray(pr && pr.reviews) ? pr.reviews.length : 0);
  return summaryLines.map((summary, index) => {
    const requiredChecks = extractCommands(summary);
    const category = classifyReviewerBlocker(summary, requiredChecks);
    return {
      id: `${String(pr && pr.id || 'pr').trim() || 'pr'}-review-blocker-${reviewRound || 1}-${index + 1}`,
      category,
      summary,
      requiredChecks,
      requiredEvidence: buildRequiredEvidence(category, summary, requiredChecks),
      status: {
        state: 'open',
        satisfiedAt: null,
        satisfiedByTaskId: null,
        dismissedAt: null,
        dismissalReason: null,
        evidence: [],
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

export {
  buildReviewerBlockersFromReview,
  collectReviewerBlockerChecks,
};
