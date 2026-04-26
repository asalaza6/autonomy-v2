import { loadAutonomyEnv } from '../../env/env-main.js';
import type { ControlPlaneAgentChatMessagePayload, ControlPlaneJobRecord } from '../../types.js';
import { executePrdAdd, buildPrdAddCliOptions } from '../../autonomy-v2/control-plane/prd-service.js';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { run as runDeploy } from '../../autonomy-v2/commands/deploy.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import { answerControlPlaneAgentChat } from './control-plane-chat.js';
import { recordControlPlaneServiceLifecycle } from './control-plane-lifecycle.js';
import {
  executeControlPlaneRestart,
  executeControlPlanePackageUpdate,
  runDeferredControlPlaneRestartCommands,
} from './control-plane-package-update.js';

const CONTROL_BRIDGE_START_DELAY_ENV = 'AUTONOMY_CONTROL_PLANE_BRIDGE_START_DELAY_MS';

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
  const processed = [];
  const deferredControlPlaneRestarts: Array<{
    jobId: string;
    repoId: string;
    commands: Parameters<typeof runDeferredControlPlaneRestartCommands>[0];
  }> = [];
  while (registeredRepoIds.length > 0) {
    const claimed = await requestJson(`${options.serverUrl}/api/jobs/claim-next`, {
      method: 'POST',
      body: {
        repoIds: registeredRepoIds,
      },
    });
    const job = extractClaimedJob(claimed);
    if (!job) {
      break;
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
      let deferredRestartCommandsForJob: Parameters<typeof runDeferredControlPlaneRestartCommands>[0] = [];
      if (job.type === 'agent:chat') {
        const chatPayload = job.payload as ControlPlaneAgentChatMessagePayload;
        logBridgeEvent('bridge:agent:chat:start', {
          jobId: job.id,
          repoId: job.repoId,
          conversationId: chatPayload && chatPayload.conversationId || '',
        });
        result = await answerControlPlaneAgentChat({
          repoRoot,
          repoId: job.repoId,
          payload: chatPayload,
          snapshot,
        });
        logBridgeEvent('bridge:agent:chat:done', {
          jobId: job.id,
          repoId: job.repoId,
          conversationId: chatPayload && chatPayload.conversationId || '',
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
        });
        result = execution.result;
      } else if (job.type === 'restart') {
        logBridgeEvent('bridge:restart:start', {
          jobId: job.id,
          repoId: job.repoId,
          root: repoRoot,
        });
        const execution = executeControlPlaneRestart(repoRoot, {
          jobId: job.id,
          repoId: job.repoId,
        });
        await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
          method: 'POST',
          body: {
            repo: registration.repo,
            snapshot: execution.snapshot,
          },
        });
        logBridgeEvent('bridge:restart:done', {
          jobId: job.id,
          repoId: job.repoId,
          restart: execution.restartStatus.status,
          server: execution.restartStatus.server && execution.restartStatus.server.status || '',
          bridge: execution.restartStatus.controlBridge && execution.restartStatus.controlBridge.status || '',
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
      let completionError: string | null = null;
      const completed = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(job.id)}/complete`, {
        method: 'POST',
        body: {
          status: 'completed',
          result,
        },
      }).catch((error) => {
        completionError = formatErrorMessage(error);
        return null;
      });
      const completionResponseStatus = getResponseStatus(completed);
      const completionAcknowledged = isCompletedJobResponse(completed, job.id);
      const completedStatus = completionAcknowledged ? completionResponseStatus : '';
      logBridgeEvent('bridge:job:completed', {
        jobId: job.id,
        repoId: job.repoId,
        type: job.type || 'prd:add',
        status: completedStatus || 'unacknowledged',
      });
      if (isCompletedJobResponse(completed, job.id) && deferredRestartCommandsForJob.length > 0) {
        deferredControlPlaneRestarts.push({
          jobId: job.id,
          repoId: job.repoId,
          commands: deferredRestartCommandsForJob,
        });
      } else if (deferredRestartCommandsForJob.length > 0) {
        logBridgeEvent('bridge:restart:deferred-skipped', {
          jobId: job.id,
          repoId: job.repoId,
          reason: completionError ? 'completion-failed' : 'completion-not-acknowledged',
          status: completionResponseStatus || '',
          error: completionError || '',
        });
      }
      processed.push({ jobId: job.id, status: completedStatus });
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

  for (const restart of deferredControlPlaneRestarts) {
    const results = await runDeferredControlPlaneRestartCommands(restart.commands);
    results.forEach((result) => {
      logBridgeEvent('bridge:restart:deferred-launch', {
        jobId: restart.jobId,
        repoId: restart.repoId,
        target: result.target,
        mode: result.mode,
        targets: Array.isArray(result.targets) ? result.targets.join(',') : '',
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
  recordControlBridgeLifecycle(options.repoRoots);
  const startupDelayMs = normalizeBridgeStartupDelay(process.env[CONTROL_BRIDGE_START_DELAY_ENV]);
  delete process.env[CONTROL_BRIDGE_START_DELAY_ENV];
  if (startupDelayMs > 0) {
    await delay(startupDelayMs);
  }
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

function normalizeBridgeStartupDelay(value: unknown) {
  const delayMs = Number(value);
  return Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0;
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

function getResponseStatus(value: unknown) {
  return value && typeof value === 'object' && 'status' in value
    ? String((value as { status?: unknown }).status || '')
    : '';
}

function getResponseId(value: unknown) {
  return value && typeof value === 'object' && 'id' in value
    ? String((value as { id?: unknown }).id || '')
    : '';
}

function extractClaimedJob(value: unknown) {
  if (!value || typeof value !== 'object' || !('job' in value)) {
    return null;
  }
  const job = (value as { job?: ControlPlaneJobRecord | null }).job;
  if (!job || typeof job !== 'object') {
    return null;
  }
  return job;
}

function isCompletedJobResponse(value: unknown, jobId: string) {
  return getResponseStatus(value) === 'completed' && getResponseId(value) === jobId;
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

function recordControlBridgeLifecycle(repoRoots: Record<string, string>) {
  const registrations = resolveRegisteredRepoRoots(repoRoots);
  const targets = Object.values(registrations);
  if (targets.length === 0) {
    return;
  }
  targets.forEach((registration) => {
    recordControlPlaneServiceLifecycle(registration.rootDir, 'controlBridge', {
      restartCommand: registration.repo.controlBridgeRestartCommand,
    });
  });
}

export {
  formatBridgeEventLine,
  parseRepoMap,
  resolveRegisteredRepoRoots,
  runControlPlaneBridgeLoop,
  runControlPlaneBridgeOnce,
};
