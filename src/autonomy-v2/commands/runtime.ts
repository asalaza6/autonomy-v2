import fs from 'fs';
import { buildAgentStatusSummaries, buildPullRequestStatusSummaries, countBy, ensureInitialized, formatAgentStatusLine, formatCountSummary, formatPullRequestStatusLine, getAutonomyPaths, loadAllState, loadTrackedPrds, printOutput, readJson, } from './shared.js';

function run(rootDir, options) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const runtime = fs.existsSync(paths.runtimeState)
    ? readJson(paths.runtimeState)
    : { workers: {} };
  const { config, taskQueues, prs, branchLocks } = loadAllState(rootDir);
  const prds = loadTrackedPrds(rootDir, config, {
    taskQueues,
    prs,
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
    workers: runtime.workers || {},
    agentStatuses,
    pullRequestStatuses,
    prdCounts: countBy(prds.prds || [], 'status'),
  };

  printOutput(options, payload, () => {
    console.log(`Workers: ${Object.keys(payload.workers).length}`);
    agentStatuses.forEach((agentStatus) => {
      console.log(formatAgentStatusLine(agentStatus, { includePid: true }));
    });
    if (pullRequestStatuses.length > 0) {
      console.log('Active PRs:');
      pullRequestStatuses.forEach((prStatus) => {
        console.log(formatPullRequestStatusLine(prStatus));
      });
    }
    console.log(`PRDs: ${formatCountSummary(payload.prdCounts) || 'none'}`);
  });
}


export { run };
