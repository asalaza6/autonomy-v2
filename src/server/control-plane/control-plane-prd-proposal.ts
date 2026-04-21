import type {
  ControlPlanePrdAddPayload,
  ControlPlanePrdProposal,
  ControlPlanePrdProposalSource,
} from '../../types.js';

const PRD_PROPOSAL_KIND = 'prd-proposal';
const PRD_PROPOSAL_FENCE_RE = /```(?:json|autonomy-prd-proposal|prd-proposal)?\s*([\s\S]*?)```/gi;
const PRD_PROPOSAL_COMMENT_RE = /<!--\s*autonomy-prd-proposal\s*([\s\S]*?)\s*-->/gi;

function normalizePrdProposal(
  value: unknown,
  source: Partial<ControlPlanePrdProposalSource> = {}
): ControlPlanePrdProposal | null {
  const candidate = selectPrdProposalCandidate(value);
  if (!candidate) {
    return null;
  }

  const title = cleanText(candidate.title || candidate.name);
  const problem = cleanText(candidate.problem);
  const goal = cleanText(candidate.goal);
  const requirements = normalizeStringList(candidate.requirements || candidate.requirement);
  const acceptanceCriteria = normalizeStringList(
    candidate.acceptanceCriteria ||
    candidate.acceptance_criteria ||
    candidate.acceptance ||
    candidate.acceptanceCriteriaItems
  );
  const verification = normalizeStringList(candidate.verification || candidate.verify || candidate.tests);
  const priority = cleanText(candidate.priority);

  if (!title || (!problem && !goal && requirements.length === 0 && acceptanceCriteria.length === 0 && verification.length === 0)) {
    return null;
  }

  const normalizedSource = normalizePrdProposalSource({
    ...normalizePrdProposalSource(candidate.source),
    ...normalizePrdProposalSource(source),
  });

  return {
    schemaVersion: 1,
    kind: PRD_PROPOSAL_KIND,
    title,
    ...(problem ? { problem } : {}),
    ...(goal ? { goal } : {}),
    requirements,
    acceptanceCriteria,
    verification,
    ...(priority ? { priority } : {}),
    ...(normalizedSource ? { source: normalizedSource } : {}),
  };
}

function extractPrdProposalFromText(
  text: string,
  source: Partial<ControlPlanePrdProposalSource> = {}
) {
  const rawText = String(text || '').trim();
  if (!rawText) {
    return null;
  }

  const direct = parsePrdProposalCandidate(rawText, source);
  if (direct) {
    return direct;
  }

  for (const block of extractRegexBlocks(rawText, PRD_PROPOSAL_COMMENT_RE)) {
    const proposal = parsePrdProposalCandidate(block, source);
    if (proposal) {
      return proposal;
    }
  }

  for (const block of extractRegexBlocks(rawText, PRD_PROPOSAL_FENCE_RE)) {
    const proposal = parsePrdProposalCandidate(block, source);
    if (proposal) {
      return proposal;
    }
  }

  return null;
}

function buildPrdSubmissionFromProposal(
  proposal: ControlPlanePrdProposal,
  options: { repoId?: string } = {}
): Partial<ControlPlanePrdAddPayload> {
  const normalized = normalizePrdProposal(proposal);
  if (!normalized) {
    return {};
  }
  return {
    repoId: String(options.repoId || normalized.source?.repoId || '').trim(),
    title: normalized.title,
    specification: buildPrdProposalSpecification(normalized),
    requirements: normalized.requirements,
    taskSpecs: [],
  };
}

function buildPrdProposalSpecification(proposal: ControlPlanePrdProposal) {
  const normalized = normalizePrdProposal(proposal);
  if (!normalized) {
    return '';
  }

  const sections: string[] = [`# PRD: ${normalized.title}`];
  if (normalized.priority) {
    sections.push(`Priority: ${normalized.priority}`);
  }
  if (normalized.problem) {
    sections.push(formatSection('Problem', normalized.problem));
  }
  if (normalized.goal) {
    sections.push(formatSection('Goal', normalized.goal));
  }
  if (normalized.requirements.length > 0) {
    sections.push(formatListSection('Requirements', normalized.requirements));
  }
  if (normalized.acceptanceCriteria.length > 0) {
    sections.push(formatListSection('Acceptance Criteria', normalized.acceptanceCriteria));
  }
  if (normalized.verification.length > 0) {
    sections.push(formatListSection('Verification', normalized.verification));
  }

  const source = formatPrdProposalSource(normalized.source);
  if (source) {
    sections.push(formatSection('Source Chat Message', source));
  }

  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join('\n\n');
}

