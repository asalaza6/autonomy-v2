import fs from 'fs';
import path from 'path';
import { buildAgentStatusSummaries, buildPullRequestStatusSummaries, countBy, ensureInitialized, formatAgentStatusLine, formatCountSummary, formatPullRequestStatusLine, getAutonomyPaths, getTaskQueue, listTasks, loadAllState, loadTrackedPrds, printOutput, readJson, syncIntegrationSpecs, } from './shared.js';

function run(rootDir, options) {
  ensureInitialized(rootDir);
  syncIntegrationSpecs(rootDir, options);
  const paths = getAutonomyPaths(rootDir);
  const runtime = fs.existsSync(paths.runtimeState)
    ? readJson(paths.runtimeState)
    : { workers: {} };
  const { config, sprint, taskQueues, prs, branchLocks } = loadAllState(rootDir);
  const prds = loadTrackedPrds(rootDir, config, {
    taskQueues,
    prs,
  });
  const taskCounts = countBy(listTasks(taskQueues), 'status');
  const prCounts = countBy(prs.pullRequests, 'status');
  const queues = (config.agents || []).map((agent) => {
    const queue = getTaskQueue(taskQueues, config, agent.id);
    return {
      agentId: queue.agentId,
      role: queue.role,
      taskCount: queue.tasks.length,
      statuses: countBy(queue.tasks, 'status'),
    };
  });
  const agentStatuses = buildAgentStatusSummaries({
    rootDir,
    config,
    taskQueues,
    prs,
    branchLocks,
    runtime,
    prds,
  });
  const pullRequestStatuses = buildPullRequestStatusSummaries({
    taskQueues,
    prs,
    runtime,
    branchLocks,
  });
  const payload = {
    configPath: path.relative(rootDir, paths.agentsConfig),
    sprintPath: path.relative(rootDir, paths.sprintConfig),
    configSchemaVersion: typeof config.schemaVersion === 'undefined' ? null : config.schemaVersion,
    integrationBranch: config.integrationBranch,
    productionBranch: config.productionBranch,
    blockedBranches: config.blockedBranches || [],
    sprint,
    agents: config.agents || [],
    agentStatuses,
    queues,
    taskCounts,
    prCounts,
    pullRequestStatuses,
    branchLockCount: branchLocks.locks.length,
  };

  printOutput(options, payload, () => {
    console.log(`Config file: ${path.relative(rootDir, paths.agentsConfig)}`);
    console.log(`Sprint file: ${path.relative(rootDir, paths.sprintConfig)}`);
    if (typeof config.schemaVersion !== 'undefined') {
      console.log(`Config schema version: ${config.schemaVersion}`);
    }
    console.log(`Integration branch: ${config.integrationBranch}`);
    console.log(`Production branch: ${config.productionBranch}`);
    console.log(`Blocked branches: ${(config.blockedBranches || []).join(', ')}`);
    console.log(`Loaded agents: ${(config.agents || []).map((agent) => `${agent.id}:${agent.role}`).join(', ')}`);
    console.log('Agent status:');
    agentStatuses.forEach((agentStatus) => {
      console.log(formatAgentStatusLine(agentStatus, { includePid: true }));
    });
    console.log(`Tasks: ${formatCountSummary(taskCounts) || 'none'}`);
    queues.forEach((queue) => {
      console.log(`Queue ${queue.agentId}: ${formatCountSummary(queue.statuses) || 'empty'}`);
    });
    console.log(`PRs: ${formatCountSummary(prCounts) || 'none'}`);
    if (pullRequestStatuses.length > 0) {
      console.log('Active PRs:');
      pullRequestStatuses.forEach((prStatus) => {
        console.log(formatPullRequestStatusLine(prStatus));
      });
    }
    console.log(`Branch locks: ${branchLocks.locks.length}`);
  });
}


export { run };
