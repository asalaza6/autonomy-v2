import fs from 'fs';
import path from 'path';
import { ensureDir, readJson, writeJson } from '../orchestrator/paths.js';
import type {
  ControlPlaneRepoRecord,
  ControlPlanePrdAddPayload,
  ControlPlaneDeployPayload,
  ControlPlaneJobRecord,
  ControlPlaneHeartbeatRecord,
  ControlPlaneRepoStatusRecord,
  ControlPlaneState,
} from '../../types.js';
import { normalizeRepoRecord } from './control-plane-validation.js';

const DEFAULT_CONTROL_PLANE_STATE: ControlPlaneState = {
  schemaVersion: 1,
  jobs: [],
  repoStatuses: {},
  heartbeats: {},
};

const MEMORY_CONTROL_PLANE_STATES = new Map<string, ControlPlaneState>();

function getControlPlanePaths(rootDir: string) {
  const controlPlaneDir = path.join(rootDir, '.autonomy', 'control-plane');
  return {
    controlPlaneDir,
    statePath: path.join(controlPlaneDir, 'state.json'),
  };
}

function loadControlPlaneState(rootDir: string): ControlPlaneState {
  const stateKey = getControlPlaneStateKey(rootDir);
  const cachedState = MEMORY_CONTROL_PLANE_STATES.get(stateKey);
  if (cachedState) {
    return cachedState;
  }

  const persistedState = shouldPersistControlPlaneState(rootDir)
    ? normalizeControlPlaneState(readJson(getControlPlanePaths(rootDir).statePath, DEFAULT_CONTROL_PLANE_STATE))
    : normalizeControlPlaneState(DEFAULT_CONTROL_PLANE_STATE);
  MEMORY_CONTROL_PLANE_STATES.set(stateKey, persistedState);
  return persistedState;
}

function saveControlPlaneState(rootDir: string, state: ControlPlaneState) {
  const normalizedState = normalizeControlPlaneState(state);
  MEMORY_CONTROL_PLANE_STATES.set(getControlPlaneStateKey(rootDir), normalizedState);
  if (!shouldPersistControlPlaneState(rootDir)) {
    return normalizedState;
  }

  const paths = getControlPlanePaths(rootDir);
  ensureDir(paths.controlPlaneDir);
  writeJson(paths.statePath, normalizedState);
  return normalizedState;
}

function normalizeControlPlaneState(state: Partial<ControlPlaneState> = {}): ControlPlaneState {
  return {
    schemaVersion: typeof state.schemaVersion === 'number' ? state.schemaVersion : 1,
    jobs: Array.isArray(state.jobs) ? state.jobs.map(normalizeJobRecord).filter(Boolean) : [],
    repoStatuses: normalizeRepoStatuses(state.repoStatuses),
    heartbeats: normalizeHeartbeats(state.heartbeats),
  };
}

function normalizeHeartbeats(heartbeats: Record<string, ControlPlaneHeartbeatRecord> | undefined | null) {
  const normalized: Record<string, ControlPlaneHeartbeatRecord> = {};
  Object.entries(heartbeats || {}).forEach(([kind, heartbeat]) => {
    const normalizedKind = normalizeHeartbeatKind(kind);
    if (!normalizedKind || !heartbeat) {
      return;
    }
    normalized[normalizedKind] = {
      kind: normalizedKind,
      updatedAt: String(heartbeat.updatedAt || new Date().toISOString()),
      note: normalizeOptionalString(heartbeat.note),
    };
  });
  return normalized;
}

function normalizeHeartbeatKind(kind: string | undefined | null) {
  const normalized = String(kind || '').trim();
  if (normalized === 'server' || normalized === 'bridge') {
    return normalized;
  }
  return null;
}

function normalizeRepoStatuses(repoStatuses: Record<string, ControlPlaneRepoStatusRecord> | undefined | null) {
  const normalized: Record<string, ControlPlaneRepoStatusRecord> = {};
  Object.entries(repoStatuses || {}).forEach(([repoId, statusRecord]) => {
    const repo = normalizeRepoRecord(statusRecord, String(repoId || '').trim());
    const normalizedRepoId = String(repo && repo.repoId || '').trim();
    if (!normalizedRepoId || !statusRecord) {
      return;
    }
    normalized[normalizedRepoId] = {
      repoId: normalizedRepoId,
      updatedAt: String(statusRecord.updatedAt || new Date().toISOString()),
      label: repo?.label,
      description: repo?.description,
      default: repo?.default,
      deploymentUrl: repo?.deploymentUrl,
      deploymentLabel: repo?.deploymentLabel,
      snapshot: statusRecord.snapshot || {},
    };
  });
  return normalized;
}

