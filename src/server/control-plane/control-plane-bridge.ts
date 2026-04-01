import { loadAutonomyEnv } from '../../env/env-main.js';
import { executePrdAdd, buildPrdAddCliOptions } from '../../autonomy-v2/control-plane/prd-service.js';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { claimJob, completeJob, setRepoStatus } from './control-plane-store.js';

function parseRepoMap(value: string | undefined) {
  const repoMap: Record<string, string> = {};
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) {
        return;
      }
      const repoId = entry.slice(0, separatorIndex).trim();
      const rootDir = entry.slice(separatorIndex + 1).trim();
      if (repoId && rootDir) {
        repoMap[repoId] = rootDir;
      }
    });
  return repoMap;
}

async function runControlPlaneBridgeOnce(rootDir: string, options: {
  serverUrl: string;
  repoRoots: Record<string, string>;
}) {
  loadAutonomyEnv(rootDir);
  const queuedJobs = await requestJson(`${options.serverUrl}/api/jobs?status=queued`);
  const jobs = Array.isArray(queuedJobs.jobs) ? queuedJobs.jobs : [];
  const processed = [];

  for (const job of jobs) {
    const claimed = claimJob(rootDir, job.id);
    if (!claimed) {
      continue;
    }
    const repoRoot = options.repoRoots[job.repoId];
    if (!repoRoot) {
      const failure = completeJob(rootDir, job.id, {
        status: 'failed',
        error: `No local repo root configured for ${job.repoId}.`,
      });
      processed.push({ jobId: job.id, status: failure && failure.status });
      continue;
    }

    try {
      loadAutonomyEnv(repoRoot);
      const execution = executePrdAdd(repoRoot, buildPrdAddCliOptions(job.payload));
      const snapshot = buildStatusSnapshot(repoRoot);
      setRepoStatus(rootDir, job.repoId, snapshot);
      const completed = completeJob(rootDir, job.id, {
        status: 'completed',
        result: {
          prdId: execution.prdSpec.id,
          commitSha: execution.commit.commitSha || null,
          queueCommitSha: execution.queueCommit ? execution.queueCommit.commitSha : null,
        },
      });
      processed.push({ jobId: job.id, status: completed && completed.status });
    } catch (error) {
      const failed = completeJob(rootDir, job.id, {
        status: 'failed',
        error: error.message,
      });
      processed.push({ jobId: job.id, status: failed && failed.status });
    }
  }

  await Promise.all(Object.entries(options.repoRoots).map(async ([repoId, repoRoot]) => {
    try {
      const snapshot = buildStatusSnapshot(repoRoot);
      setRepoStatus(rootDir, repoId, snapshot);
    } catch (error) {
      // Skip repos that are not initialized or temporarily unavailable.
    }
  }));

  return {
    processed,
  };
}

async function runControlPlaneBridgeLoop(rootDir: string, options: {
  serverUrl: string;
  repoRoots: Record<string, string>;
  pollMs: number;
  once?: boolean;
}) {
  if (options.once === true) {
    return runControlPlaneBridgeOnce(rootDir, options);
  }

  for (;;) {
    await runControlPlaneBridgeOnce(rootDir, options);
    await delay(options.pollMs);
  }
}

async function requestJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  return response.json() as Promise<any>;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export {
  parseRepoMap,
  runControlPlaneBridgeLoop,
  runControlPlaneBridgeOnce,
};
