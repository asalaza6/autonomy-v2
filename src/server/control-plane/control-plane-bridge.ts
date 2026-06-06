import fs from 'fs';
import { loadAutonomyEnv } from '../../env/env-main.js';
import type { ControlPlaneAgentChatMessagePayload, ControlPlaneCustomAgentTogglePayload, ControlPlaneJobRecord, ControlPlanePrdPriorityPayload, ControlPlanePrdResetPayload } from '../../types.js';
import { executePrdAdd, buildPrdAddCliOptions, executePrdPriorityUpdate, executePrdReset } from '../../autonomy-v2/control-plane/prd-service.js';
import { buildStatusSnapshot } from '../../autonomy-v2/control-plane/status-service.js';
import { run as runDeploy } from '../../autonomy-v2/commands/deploy.js';
import { loadControlPlaneConfig } from './control-plane-config.js';
import { answerControlPlaneAgentChat } from './control-plane-chat.js';
import { recordControlPlaneServiceLifecycle } from './control-plane-lifecycle.js';
import { completeJob, enqueueJob, getControlPlanePaths, loadControlPlaneState, setManagedProcess } from './control-plane-store.js';
import { setCustomAgentEnabledOverride } from '../orchestrator/custom-agents.js';
import {
  executeControlPlaneRestart,
  executeControlPlanePackageUpdate,
  runDeferredControlPlaneRestartCommands,
} from './control-plane-package-update.js';

const CONTROL_BRIDGE_START_DELAY_ENV = 'AUTONOMY_CONTROL_PLANE_BRIDGE_START_DELAY_MS';
const DEFERRED_RESTART_RESULT_POLL_MS = 100;
const DEFAULT_DEFERRED_RESTART_RESULT_TIMEOUT_MS = 12_000;

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

