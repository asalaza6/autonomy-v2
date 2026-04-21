import { loadAutonomyEnv } from '../../env/env-main.js';
import { executePrdAdd, buildPrdAddCliOptions } from '../../autonomy-v2/control-plane/prd-service.js';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { run as runDeploy } from '../../autonomy-v2/commands/deploy.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import { answerControlPlaneAgentChat } from './control-plane-chat.js';
import {
  executeControlPlanePackageUpdate,
  runDeferredPackageUpdateRestartCommands,
} from './control-plane-package-update.js';

function parseRepoMap(value: string | undefined) {
  const repoMap: Record<string, string> = {};
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) {
        repoMap[`__path_${Object.keys(repoMap).length}`] = entry;
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
  const registeredRepoRoots = resolveRegisteredRepoRoots(options.repoRoots);
  const registeredRepoIds = Object.keys(registeredRepoRoots);
  const queuedJobs = registeredRepoIds.length > 0
    ? await requestJson(
      `${options.serverUrl}/api/jobs?status=queued&repoIds=${encodeURIComponent(registeredRepoIds.join(','))}`
    )
    : { jobs: [] };
  const jobs = Array.isArray(queuedJobs.jobs) ? queuedJobs.jobs : [];
  const processed = [];
  const deferredPackageUpdateRestarts: Array<{
    jobId: string;
    repoId: string;
    commands: Parameters<typeof runDeferredPackageUpdateRestartCommands>[0];
  }> = [];
  if (jobs.length > 0) {
    logBridgeEvent('bridge:jobs:found', {
      count: jobs.length,
      repoIds: registeredRepoIds.join(','),
    });
  }

  for (const job of jobs) {
    const claimed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/claim`, {
      method: 'POST',
      body: {
        repoIds: registeredRepoIds,
      },
    }).catch(() => null);
    if (!claimed) {
      logBridgeEvent('bridge:job:claim-skipped', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type || 'prd:add',
      });
      continue;
    }
    logBridgeEvent('bridge:job:claimed', {
      jobId: job.id,
      repoId: job.repoId,
      type: job.type || 'prd:add',
    });
    const registration = registeredRepoRoots[job.repoId];
    const repoRoot = registration && registration.rootDir;
    if (!repoRoot) {
      const failure = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
        method: 'POST',
        body: {
          status: 'failed',
          error: `No local repo root configured for ${job.repoId}.`,
        },
      }).catch(() => null);
      logBridgeEvent('bridge:job:failed', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type || 'prd:add',
        reason: 'missing_repo_root',
      });
      processed.push({ jobId: job.id, status: failure && failure.status });
      continue;
    }

    try {
      loadAutonomyEnv(repoRoot);
      const snapshot = buildStatusSnapshot(repoRoot);
      await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
        method: 'POST',
        body: {
          repo: registration.repo,
          snapshot,
        },
      });
      let result: Record<string, unknown>;
      let deferredRestartCommandsForJob: Parameters<typeof runDeferredPackageUpdateRestartCommands>[0] = [];
      if (job.type === 'agent:chat') {
        logBridgeEvent('bridge:agent:chat:start', {
          jobId: job.id,
          repoId: job.repoId,
          conversationId: job.payload && job.payload.conversationId || '',
        });
        result = await answerControlPlaneAgentChat({
          repoRoot,
          repoId: job.repoId,
          payload: job.payload,
          snapshot,
        });
        logBridgeEvent('bridge:agent:chat:done', {
          jobId: job.id,
          repoId: job.repoId,
          conversationId: job.payload && job.payload.conversationId || '',
        });
      } else if (job.type === 'deploy') {
        logBridgeEvent('bridge:deploy:start', {
          jobId: job.id,
          repoId: job.repoId,
          root: repoRoot,
        });
        const execution = runDeploy(repoRoot, {});
        logBridgeEvent('bridge:deploy:done', {
          jobId: job.id,
          repoId: job.repoId,
          source: execution.sourceBranch,
          target: execution.targetBranch,
          sha: execution.sha || '-',
          pushed: execution.pushed ? 'yes' : 'no',
          deployCommand: execution.deployCommand ? execution.deployCommand.command : 'none',
        });
        result = {
          sourceBranch: execution.sourceBranch,
          targetBranch: execution.targetBranch,
          commitSha: execution.sha || null,
          pushed: execution.pushed,
          pushMessage: execution.pushMessage || null,
          version: execution.version || null,
          deployCommand: execution.deployCommand || null,
        };
      } else if (job.type === 'package:update') {
        logBridgeEvent('bridge:package:update:start', {
          jobId: job.id,
          repoId: job.repoId,
          root: repoRoot,
        });
        const execution = executeControlPlanePackageUpdate(repoRoot);
        await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
          method: 'POST',
          body: {
            repo: registration.repo,
            snapshot: execution.snapshot,
          },
        });
        logBridgeEvent('bridge:package:update:done', {
          jobId: job.id,
          repoId: job.repoId,
          packageManager: execution.packageManager,
          installedVersion: execution.installedVersion || '-',
          restart: execution.restartStatus.status,
        });
        deferredRestartCommandsForJob = execution.deferredRestartCommands;
        result = execution.result;
      } else {
        logBridgeEvent('bridge:prd:add:start', {
          jobId: job.id,
          repoId: job.repoId,
        });
        const execution = executePrdAdd(repoRoot, buildPrdAddCliOptions(job.payload));
        logBridgeEvent('bridge:prd:add:done', {
          jobId: job.id,
          repoId: job.repoId,
          prdId: execution.prdSpec.id,
          commitSha: execution.commit.commitSha || '-',
        });
        result = {
          prdId: execution.prdSpec.id,
          commitSha: execution.commit.commitSha || null,
          queueCommitSha: execution.queueCommit ? execution.queueCommit.commitSha : null,
        };
      }
      const completed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
        method: 'POST',
        body: {
          status: 'completed',
          result,
        },
      }).catch(() => null);
      logBridgeEvent('bridge:job:completed', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type || 'prd:add',
        status: completed && completed.status || 'completed',
      });
      if (completed && deferredRestartCommandsForJob.length > 0) {
        deferredPackageUpdateRestarts.push({
          jobId: job.id,
          repoId: job.repoId,
          commands: deferredRestartCommandsForJob,
        });
      }
      processed.push({ jobId: job.id, status: completed && completed.status });
    } catch (error) {
      const failed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
        method: 'POST',
        body: {
          status: 'failed',
          error: formatErrorMessage(error),
        },
      }).catch(() => null);
      logBridgeEvent('bridge:job:failed', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type || 'prd:add',
        status: failed && failed.status || 'failed',
        message: formatErrorMessage(error),
      });
      processed.push({ jobId: job.id, status: failed && failed.status });
    }
  }

  await Promise.all(Object.entries(registeredRepoRoots).map(async ([repoId, registration]) => {
    try {
      const repoRoot = registration.rootDir;
      loadAutonomyEnv(repoRoot);
      const snapshot = buildStatusSnapshot(repoRoot);
      await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(repoId)}/status`, {
        method: 'POST',
        body: {
          repo: registration.repo,
          snapshot,
        },
      });
    } catch (error) {
      // Skip repos that are not initialized or temporarily unavailable.
    }
  }));

  await requestJson(`${options.serverUrl}/api/heartbeats/bridge`, {
    method: 'POST',
    body: {
      note: 'bridge poll completed',
    },
  }).catch(() => null);

  for (const restart of deferredPackageUpdateRestarts) {
    const results = await runDeferredPackageUpdateRestartCommands(restart.commands);
    results.forEach((result) => {
      logBridgeEvent('bridge:package:update:deferred-restart', {
        jobId: restart.jobId,
        repoId: restart.repoId,
        target: result.target,
        status: result.status,
        command: result.command,
        error: result.error || '',
      });
    });
  }

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

function logBridgeEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(formatBridgeEventLine(event, fields));
}

function formatBridgeEventLine(event: string, fields: Record<string, unknown> = {}, timestamp = new Date().toISOString()) {
  const parts = [`[${timestamp}]`, event];
  Object.entries(fields).forEach(([key, value]) => {
    if (value === '' || value == null) {
      return;
    }
    parts.push(`${key}=${value}`);
  });
  return parts.join(' | ');
}

function resolveRegisteredRepoRoots(repoRoots: Record<string, string>) {
  const registrations: Record<string, { rootDir: string; repo: ReturnType<typeof loadControlPlaneConfig> }> = {};
  Object.entries(repoRoots).forEach(([configuredRepoId, repoRoot]) => {
    const repo = loadControlPlaneConfig(repoRoot);
    const repoId = String(repo.repoId || '').trim();
    const isSyntheticRepoId = configuredRepoId.startsWith('__path_');
    if (!isSyntheticRepoId && configuredRepoId && configuredRepoId !== repoId) {
      throw new Error(`Configured repo map key "${configuredRepoId}" does not match repoId "${repoId}" in ${repoRoot}.`);
    }
    if (registrations[repoId]) {
      throw new Error(`Duplicate control-plane repoId "${repoId}" for ${repoRoot}.`);
    }
    registrations[repoId] = {
      rootDir: repoRoot,
      repo,
    };
  });
  return registrations;
}

export {
  formatBridgeEventLine,
  parseRepoMap,
  resolveRegisteredRepoRoots,
  runControlPlaneBridgeLoop,
  runControlPlaneBridgeOnce,
};
