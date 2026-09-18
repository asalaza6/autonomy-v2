import { extractPrdSourceChatMetadata } from './prd-source-chat.js';
import type { PrdLinkedPullRequestSummary } from '../../types.js';

function selectActivePrd(prds: any[] = []) {
  const candidates = (prds || [])
    .filter((prd) => {
      const status = String(prd && prd.status || '');
      const openPullRequestCount = Number(prd && prd.linkedPullRequestSummary && prd.linkedPullRequestSummary.open || 0);
      return !prd.isQueued && (status === 'planning' || status === 'planned' || openPullRequestCount > 0);
    })
    .slice()
    .sort((left, right) => {
      const leftRank = rankPrdForStatus(left);
      const rightRank = rankPrdForStatus(right);
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return compareTimestamps(right.updatedAt || right.createdAt || '', left.updatedAt || left.createdAt || '');
    });
  return candidates[0] || null;
}

function selectQueuedPrds(prds: any[] = []) {
  return (prds || [])
    .filter((prd) => prd && (prd.isQueued === true || String(prd.status || '') === 'queued'))
    .slice()
    .sort((left, right) => {
      const priorityDelta = getPrdPriorityRank(right) - getPrdPriorityRank(left);
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return compareTimestamps(left.createdAt || left.updatedAt || '', right.createdAt || right.updatedAt || '');
    });
}

function describePrd(prd: any) {
  const status = String(prd && prd.status || 'queued');
  const structuredContent = extractStructuredPrdContent(prd);
  const plannedTaskCount = Array.isArray(prd && prd.plannedTaskIds)
    ? prd.plannedTaskIds.length
    : Array.isArray(prd && prd.tasks)
      ? prd.tasks.length
      : 0;
  const completedTaskCount = Array.isArray(prd && prd.completedTaskSpecIds)
    ? prd.completedTaskSpecIds.length
    : status === 'completed'
      ? plannedTaskCount
      : 0;
  const remainingTaskCount = Math.max(plannedTaskCount - completedTaskCount, 0);
  const progressPercent = plannedTaskCount > 0
    ? Math.max(0, Math.min(100, Math.round((completedTaskCount / plannedTaskCount) * 100)))
    : status === 'completed'
      ? 100
      : 0;
  const requirementCount = Array.isArray(prd && prd.requirements) ? prd.requirements.length : 0;
  const details = [];
  let stateLabel = formatStatusLabel(status);

  if (status === 'planning') {
    stateLabel = 'Planning now';
  } else if (status === 'planned') {
    stateLabel = 'Planned and waiting to run';
  } else if (status === 'queued' || prd.isQueued === true) {
    stateLabel = 'Waiting in queue';
  } else if (status === 'completed') {
    stateLabel = 'Completed';
  } else if (status === 'reset') {
    stateLabel = 'Reset / abandoned';
  } else if (status === 'failed') {
    stateLabel = 'Needs attention';
  }

  if (plannedTaskCount > 0) {
    details.push(`${plannedTaskCount} planned task${plannedTaskCount === 1 ? '' : 's'}`);
  }
  if (completedTaskCount > 0 || plannedTaskCount > 0) {
    details.push(`${completedTaskCount}/${plannedTaskCount} tasks done`);
  }
  if (requirementCount > 0) {
    details.push(`${requirementCount} requirement${requirementCount === 1 ? '' : 's'}`);
  }
  if (prd && prd.priority) {
    details.push(`priority ${summarizeText(prd.priority)}`);
  }
  if (prd && prd.lastError) {
    details.push(`last error: ${summarizeText(prd.lastError)}`);
  }
  if (prd && prd.statusReason) {
    details.push(`state reason: ${summarizeText(prd.statusReason)}`);
  }
  if (status === 'reset' && prd && prd.archive && prd.archive.reason) {
    details.push(`reason: ${summarizeText(prd.archive.reason)}`);
  }
  if (prd && prd.updatedAt) {
    details.push(`updated ${formatTimestamp(prd.updatedAt)}`);
  }

  const sourceChat = extractPrdSourceChatMetadata(prd);
  const pullRequest = normalizeLinkedPullRequest(prd && prd.pullRequest);

  return {
    id: String(prd && prd.id || ''),
    title: String(prd && prd.title || prd && prd.id || 'Untitled PRD'),
    status,
    stateLabel,
    detail: details.join(' | '),
    problem: structuredContent.problem,
    specification: structuredContent.specification,
    requirements: Array.isArray(prd && prd.requirements) ? prd.requirements.map((entry) => String(entry || '')) : [],
    acceptanceCriteria: structuredContent.acceptanceCriteria,
    verification: structuredContent.verification,
    tasks: Array.isArray(prd && prd.tasks)
      ? prd.tasks.map((task) => ({
        id: String(task && task.id || ''),
        title: String(task && task.title || task && task.id || 'Untitled task'),
        agentId: String(task && task.agentId || ''),
        description: task && task.description ? String(task.description) : '',
        acceptance: Array.isArray(task && task.acceptance) ? task.acceptance.map((entry) => String(entry || '')) : [],
        sprintId: task && task.sprintId ? String(task.sprintId) : '',
      }))
      : [],
    plannedTaskCount,
    completedTaskCount,
    remainingTaskCount,
    progressPercent,
    requirementCount,
    priority: prd && prd.priority ? String(prd.priority) : '',
    statusSource: prd && prd.statusSource ? String(prd.statusSource) : null,
    statusReason: prd && prd.statusReason ? String(prd.statusReason) : null,
    reconciliationStatus: prd && prd.reconciliationStatus ? String(prd.reconciliationStatus) : null,
    linkedPullRequestSummary: prd && prd.linkedPullRequestSummary ? { ...prd.linkedPullRequestSummary } : null,
    createdAt: prd && prd.createdAt ? String(prd.createdAt) : null,
    updatedAt: prd && prd.updatedAt ? String(prd.updatedAt) : null,
    isQueued: prd && prd.isQueued === true,
    archived: prd && prd.archived === true,
    archivePath: prd && prd.archivePath ? String(prd.archivePath) : null,
    archive: prd && prd.archive && typeof prd.archive === 'object'
      ? {
        kind: prd.archive.kind ? String(prd.archive.kind) : null,
        status: prd.archive.status ? String(prd.archive.status) : null,
        archivedAt: prd.archive.archivedAt ? String(prd.archive.archivedAt) : null,
        reason: prd.archive.reason ? String(prd.archive.reason) : null,
        fromStatus: prd.archive.fromStatus ? String(prd.archive.fromStatus) : null,
        actor: prd.archive.actor ? String(prd.archive.actor) : null,
      }
      : null,
    ...(pullRequest ? { pullRequest } : {}),
    ...(sourceChat ? { sourceChat } : {}),
  };
}