function getPrdProposalStableKey(proposal: ControlPlanePrdProposal, fallback = '') {
  const normalized = normalizePrdProposal(proposal);
  if (!normalized) {
    return stableHash(String(fallback || 'prd-proposal'));
  }
  const source = normalized.source || {};
  const sourceKey = [
    source.repoId,
    source.conversationId,
    source.responseMessageId || source.messageId,
  ].map((entry) => String(entry || '').trim()).filter(Boolean).join(':');
  if (sourceKey) {
    return sourceKey;
  }
  return `proposal:${stableHash(`${fallback}:${JSON.stringify(normalized)}`)}`;
}

function selectPrdProposalCandidate(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isRecord(value.prdProposal)) {
    return value.prdProposal;
  }
  if (isRecord(value.prd_proposal)) {
    return value.prd_proposal;
  }
  if (isRecord(value.proposal)) {
    return value.proposal;
  }

  const kind = String(value.kind || value.type || '').trim().toLowerCase();
  if (kind === PRD_PROPOSAL_KIND || kind === 'autonomy-prd-proposal') {
    return value;
  }

  const hasProposalFields = Boolean(
    value.title &&
    (
      value.problem ||
      value.goal ||
      value.requirements ||
      value.acceptanceCriteria ||
      value.acceptance_criteria ||
      value.verification
    )
  );
  return hasProposalFields ? value : null;
}

function parsePrdProposalCandidate(
  rawJson: string,
  source: Partial<ControlPlanePrdProposalSource>
) {
  try {
    return normalizePrdProposal(JSON.parse(rawJson), source);
  } catch {
    return null;
  }
}

function extractRegexBlocks(text: string, pattern: RegExp) {
  const blocks: string[] = [];
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    blocks.push(String(match[1] || '').trim());
    match = pattern.exec(text);
  }
  return blocks;
}

function normalizeStringList(value: unknown) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\n+/)
      : [];
  return entries
    .map((entry) => cleanText(entry).replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter(Boolean);
}

function normalizePrdProposalSource(value: unknown): ControlPlanePrdProposalSource | null {
  if (!isRecord(value)) {
    return null;
  }
  const source = {
    repoId: cleanText(value.repoId),
    conversationId: cleanText(value.conversationId),
    messageId: cleanText(value.messageId),
    responseMessageId: cleanText(value.responseMessageId),
    createdAt: cleanText(value.createdAt),
  };
  const normalized = Object.fromEntries(
    Object.entries(source).filter(([, entry]) => entry)
  ) as ControlPlanePrdProposalSource;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function formatSection(title: string, body: string) {
  return `## ${title}\n${body}`;
}

function formatListSection(title: string, entries: string[]) {
  return `## ${title}\n${entries.map((entry) => `- ${entry}`).join('\n')}`;
}

function formatPrdProposalSource(source: ControlPlanePrdProposalSource | undefined) {
  if (!source) {
    return '';
  }
  return [
    source.repoId ? `Repo: ${source.repoId}` : '',
    source.conversationId ? `Conversation: ${source.conversationId}` : '',
    source.messageId ? `Manager message: ${source.messageId}` : '',
    source.responseMessageId ? `Agent message: ${source.responseMessageId}` : '',
    source.createdAt ? `Created: ${source.createdAt}` : '',
  ].filter(Boolean).join('\n');
}

function cleanText(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stableHash(value: string) {
  let hash = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export {
  PRD_PROPOSAL_KIND,
  buildPrdProposalSpecification,
  buildPrdSubmissionFromProposal,
  extractPrdProposalFromText,
  getPrdProposalStableKey,
  normalizePrdProposal,
};
