import { ensureInitialized, formatCountSummary, printOutput } from './shared-core.js';
import { formatAgentStatusLine } from './shared-agent-status.js';
import { formatPullRequestStatusLine } from './shared-pr-status.js';
import { syncIntegrationSpecs } from './shared-sync.js';
import { buildStatusSnapshot } from '../control-plane/status-service.js';
import { describePrd, selectActivePrd, selectQueuedPrds } from '../control-plane/status-view.js';

function run(rootDir, options) {
  ensureInitialized(rootDir);
  syncIntegrationSpecs(rootDir, options);
  const payload = buildStatusSnapshot(rootDir);

  printOutput(options, payload, () => {
    console.log(`Config file: ${payload.configPath}`);
    console.log(`Sprint file: ${payload.sprintPath}`);
    if (typeof payload.configSchemaVersion !== 'undefined') {
      console.log(`Config schema version: ${payload.configSchemaVersion}`);
    }
    console.log(`Integration branch: ${payload.integrationBranch}`);
    console.log(`Production branch: ${payload.productionBranch}`);
    console.log(`Blocked branches: ${(payload.blockedBranches || []).join(', ')}`);
    console.log(`Loaded agents: ${(payload.agents || []).map((agent) => `${agent.id}:${agent.role}`).join(', ')}`);
    console.log('Agent status:');
    payload.agentStatuses.forEach((agentStatus) => {
      console.log(formatAgentStatusLine(agentStatus, { includePid: true }));
    });
    console.log(`Tasks: ${formatCountSummary(payload.taskCounts) || 'none'}`);
    payload.queues.forEach((queue) => {
      console.log(`Queue ${queue.agentId}: ${formatCountSummary(queue.statuses) || 'empty'}`);
    });
    console.log(`PRs: ${formatCountSummary(payload.prCounts) || 'none'}`);
    if (payload.pullRequestStatuses.length > 0) {
      console.log('Pull requests awaiting action:');
      payload.pullRequestStatuses.forEach((prStatus) => {
        console.log(formatPullRequestStatusLine(prStatus));
      });
    }
    const activePrd = selectActivePrd(payload.prds && payload.prds.prds ? payload.prds.prds : []);
    const queuedPrds = selectQueuedPrds(payload.prds && payload.prds.prds ? payload.prds.prds : []);
    console.log('PRDs:');
    if (activePrd) {
      const summary = describePrd(activePrd);
      console.log(`Active PRD: ${summary.title} | ${summary.stateLabel}${summary.detail ? ` | ${summary.detail}` : ''}`);
    } else {
      console.log('Active PRD: none');
    }
    if (queuedPrds.length > 0) {
      console.log('Queued PRDs:');
      queuedPrds.forEach((prd) => {
        const summary = describePrd(prd);
        console.log(`- ${summary.title} | ${summary.stateLabel}${summary.detail ? ` | ${summary.detail}` : ''}`);
      });
    } else {
      console.log('Queued PRDs: none');
    }
    console.log(`Branch locks: ${payload.branchLockCount}`);
  });
}


export { run };