function normalizeJobRecord(job: ControlPlaneJobRecord | null | undefined) {
  if (!job || !job.id || !job.repoId || !job.payload) {
    return null;
  }
  const normalizedStatus = normalizeJobStatus(job.status);
  const normalizedType = normalizeJobType(job.type);
  const payload = normalizeJobPayload(normalizedType, job.payload, job.repoId);
  if (!payload) {
    return null;
  }
  return {
    ...job,
    id: String(job.id),
    type: normalizedType,
    repoId: String(job.repoId),
    status: normalizedStatus,
    createdAt: String(job.createdAt || new Date().toISOString()),
    updatedAt: String(job.updatedAt || job.createdAt || new Date().toISOString()),
    payload,
  };
}

function normalizeJobType(type: ControlPlaneJobRecord['type'] | undefined | null) {
  const normalized = String(type || 'prd:add').trim();
  if (normalized === 'deploy') {
    return 'deploy' as const;
  }
  return 'prd:add' as const;
}

function normalizeJobPayload(
  type: ControlPlaneJobRecord['type'],
  payload: ControlPlaneJobRecord['payload'],
  repoId: string
) {
  if (type === 'deploy') {
    return {
      repoId: String((payload as ControlPlaneDeployPayload).repoId || repoId).trim() || repoId,
    } as ControlPlaneDeployPayload;
  }

  return {
    repoId: String((payload as ControlPlanePrdAddPayload).repoId || repoId),
    id: String((payload as ControlPlanePrdAddPayload).id || ''),
    title: String((payload as ControlPlanePrdAddPayload).title || ''),
    specification: String((payload as ControlPlanePrdAddPayload).specification || '').trim() || undefined,
    requirements: Array.isArray((payload as ControlPlanePrdAddPayload).requirements)
      ? (payload as ControlPlanePrdAddPayload).requirements.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [],
    taskSpecs: Array.isArray((payload as ControlPlanePrdAddPayload).taskSpecs)
      ? (payload as ControlPlanePrdAddPayload).taskSpecs
      : [],
    sprintId: String((payload as ControlPlanePrdAddPayload).sprintId || '').trim() || undefined,
  } as ControlPlanePrdAddPayload;
}

function normalizeOptionalString(value: unknown) {
  const text = String(value || '').trim();
  return text || undefined;
}

function normalizeJobStatus(status: string | undefined | null) {
  const normalized = String(status || 'queued').trim();
  if (['queued', 'claimed', 'running', 'completed', 'failed'].includes(normalized)) {
    return normalized as ControlPlaneJobRecord['status'];
  }
  return 'queued';
}

function enqueueJob(rootDir: string, job: ControlPlaneJobRecord) {
  const state = loadControlPlaneState(rootDir);
  state.jobs.push(normalizeJobRecord(job) || job);
  saveControlPlaneState(rootDir, state);
  return job;
}

function listJobs(rootDir: string, filter: Partial<Pick<ControlPlaneJobRecord, 'repoId' | 'status' | 'type'>> = {}) {
  const state = loadControlPlaneState(rootDir);
  return state.jobs.filter((job) => {
    if (filter.repoId && job.repoId !== filter.repoId) {
      return false;
    }
    if (filter.status && job.status !== filter.status) {
      return false;
    }
    if (filter.type && job.type !== filter.type) {
      return false;
    }
    return true;
  });
}

function claimJob(rootDir: string, jobId: string, options: { repoIds?: string[] } = {}) {
  const state = loadControlPlaneState(rootDir);
  const job = state.jobs.find((entry) => entry.id === jobId);
  if (!job || job.status !== 'queued') {
    return null;
  }
  const eligibleRepoIds = Array.isArray(options.repoIds)
    ? options.repoIds.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (eligibleRepoIds.length > 0 && !eligibleRepoIds.includes(String(job.repoId || '').trim())) {
    return null;
  }
  job.status = 'claimed';
  job.claimedAt = new Date().toISOString();
  job.updatedAt = job.claimedAt;
  saveControlPlaneState(rootDir, state);
  return job;
}

function completeJob(rootDir: string, jobId: string, patch: Partial<ControlPlaneJobRecord> = {}) {
  const state = loadControlPlaneState(rootDir);
  const job = state.jobs.find((entry) => entry.id === jobId);
  if (!job) {
    return null;
  }
  job.status = normalizeJobStatus(patch.status || job.status);
  job.updatedAt = new Date().toISOString();
  job.completedAt = patch.completedAt || (job.status === 'completed' || job.status === 'failed' ? job.updatedAt : job.completedAt);
  if (typeof patch.error !== 'undefined') {
    job.error = patch.error;
  }
  if (typeof patch.result !== 'undefined') {
    job.result = patch.result;
  }
  saveControlPlaneState(rootDir, state);
  return job;
}

