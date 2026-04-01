import fs from 'fs';
import path from 'path';
import { ensureDir, readJson, writeJson } from '../orchestrator/paths.js';
import type {
  ControlPlanePrdAddPayload,
  ControlPlaneJobRecord,
  ControlPlaneRepoStatusRecord,
  ControlPlaneState,
} from '../../types.js';

const DEFAULT_CONTROL_PLANE_STATE: ControlPlaneState = {
  schemaVersion: 1,
  jobs: [],
  repoStatuses: {},
};

function getControlPlanePaths(rootDir: string) {
  const controlPlaneDir = path.join(rootDir, '.autonomy', 'control-plane');
  return {
    controlPlaneDir,
    statePath: path.join(controlPlaneDir, 'state.json'),
  };
}

function loadControlPlaneState(rootDir: string): ControlPlaneState {
  const paths = getControlPlanePaths(rootDir);
  return normalizeControlPlaneState(readJson(paths.statePath, DEFAULT_CONTROL_PLANE_STATE));
}

function saveControlPlaneState(rootDir: string, state: ControlPlaneState) {
  const paths = getControlPlanePaths(rootDir);
  ensureDir(paths.controlPlaneDir);
  writeJson(paths.statePath, normalizeControlPlaneState(state));
}

function normalizeControlPlaneState(state: Partial<ControlPlaneState> = {}): ControlPlaneState {
  return {
    schemaVersion: typeof state.schemaVersion === 'number' ? state.schemaVersion : 1,
    jobs: Array.isArray(state.jobs) ? state.jobs.map(normalizeJobRecord).filter(Boolean) : [],
    repoStatuses: normalizeRepoStatuses(state.repoStatuses),
  };
}

function normalizeRepoStatuses(repoStatuses: Record<string, ControlPlaneRepoStatusRecord> | undefined | null) {
  const normalized: Record<string, ControlPlaneRepoStatusRecord> = {};
  Object.entries(repoStatuses || {}).forEach(([repoId, statusRecord]) => {
    const normalizedRepoId = String(repoId || '').trim();
    if (!normalizedRepoId || !statusRecord) {
      return;
    }
    normalized[normalizedRepoId] = {
      repoId: normalizedRepoId,
      updatedAt: String(statusRecord.updatedAt || new Date().toISOString()),
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
  return {
    ...job,
    id: String(job.id),
    type: 'prd:add' as const,
    repoId: String(job.repoId),
    status: normalizedStatus,
    createdAt: String(job.createdAt || new Date().toISOString()),
    updatedAt: String(job.updatedAt || job.createdAt || new Date().toISOString()),
    payload: {
      ...job.payload,
      repoId: String(job.payload.repoId || job.repoId),
      id: String(job.payload.id || ''),
      title: String(job.payload.title || ''),
      requirements: Array.isArray(job.payload.requirements) ? job.payload.requirements : [],
      taskSpecs: Array.isArray(job.payload.taskSpecs) ? job.payload.taskSpecs : [],
    } as ControlPlanePrdAddPayload,
  };
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

function claimJob(rootDir: string, jobId: string) {
  const state = loadControlPlaneState(rootDir);
  const job = state.jobs.find((entry) => entry.id === jobId);
  if (!job || job.status !== 'queued') {
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

function setRepoStatus(rootDir: string, repoId: string, snapshot: Record<string, unknown>) {
  const state = loadControlPlaneState(rootDir);
  const normalizedRepoId = String(repoId || '').trim();
  if (!normalizedRepoId) {
    throw new Error('Missing repoId.');
  }
  state.repoStatuses[normalizedRepoId] = {
    repoId: normalizedRepoId,
    updatedAt: new Date().toISOString(),
    snapshot,
  };
  saveControlPlaneState(rootDir, state);
  return state.repoStatuses[normalizedRepoId];
}

function getRepoStatuses(rootDir: string) {
  const state = loadControlPlaneState(rootDir);
  return state.repoStatuses;
}

function ensureControlPlaneDataDir(rootDir: string) {
  const paths = getControlPlanePaths(rootDir);
  ensureDir(paths.controlPlaneDir);
  if (!fs.existsSync(paths.statePath)) {
    saveControlPlaneState(rootDir, DEFAULT_CONTROL_PLANE_STATE);
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

export {
  claimJob,
  completeJob,
  createControlPlaneJob,
  ensureControlPlaneDataDir,
  enqueueJob,
  getControlPlanePaths,
  getRepoStatuses,
  listJobs,
  loadControlPlaneState,
  saveControlPlaneState,
  setRepoStatus,
};