function getPrdPriorityRank(prd: any) {
  const value = String(prd && prd.priority || '').trim().toLowerCase();
  if (['highest', 'critical', 'p0', '0'].includes(value)) {
    return 400;
  }
  if (['high', 'p1', '1'].includes(value)) {
    return 300;
  }
  if (['normal', 'medium', 'p2', '2'].includes(value)) {
    return 200;
  }
  if (['low', 'p3', '3'].includes(value)) {
    return 100;
  }
  return 200;
}

function normalizeLinkedPullRequest(value: unknown): PrdLinkedPullRequestSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as PrdLinkedPullRequestSummary;
  const url = String(record.url || '').trim();
  const number = Number(record.number);
  const normalized: PrdLinkedPullRequestSummary = {};
  if (Number.isFinite(number) && number > 0) {
    normalized.number = number;
  }
  if (url) {
    normalized.url = url;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function extractStructuredPrdContent(prd: any) {
  const specification = prd && prd.specification ? String(prd.specification) : '';
  const sections = parseStructuredPrdSections(specification);
  return {
    problem: cleanStructuredText(prd && prd.problem) || cleanStructuredText(sections.problem?.join('\n\n')) || '',
    specification,
    acceptanceCriteria: normalizeStructuredList(
      Array.isArray(prd && prd.acceptanceCriteria) ? prd.acceptanceCriteria : sections.acceptanceCriteria
    ),
    verification: normalizeStructuredList(
      Array.isArray(prd && prd.verification) ? prd.verification : sections.verification
    ),
  };
}

function parseStructuredPrdSections(specification: string) {
  const text = String(specification || '');
  if (!text.trim()) {
    return {};
  }

  const sections: Record<string, string[]> = {};
  let currentSection = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const headingMatch = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      currentSection = normalizeStructuredSectionHeading(headingMatch[1]);
      if (currentSection && !sections[currentSection]) {
        sections[currentSection] = [];
      }
      continue;
    }
    if (!currentSection) {
      continue;
    }
    sections[currentSection].push(rawLine);
  }
  return sections;
}

function normalizeStructuredSectionHeading(value: string) {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (normalized === 'problem') {
    return 'problem';
  }
  if (normalized === 'acceptance criteria') {
    return 'acceptanceCriteria';
  }
  if (normalized === 'verification') {
    return 'verification';
  }
  return '';
}

function cleanStructuredText(value: unknown) {
  return String(value || '').trim();
}

function normalizeStructuredList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

function formatStatusLabel(status: string) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

function summarizeText(value: unknown) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || 'unknown time');
  }
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function compareTimestamps(left: string, right: string) {
  return (Date.parse(left || '') || 0) - (Date.parse(right || '') || 0);
}

function rankPrdForStatus(prd: any) {
  const status = String(prd && prd.status || '');
  if (status === 'planning') {
    return 0;
  }
  if (status === 'planned') {
    return 1;
  }
  return 10;
}
export { describePrd, selectActivePrd, selectQueuedPrds };
