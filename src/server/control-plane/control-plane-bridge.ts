import { loadAutonomyEnv } from '../../env/env-main.js';
import { executePrdAdd, buildPrdAddCliOptions } from '../../autonomy-v2/control-plane/prd-service.js';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { bootstrapManagedSite } from './manager-process.js';
import { deployManagedSiteToHeroku } from './manager-heroku.js';
import { upsertManagedSite } from './manager-store.js';
import type { ControlPlaneSiteCreatePayload, ControlPlaneSiteDeployPayload } from '../../types.js';

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
    console.log(`[bridge] claimed job ${job.id} (${job.type})`);
    const claimed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/claim`, {
      method: 'POST',
    }).catch(() => null);
    if (!claimed) {
      console.log(`[bridge] skipped job ${job.id} because it was already claimed`);
      continue;
    }

    if (job.type === 'site:create') {
      const payload = job.payload as ControlPlaneSiteCreatePayload;
      try {
        loadAutonomyEnv(rootDir);
        console.log(`[bridge] bootstrapping site ${payload.site.id} at ${payload.site.siteDir}`);
        const site = await bootstrapManagedSite(rootDir, payload.site);
        console.log(`[bridge] bootstrap complete for ${site.id}; publishing=${payload.publishToHeroku === true}`);
        const updatedSite = payload.publishToHeroku === true
          ? (await deployManagedSiteToHeroku(rootDir, site.id, {
              appName: payload.herokuAppName,
            })).site
          : site;
        if (payload.publishToHeroku === true) {
          console.log(`[bridge] deployed site ${site.id} to ${updatedSite.publicUrl || updatedSite.deployment?.appUrl || 'Heroku'}`);
        }
        await requestJson(`${options.serverUrl}/api/sites/${encodeURIComponent(site.id)}/bootstrap`, {
          method: 'POST',
          body: {
            site: updatedSite,
          },
        });
        console.log(`[bridge] synced site ${site.id} back to manager`);
        const completed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
          method: 'POST',
          body: {
            status: 'completed',
            result: {
              siteId: site.id,
              localUrl: updatedSite.localUrl || null,
              publicUrl: updatedSite.publicUrl || null,
              deploymentStatus: updatedSite.deployment?.status || null,
            },
          },
        }).catch(() => null);
        console.log(`[bridge] completed job ${job.id} for site ${site.id}`);
        processed.push({ jobId: job.id, status: completed && completed.status });
      } catch (error) {
        console.error(`[bridge] site:create failed for ${payload.site.id}: ${formatErrorMessage(error)}`);
        const failed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
          method: 'POST',
          body: {
            status: 'failed',
            error: formatErrorMessage(error),
          },
        }).catch(() => null);
        processed.push({ jobId: job.id, status: failed && failed.status });
      }
      continue;
    }

    if (job.type === 'site:deploy') {
      const payload = job.payload as ControlPlaneSiteDeployPayload;
      try {
        loadAutonomyEnv(rootDir);
        const siteRoot = String(payload.site.repoRoot || payload.site.siteDir);
        console.log(`[bridge] deploying site ${payload.site.id} from ${siteRoot}`);
        upsertManagedSite(rootDir, payload.site);
        const updatedSite = await deployManagedSiteToHeroku(rootDir, payload.site.id, {
          appName: payload.herokuAppName,
        }).then((result) => result.site);
        if (updatedSite.deployment?.status === 'skipped') {
          console.log(`[bridge] deploy skipped for ${payload.site.id}: ${String(updatedSite.deployment.lastError || 'unknown reason')}`);
        } else if (updatedSite.deployment?.status === 'failed') {
          console.log(`[bridge] deploy failed for ${payload.site.id}: ${String(updatedSite.deployment.lastError || 'unknown error')}`);
        } else {
          console.log(`[bridge] deploy complete for ${payload.site.id} -> ${updatedSite.publicUrl || updatedSite.deployment?.appUrl || 'Heroku'}`);
        }
        await requestJson(`${options.serverUrl}/api/sites/${encodeURIComponent(payload.site.id)}/bootstrap`, {
          method: 'POST',
          body: {
            site: updatedSite,
          },
        });
        console.log(`[bridge] synced deployment for ${payload.site.id} back to manager`);
        const completed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
          method: 'POST',
          body: {
            status: 'completed',
            result: {
              siteId: payload.site.id,
              publicUrl: updatedSite.publicUrl || null,
              deploymentStatus: updatedSite.deployment?.status || null,
            },
          },
        }).catch(() => null);
        console.log(`[bridge] completed deploy job ${job.id} for site ${payload.site.id}`);
        processed.push({ jobId: job.id, status: completed && completed.status });
      } catch (error) {
        console.error(`[bridge] site:deploy failed for ${payload.site.id}: ${formatErrorMessage(error)}`);
        const failed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
          method: 'POST',
          body: {
            status: 'failed',
            error: formatErrorMessage(error),
          },
        }).catch(() => null);
        processed.push({ jobId: job.id, status: failed && failed.status });
      }
      continue;
    }

    const repoRoot = options.repoRoots[job.repoId];
    if (!repoRoot) {
      console.error(`[bridge] no repo root configured for ${job.repoId}`);
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
      console.log(`[bridge] running prd:add ${job.payload.id} in ${repoRoot}`);
      const execution = executePrdAdd(repoRoot, buildPrdAddCliOptions(job.payload));
      const snapshot = buildStatusSnapshot(repoRoot);
      await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
        method: 'POST',
        body: {
          snapshot,
        },
      });
      console.log(`[bridge] synced repo status for ${job.repoId}`);
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
      console.log(`[bridge] completed job ${job.id} for repo ${job.repoId}`);
      processed.push({ jobId: job.id, status: completed && completed.status });
    } catch (error) {
      console.error(`[bridge] prd:add failed for ${job.id}: ${formatErrorMessage(error)}`);
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

async function requestJson(url: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}) {
  return requestJsonWithRetry(url, init);
}

async function requestJsonWithRetry(url: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}, retries = 2) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestJsonOnce(url, init);
    } catch (error) {
      lastError = error;
      if (!shouldRetryRequestError(error) || attempt === retries) {
        break;
      }
      await delay(100 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(formatErrorMessage(lastError));
}

async function requestJsonOnce(url: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}) {
  const requestInit: Omit<RequestInit, 'body'> & { body?: unknown } = {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  };
  const body = init.body;
  if (body && typeof body === 'object' && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer)) {
    requestInit.body = JSON.stringify(body);
  }
  const response = await fetch(url, requestInit as RequestInit);
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

function shouldRetryRequestError(error: unknown) {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes('fetch failed')
    || message.includes('econnreset')
    || message.includes('etimedout')
    || message.includes('eai_again')
  );
}

export {
  parseRepoMap,
  runControlPlaneBridgeLoop,
  runControlPlaneBridgeOnce,
};