function mergeDeferredRestartLaunchResults(
  result: Record<string, unknown>,
  launchResults: Array<DeferredLaunchResult>,
  options: {
    persistedResult?: Record<string, unknown> | null;
    unresolvedDefaultTargets?: Array<'server' | 'controlBridge'>;
  } = {}
) {
  const persistedResult = options.persistedResult && typeof options.persistedResult === 'object'
    ? options.persistedResult
    : null;
  const nextResult = {
    ...result,
    ...(persistedResult || {}),
  };
  const persistedRestartStatus = persistedResult && persistedResult.restartStatus && typeof persistedResult.restartStatus === 'object'
    ? persistedResult.restartStatus as Record<string, unknown>
    : null;
  const restartStatus = {
    ...(nextResult.restartStatus && typeof nextResult.restartStatus === 'object'
      ? nextResult.restartStatus as Record<string, unknown>
      : {}),
  };

  if (persistedRestartStatus) {
    ['server', 'controlBridge'].forEach((target) => {
      const persistedTarget = persistedRestartStatus[target];
      if (!persistedTarget || typeof persistedTarget !== 'object') {
        return;
      }
      const previousTarget = restartStatus[target] && typeof restartStatus[target] === 'object'
        ? restartStatus[target] as Record<string, unknown>
        : {};
      restartStatus[target] = {
        ...previousTarget,
        ...(persistedTarget as Record<string, unknown>),
      };
    });
    Object.entries(persistedRestartStatus).forEach(([key, value]) => {
      if (key === 'server' || key === 'controlBridge') {
        return;
      }
      restartStatus[key] = value;
    });
  }

  let latestCompletedAt = String(restartStatus.completedAt || '').trim() || null;

  launchResults.forEach((launchResult) => {
    if (launchResult.mode === 'default') {
      if (launchResult.status === 'failed') {
        const completedAt = launchResult.completedAt;
        (launchResult.targets || []).forEach((target) => {
          const previousTarget = restartStatus[target] && typeof restartStatus[target] === 'object'
            ? restartStatus[target] as Record<string, unknown>
            : {};
          restartStatus[target] = {
            ...previousTarget,
            status: 'failed',
            postRestartPid: null,
            completedAt,
            reason: 'restart-helper-launch-failed',
            error: launchResult.error || 'Default restart helper failed to launch.',
          };
        });
        if (!latestCompletedAt || Date.parse(completedAt) >= Date.parse(latestCompletedAt)) {
          latestCompletedAt = completedAt;
        }
      }
      return;
    }
    if (launchResult.target !== 'server' && launchResult.target !== 'controlBridge') {
      return;
    }
    const previousTarget = restartStatus[launchResult.target] && typeof restartStatus[launchResult.target] === 'object'
      ? restartStatus[launchResult.target] as Record<string, unknown>
      : {};
    const postRestartPid = launchResult.postRestartPid ?? null;
    const nextTarget: Record<string, unknown> = {
      ...previousTarget,
      status: launchResult.status === 'launched' ? 'restarted' : 'failed',
      postRestartPid,
      completedAt: launchResult.completedAt,
    };
    if (launchResult.outputSessionId) {
      nextTarget.outputSessionId = launchResult.outputSessionId;
    }
    if (launchResult.error) {
      nextTarget.error = launchResult.error;
    } else {
      delete nextTarget.error;
    }
    if (launchResult.status === 'launched' && postRestartPid === null) {
      nextTarget.reason = 'post-restart-pid-unavailable';
    } else {
      delete nextTarget.reason;
    }
    restartStatus[launchResult.target] = nextTarget;
    if (!latestCompletedAt || Date.parse(launchResult.completedAt) >= Date.parse(latestCompletedAt)) {
      latestCompletedAt = launchResult.completedAt;
    }
  });

  if (Array.isArray(options.unresolvedDefaultTargets) && options.unresolvedDefaultTargets.length > 0) {
    const completedAt = new Date().toISOString();
    options.unresolvedDefaultTargets.forEach((target) => {
      const previousTarget = restartStatus[target] && typeof restartStatus[target] === 'object'
        ? restartStatus[target] as Record<string, unknown>
        : {};
      restartStatus[target] = {
        ...previousTarget,
        status: 'failed',
        postRestartPid: null,
        completedAt,
        reason: 'restart-evidence-unavailable',
        error: 'Default restart completed without persisted restart evidence.',
      };
    });
    latestCompletedAt = completedAt;
  }

  const targetStatuses = [restartStatus.controlBridge, restartStatus.server]
    .map((entry) => entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).status || '').trim() : '')
    .filter(Boolean);
  restartStatus.status = summarizeRestartStatus(targetStatuses);
  if (latestCompletedAt && restartStatus.status !== 'deferred') {
    restartStatus.completedAt = latestCompletedAt;
  }
  nextResult.restartStatus = restartStatus;
  nextResult.errors = [restartStatus.controlBridge, restartStatus.server]
    .map((entry) => entry && typeof entry === 'object' ? String((entry as Record<string, unknown>).error || '').trim() : '')
    .filter(Boolean);
  return nextResult;
}

type DeferredLaunchResult = {
    target: 'server' | 'controlBridge' | 'default';
    mode: 'configured' | 'default';
    status: 'launched' | 'failed';
    completedAt: string;
    postRestartPid?: number | null;
    outputSessionId?: string;
    targets?: Array<'server' | 'controlBridge'>;
    error?: string;
};

function summarizeRestartStatus(targetStatuses: string[]) {
  if (targetStatuses.includes('failed') || targetStatuses.includes('relaunch-failed') || targetStatuses.includes('stale-pid')) {
    return 'failed';
  }
  if (targetStatuses.includes('deferred')) {
    return 'deferred';
  }
  if (targetStatuses.includes('restarted')) {
    return 'restarted';
  }
  if (targetStatuses.length > 0 && targetStatuses.every((status) => status === 'skipped')) {
    return 'skipped';
  }
  return targetStatuses[0] || 'skipped';
}

