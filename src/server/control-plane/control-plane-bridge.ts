import { loadAutonomyEnv } from '../../env/env-main.js';
import { executePrdAdd, buildPrdAddCliOptions } from '../../autonomy-v2/control-plane/prd-service.js';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';

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
    const claimed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/claim`, {
      method: 'POST',
    }).catch(() => null);
    if (!claimed) {
      continue;
    }
    const repoRoot = options.repoRoots[job.repoId];
    if (!repoRoot) {
      const failure = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
        method: 'POST',
        body: {
          status: 'failed',
          error: `No local repo root configured for ${job.repoId}.`,
        },
      }).catch(() => null);
      processed.push({ jobId: job.id, status: failure && failure.status });
      continue;
    }

    try {
      loadAutonomyEnv(repoRoot);
      const execution = executePrdAdd(repoRoot, buildPrdAddCliOptions(job.payload));
      const snapshot = buildStatusSnapshot(repoRoot);
      await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
        method: 'POST',
        body: {
          snapshot,
        },
      });
      const completed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
        method: 'POST',
        body: {
          status: 'completed',
          result: {
            prdId: execution.prdSpec.id,
            commitSha: execution.commit.commitSha || null,
            queueCommitSha: execution.queueCommit ? execution.queueCommit.commitSha : null,
          },
        },
      }).catch(() => null);
      processed.push({ jobId: job.id, status: completed && completed.status });
    } catch (error) {
      const failed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
        method: 'POST',
        body: {
          status: 'failed',
          error: formatErrorMessage(error),
        },
      }).catch(() => null);
      processed.push({ jobId: job.id, status: failed && failed.status });
    }
  }

  await Promise.all(Object.entries(options.repoRoots).map(async ([repoId, repoRoot]) => {
    try {
      loadAutonomyEnv(repoRoot);
      const snapshot = buildStatusSnapshot(repoRoot);
      await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(repoId)}/status`, {
        method: 'POST',
        body: {
          snapshot,
        },
      });
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
    try {
      await runControlPlaneBridgeOnce(rootDir, options);
    } catch (error) {
      console.error(`Control plane bridge error: ${formatErrorMessage(error)}`);
    }
    await delay(options.pollMs);
  }
}

async function requestJson(url: string, init: RequestInit = {}) {
  const requestInit: RequestInit = {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  };
  const body = (init as any).body;
  if (body && typeof body === 'object' && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer)) {
    requestInit.body = JSON.stringify(body);
  }
  const response = await fetch(url, requestInit);
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export {
  parseRepoMap,
  runControlPlaneBridgeLoop,
  runControlPlaneBridgeOnce,
};
