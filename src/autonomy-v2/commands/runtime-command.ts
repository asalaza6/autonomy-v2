import { ensureInitialized, formatCountSummary, printOutput } from './shared-core.js';
import { formatAgentStatusLine } from './shared-agent-status.js';
import { formatPullRequestStatusLine } from './shared-pr-status.js';
import { buildRuntimeSnapshot } from '../control-plane/status-service.js';

function run(rootDir, options) {
  ensureInitialized(rootDir);
  const payload = buildRuntimeSnapshot(rootDir);

  printOutput(options, payload, () => {
    console.log(`Workers: ${Object.keys(payload.workers).length}`);
    payload.agentStatuses.forEach((agentStatus) => {
      console.log(formatAgentStatusLine(agentStatus, { includePid: true }));
    });
    if (payload.pullRequestStatuses.length > 0) {
      console.log('Pull requests awaiting action:');
      payload.pullRequestStatuses.forEach((prStatus) => {
        console.log(formatPullRequestStatusLine(prStatus));
      });
    }
    console.log(`PRDs: ${formatCountSummary(payload.prdCounts) || 'none'}`);
  });
}


export { run };