function reconcileManagedRestartProcesses(
  repoRoot: string,
  repoId: string,
  job: Pick<ControlPlaneJobRecord, 'id' | 'payload'>,
  result: Record<string, unknown>
) {
  const restartStatus = result && result.restartStatus && typeof result.restartStatus === 'object'
    ? result.restartStatus as Record<string, unknown>
    : null;
  if (!restartStatus) {
    return;
  }
  (['server', 'controlBridge'] as const).forEach((target) => {
    const targetStatus = restartStatus[target];
    if (!targetStatus || typeof targetStatus !== 'object') {
      return;
    }
    const entry = targetStatus as Record<string, unknown>;
    const status = String(entry.status || '').trim();
    const preRestartPid = normalizeManagedPid(entry.preRestartPid);
    const postRestartPid = normalizeManagedPid(entry.postRestartPid);
    const pid = postRestartPid ?? normalizeManagedPid(entry.pid);
    const singletonOutcome = resolveSingletonOutcome(status, preRestartPid, postRestartPid, entry.reason);
    setManagedProcess(repoRoot, repoId, target, {
      sessionId: String(entry.processSessionId || `${job.id}:${target}`).trim(),
      outputSessionId: String(entry.outputSessionId || entry.processSessionId || `${job.id}:${target}`).trim(),
      pid: pid ?? undefined,
      running: status === 'restarted' && Boolean(pid),
      launchMode: String(entry.mode || '').trim() === 'default' ? 'default' : 'configured',
      singletonOutcome,
      command: String(entry.command || '').trim() || null,
      cwd: String(entry.cwd || '').trim() || null,
      requestedBySessionId: String((job.payload as Record<string, unknown>)?.controlSessionId || '').trim() || null,
      requestedBySessionLabel: String((job.payload as Record<string, unknown>)?.controlSessionLabel || '').trim() || null,
      requestedAt: String(restartStatus.completedAt || entry.completedAt || new Date().toISOString()),
      startedAt: String(entry.recordedAt || restartStatus.completedAt || new Date().toISOString()),
      completedAt: String(entry.completedAt || restartStatus.completedAt || new Date().toISOString()),
      preRestartPid: preRestartPid ?? undefined,
      postRestartPid: postRestartPid ?? pid ?? undefined,
      replacementOfPid: preRestartPid ?? undefined,
      error: String(entry.error || '').trim() || null,
      exitReason: status === 'failed' || status === 'relaunch-failed' ? String(entry.reason || status).trim() || status : null,
    });
  });
}