function touchHeartbeat(rootDir: string, kind: 'server' | 'bridge', patch: Partial<ControlPlaneHeartbeatRecord> = {}) {
  const state = loadControlPlaneState(rootDir);
  state.heartbeats[kind] = {
    kind,
    updatedAt: new Date().toISOString(),
    note: normalizeOptionalString(patch.note),
  };
  saveControlPlaneState(rootDir, state);
  return state.heartbeats[kind];
}

function setRepoStatus(
  rootDir: string,
  repoId: string,
  snapshot: Record<string, unknown>,
  repo: Partial<ControlPlaneRepoRecord> = {}
) {
  const state = loadControlPlaneState(rootDir);
  const normalizedRepo = normalizeRepoRecord({
    ...repo,
    repoId,
  });
  const normalizedRepoId = String(normalizedRepo && normalizedRepo.repoId || '').trim();
  if (!normalizedRepoId) {
    throw new Error('Missing repoId.');
  }
  const existing = state.repoStatuses[normalizedRepoId];
  state.repoStatuses[normalizedRepoId] = {
    repoId: normalizedRepoId,
    updatedAt: new Date().toISOString(),
    label: normalizedRepo?.label || existing?.label,
    description: normalizedRepo?.description || existing?.description,
    default: normalizedRepo?.default === true || existing?.default === true,
    deploymentUrl: normalizedRepo?.deploymentUrl || existing?.deploymentUrl,
    deploymentLabel: normalizedRepo?.deploymentLabel || existing?.deploymentLabel,
    snapshot,
  };
  saveControlPlaneState(rootDir, state);
  return state.repoStatuses[normalizedRepoId];
}

function getRepoStatuses(rootDir: string) {
  const state = loadControlPlaneState(rootDir);
  return state.repoStatuses;
}

function listDiscoveredRepos(rootDir: string) {
  const state = loadControlPlaneState(rootDir);
  return Object.values(state.repoStatuses || {})
    .map((repo) => normalizeRepoRecord(repo))
    .filter((repo): repo is ControlPlaneRepoRecord => Boolean(repo && repo.repoId))
    .sort((left, right) => {
      const leftLabel = String(left && left.label || left && left.repoId || '');
      const rightLabel = String(right && right.label || right && right.repoId || '');
      return leftLabel.localeCompare(rightLabel);
    });
}

function ensureControlPlaneDataDir(rootDir: string) {
  const paths = getControlPlanePaths(rootDir);
  if (shouldPersistControlPlaneState(rootDir)) {
    ensureDir(paths.controlPlaneDir);
    if (!fs.existsSync(paths.statePath)) {
      saveControlPlaneState(rootDir, DEFAULT_CONTROL_PLANE_STATE);
    }
  } else {
    loadControlPlaneState(rootDir);
  }
  return paths;
}

function createControlPlaneJob(payload: ControlPlanePrdAddPayload): ControlPlaneJobRecord {
  const job: ControlPlaneJobRecord = {
    id: `job_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: 'prd:add' as const,
    repoId: payload.repoId,
    payload,
    status: 'queued' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return job;
}

function createControlPlaneDeployJob(payload: ControlPlaneDeployPayload): ControlPlaneJobRecord {
  const job: ControlPlaneJobRecord = {
    id: `job_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: 'deploy' as const,
    repoId: payload.repoId,
    payload: {
      repoId: payload.repoId,
    },
    status: 'queued' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return job;
}

function getControlPlaneStateKey(rootDir: string) {
  return path.resolve(rootDir || process.cwd());
}

function shouldPersistControlPlaneState(rootDir: string) {
  const explicitSetting = String(process.env.AUTONOMY_CONTROL_PLANE_PERSIST || '').trim().toLowerCase();
  if (['0', 'false', 'no', 'off', 'memory'].includes(explicitSetting)) {
    return false;
  }
  if (['1', 'true', 'yes', 'on', 'disk', 'file'].includes(explicitSetting)) {
    return true;
  }
  return !process.env.DYNO && Boolean(rootDir);
}

export {
  claimJob,
  completeJob,
  createControlPlaneJob,
  createControlPlaneDeployJob,
  ensureControlPlaneDataDir,
  enqueueJob,
  getControlPlanePaths,
  listDiscoveredRepos,
  getRepoStatuses,
  listJobs,
  loadControlPlaneState,
  saveControlPlaneState,
  setRepoStatus,
  touchHeartbeat,
  shouldPersistControlPlaneState,
};
