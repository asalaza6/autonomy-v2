import path from 'path';
import type { AnyRecord, PrdSpecPayload, PrdStateRecord } from './types.js';
import { AUTONOMY_SEGMENTS, PRD_STATE_DIR } from './constants.js';

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function isProcessAcceptance(value) {
  return /(reflog|origin\/|merge-base|created from|branch|commit)/i.test(String(value || ''));
}

function sanitizeTaskAcceptance(value, taskId) {
  const acceptance = normalizeStringList(value)
    .filter((entry) => !isProcessAcceptance(entry));
  if (acceptance.length > 0) {
    return acceptance;
  }
  return [`Task \`${taskId}\` is complete within the assigned agent scope.`];
}

function normalizeTaskSpecs(taskSpecs: AnyRecord[], options: AnyRecord = {}) {
  if (!Array.isArray(taskSpecs) || taskSpecs.length === 0) {
    if (options.allowEmpty === true) {
      return [];
    }
    throw new Error('PRD spec must include at least one task.');
  }

  return taskSpecs.map((task, index) => {
    if (!task || typeof task !== 'object') {
      throw new Error(`Task spec at index ${index} must be an object.`);
    }
    if (!task.id || !task.title || !task.agentId) {
      throw new Error(`Task spec at index ${index} must include id, title, and agentId.`);
    }
    return {
      id: String(task.id),
      title: String(task.title),
      agentId: String(task.agentId),
      description: typeof task.description === 'string' ? task.description : '',
      acceptance: sanitizeTaskAcceptance(task.acceptance, task.id),
      sprintId: task.sprintId ? String(task.sprintId) : undefined,
    };
  }).map((task) => {
    if (!task.sprintId) {
      delete task.sprintId;
    }
    return task;
  });
}

function buildPrdSpecPayload({ id, title, tasks, createdAt, specification, requirements }: AnyRecord): PrdSpecPayload {
  const normalizedSpecification = typeof specification === 'string' ? specification.trim() : '';
  const normalizedRequirements = normalizeStringList(requirements);
  const normalizedTasks = Array.isArray(tasks) && tasks.length > 0
    ? normalizeTaskSpecs(tasks || [], {
        allowEmpty: Boolean(normalizedSpecification) || normalizedRequirements.length > 0,
      })
    : [];
  const payload: PrdSpecPayload = {
    schemaVersion: normalizedSpecification || normalizedRequirements.length > 0 ? 2 : 1,
    id: String(id),
    title: String(title),
    createdAt: createdAt || new Date().toISOString(),
    specification: normalizedSpecification || undefined,
    requirements: normalizedRequirements.length > 0 ? normalizedRequirements : undefined,
  };
  if (normalizedTasks.length > 0) {
    payload.tasks = normalizedTasks;
  }
  return payload;
}

function parsePrdSpec(rawContent: string, sourcePath: string): PrdSpecPayload {
  let parsed: AnyRecord;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourcePath}: ${error.message}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`PRD spec ${sourcePath} must be a JSON object.`);
  }
  if (!parsed.id || !parsed.title) {
    throw new Error(`PRD spec ${sourcePath} must include id and title.`);
  }

  return buildPrdSpecPayload({
    id: parsed.id,
    title: parsed.title,
    tasks: parsed.tasks,
    createdAt: parsed.createdAt,
    specification: parsed.specification,
    requirements: parsed.requirements,
  });
}

function requiresPmPlanning(spec, implementationTasks = []) {
  const hasPlanningInput = Boolean(spec && typeof spec.specification === 'string' && spec.specification.trim())
    || (Array.isArray(spec && spec.requirements) && spec.requirements.some((entry) => String(entry || '').trim()));
  if (Array.isArray(implementationTasks) && implementationTasks.length > 0) {
    return false;
  }
  return hasPlanningInput && (!Array.isArray(spec.tasks) || spec.tasks.length === 0);
}

function sanitizeFileSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildPrdSpecRelativePath(prdId: string, options: AnyRecord = {}) {
  const segments = [...AUTONOMY_SEGMENTS, 'specs', 'prds'];
  if (options.queue) {
    segments.push('queue');
  }
  segments.push(`${sanitizeFileSegment(prdId)}.json`);
  return path.join(...segments);
}

function buildPrdStateRelativePath(prdId) {
  return path.join(PRD_STATE_DIR, `${sanitizeFileSegment(prdId)}.json`);
}

function buildPrdStatePayload({ prdId, status, plannedTaskIds, lastError, createdAt, updatedAt }: AnyRecord): PrdStateRecord {
  const payload: PrdStateRecord = {
    schemaVersion: 1,
    prdId: String(prdId),
    status: String(status || '').trim(),
    createdAt: createdAt || new Date().toISOString(),
    updatedAt: updatedAt || new Date().toISOString(),
  };
  const planned = normalizeStringList(plannedTaskIds);
  if (planned.length > 0) {
    payload.plannedTaskIds = planned;
  }
  if (typeof lastError === 'string' && lastError.trim()) {
    payload.lastError = lastError.trim();
  }
  return payload;
}

function parsePrdState(rawContent: string, sourcePath: string): PrdStateRecord {
  let parsed: AnyRecord;
  try {
    parsed = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(`Invalid JSON in ${sourcePath}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`PRD state ${sourcePath} must be a JSON object.`);
  }
  if (!parsed.prdId) {
    throw new Error(`PRD state ${sourcePath} must include prdId.`);
  }
  if (!['planning', 'planned', 'failed'].includes(String(parsed.status || ''))) {
    throw new Error(`PRD state ${sourcePath} must include a valid status.`);
  }
  return buildPrdStatePayload({
    prdId: parsed.prdId,
    status: parsed.status,
    plannedTaskIds: parsed.plannedTaskIds,
    lastError: parsed.lastError,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  });
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export {
  buildPrdSpecPayload,
  buildPrdSpecRelativePath,
  buildPrdStatePayload,
  buildPrdStateRelativePath,
  isProcessAcceptance,
  normalizeStringList,
  normalizeTaskSpecs,
  parsePrdSpec,
  parsePrdState,
  requiresPmPlanning,
  sanitizeFileSegment,
  slugify,
};