function normalizeManagedPid(value: unknown) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function resolveSingletonOutcome(status: string, preRestartPid: number | null, postRestartPid: number | null, reason: unknown) {
  if (status === 'restarted') {
    if (preRestartPid && postRestartPid && preRestartPid !== postRestartPid) {
      return 'replaced';
    }
    if (postRestartPid) {
      return preRestartPid ? 'reused' : 'started';
    }
  }
  if (String(reason || '').trim() === 'owned-by-another-session') {
    return 'refused';
  }
  return status === 'failed' || status === 'relaunch-failed' ? 'failed' : preRestartPid ? 'reused' : 'started';
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
    repoRoot: string;
    payload: ControlPlaneJobRecord['payload'];
    commands: Parameters<typeof runDeferredControlPlaneRestartCommands>[0];
    result: Record<string, unknown>;
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
        const execution = await executeControlPlanePackageUpdate(repoRoot);
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
          commitStatus: execution.result && execution.result.commit && execution.result.commit.committed ? 'committed' : 'skipped',
          commitReason: execution.result && execution.result.commit && execution.result.commit.reason || '',
          commitSha: execution.result && execution.result.commitSha || '',
          pushMessage: execution.result && execution.result.pushMessage || '',
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
      } else if (job.type === 'custom-agent:toggle') {
        const payload = job.payload as ControlPlaneCustomAgentTogglePayload;
        logBridgeEvent('bridge:custom-agent:toggle:start', {
          jobId: job.id,
          repoId: job.repoId,
          runtimeKey: payload.runtimeKey,
          enabled: payload.enabled === true ? 'true' : 'false',
        });
        const agent = setCustomAgentEnabledOverride(repoRoot, payload.runtimeKey, payload.enabled === true);
        const snapshot = buildStatusSnapshot(repoRoot);
        await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
          method: 'POST',
          body: {
            repo: registration.repo,
            snapshot,
          },
        });
        logBridgeEvent('bridge:custom-agent:toggle:done', {
          jobId: job.id,
          repoId: job.repoId,
          runtimeKey: payload.runtimeKey,
          enabled: payload.enabled === true ? 'true' : 'false',
        });
        result = {
          runtimeKey: payload.runtimeKey,
          enabled: payload.enabled === true,
          agent,
        };
      } else if (job.type === 'prd:reset') {
        logBridgeEvent('bridge:prd:reset:start', {
          jobId: job.id,
          repoId: job.repoId,
          root: repoRoot,
        });
        const execution = executePrdReset(repoRoot, {
          'confirm-prd-id': (job.payload as ControlPlanePrdResetPayload).confirmPrdId,
          reason: (job.payload as ControlPlanePrdResetPayload).reason || '',
        });
        const snapshot = buildStatusSnapshot(repoRoot);
        await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
          method: 'POST',
          body: {
            repo: registration.repo,
            snapshot,
          },
        });
        logBridgeEvent('bridge:prd:reset:done', {
          jobId: job.id,
          repoId: job.repoId,
          prdId: execution.prdId || '',
          noop: execution.noop ? 'yes' : 'no',
          commitSha: execution.commitSha || '',
        });
        result = execution;
      } else if (job.type === 'prd:priority') {
        logBridgeEvent('bridge:prd:priority:start', {
          jobId: job.id,
          repoId: job.repoId,
          root: repoRoot,
        });
        const execution = executePrdPriorityUpdate(repoRoot, {
          'prd-id': (job.payload as ControlPlanePrdPriorityPayload).prdId,
          priority: (job.payload as ControlPlanePrdPriorityPayload).priority,
          reason: (job.payload as ControlPlanePrdPriorityPayload).reason || '',
        });
        const snapshot = buildStatusSnapshot(repoRoot);
        await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
          method: 'POST',
          body: {
            repo: registration.repo,
            snapshot,
          },
        });
        logBridgeEvent('bridge:prd:priority:done', {
          jobId: job.id,
          repoId: job.repoId,
          prdId: execution.prdId || '',
          priority: execution.priority || '',
          commitSha: execution.commitSha || '',
        });
        result = execution;
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
        if (deferredRestartCommandsForJob.some((command) => command.mode === 'default')) {
          mirrorRestartJobLocally(repoRoot, job, result);
        }
        deferredControlPlaneRestarts.push({
          jobId: job.id,
          repoId: job.repoId,
          repoRoot,
          payload: job.payload,
          commands: deferredRestartCommandsForJob,
          result,
        });
      } else if (deferredRestartCommandsForJob.length > 0) {
        logBridgeEvent('bridge:restart:deferred-skipped', {
          jobId: job.id,
          repoId: job.repoId,
          reason: completionError ? 'completion-failed' : 'completion-not-acknowledged',
          status: completionResponseStatus || '',
          error: completionError || '',
        });
      } else if (job.type === 'restart') {
        reconcileManagedRestartProcesses(repoRoot, job.repoId, job, result);
        const updatedSnapshot = buildStatusSnapshot(repoRoot);
        await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(job.repoId)}/status`, {
          method: 'POST',
          body: {
            repo: registration.repo,
            snapshot: updatedSnapshot,
          },
        }).catch(() => null);
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
      repoIds: registeredRepoIds,
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
    const defaultTargets = collectDefaultRestartTargets(restart.commands);
    const persistedResult = await waitForPersistedDefaultRestartResult(restart.repoRoot, restart.jobId, defaultTargets, results);
    const unresolvedDefaultTargets = defaultTargets.filter((target) => {
      if (!persistedResult || !persistedResult.restartStatus || typeof persistedResult.restartStatus !== 'object') {
        return true;
      }
      const targetResult = persistedResult.restartStatus[target];
      return !targetResult
        || typeof targetResult !== 'object'
        || String((targetResult as Record<string, unknown>).status || '').trim() === 'deferred';
    });
    const finalResult = mergeDeferredRestartLaunchResults(restart.result, results, {
      persistedResult,
      unresolvedDefaultTargets,
    });
    const updated = await requestJson(`${options.serverUrl}/api/jobs/${encodeURIComponent(restart.jobId)}/complete`, {
      method: 'POST',
      body: {
        status: 'completed',
        result: finalResult,
      },
    }).catch(() => null);
    const localJob = {
      id: restart.jobId,
      payload: restart.payload,
    } as Pick<ControlPlaneJobRecord, 'id' | 'payload'>;
    reconcileManagedRestartProcesses(restart.repoRoot, restart.repoId, localJob, finalResult);
    const refreshedSnapshot = buildStatusSnapshot(restart.repoRoot);
    await requestJson(`${options.serverUrl}/api/repos/${encodeURIComponent(restart.repoId)}/status`, {
      method: 'POST',
      body: {
        repo: registeredRepoRoots[restart.repoId]?.repo,
        snapshot: refreshedSnapshot,
      },
    }).catch(() => null);
    logBridgeEvent('bridge:restart:deferred-complete', {
      jobId: restart.jobId,
      repoId: restart.repoId,
      status: getResponseStatus(updated) || 'unacknowledged',
    });
  }

  return {
    processed,
  };
}

function mirrorRestartJobLocally(repoRoot: string, job: ControlPlaneJobRecord, result: Record<string, unknown>) {
  const existing = loadControlPlaneState(repoRoot).jobs.find((entry) => entry.id === job.id);
  if (!existing) {
    enqueueJob(repoRoot, {
      ...job,
      status: 'claimed',
    });
  }
  completeJob(repoRoot, job.id, {
    status: 'completed',
    result,
  });
}

function collectDefaultRestartTargets(
  commands: Parameters<typeof runDeferredControlPlaneRestartCommands>[0]
): Array<'server' | 'controlBridge'> {
  const targets = new Set<'server' | 'controlBridge'>();
  commands.forEach((command) => {
    if (command.mode !== 'default') {
      return;
    }
    command.helperPlan.targets.forEach((target) => {
      targets.add(target.target);
    });
  });
  return Array.from(targets);
}

async function waitForPersistedDefaultRestartResult(
  repoRoot: string,
  jobId: string,
  defaultTargets: Array<'server' | 'controlBridge'>,
  launchResults: DeferredLaunchResult[]
) {
  if (defaultTargets.length === 0) {
    return null;
  }
  const defaultLaunchFailed = launchResults.some((result) => result.mode === 'default' && result.status === 'failed');
  if (defaultLaunchFailed) {
    return null;
  }
  const deadline = Date.now() + DEFAULT_DEFERRED_RESTART_RESULT_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const persistedResult = readPersistedJobResult(repoRoot, jobId);
    if (hasPersistedDefaultRestartEvidence(persistedResult, defaultTargets)) {
      return persistedResult;
    }
    await delay(DEFERRED_RESTART_RESULT_POLL_MS);
  }
  return readPersistedJobResult(repoRoot, jobId);
}

function readPersistedJobResult(repoRoot: string, jobId: string) {
  try {
    const { statePath } = getControlPlanePaths(repoRoot);
    if (!fs.existsSync(statePath)) {
      return null;
    }
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
    const job = jobs.find((entry) => entry && typeof entry === 'object' && entry.id === jobId);
    return job && job.result && typeof job.result === 'object' ? job.result as Record<string, unknown> : null;
  } catch (_) {
    return null;
  }
}

function hasPersistedDefaultRestartEvidence(
  result: Record<string, unknown> | null,
  defaultTargets: Array<'server' | 'controlBridge'>
) {
  if (!result || !result.restartStatus || typeof result.restartStatus !== 'object') {
    return false;
  }
  const restartStatus = result.restartStatus as Record<string, unknown>;
  return defaultTargets.every((target) => {
    const targetResult = restartStatus[target];
    return Boolean(
      targetResult
      && typeof targetResult === 'object'
      && String((targetResult as Record<string, unknown>).status || '').trim()
      && String((targetResult as Record<string, unknown>).status || '').trim() !== 'deferred'
    );
  });
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
