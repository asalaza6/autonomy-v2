#!/usr/bin/env node

import { fileURLToPath } from 'url';
import { loadAutonomyEnv } from '../../env/env-main.js';
import { publishRunnerFailure } from './persistence.js';
import { requireEnv } from './runner-shared.js';
import { runImplementation as runImplementationFlow } from './task-flow.js';
import { runReview as runReviewFlow } from './gate-flow.js';

async function main() {
  const rootDir = requireEnv('AUTONOMY_ROOT');
  loadAutonomyEnv(rootDir);
  const agentId = requireEnv('AUTONOMY_AGENT_ID');

  if (process.env.AUTONOMY_TASK_ID) {
    await runImplementation({
      rootDir,
      agentId,
      taskId: process.env.AUTONOMY_TASK_ID,
      branch: requireEnv('AUTONOMY_BRANCH'),
      worktreePath: requireEnv('AUTONOMY_WORKTREE'),
    });
    return;
  }

  if (process.env.AUTONOMY_REVIEW_TASK_ID) {
    await runReviewer({
      rootDir,
      agentId,
      reviewTaskId: process.env.AUTONOMY_REVIEW_TASK_ID,
      prId: requireEnv('AUTONOMY_PR_ID'),
      sourceAgentId: process.env.AUTONOMY_SOURCE_AGENT_ID || '',
    });
    return;
  }

  throw new Error(`No supported runner context for agent "${agentId}".`);
}

async function runImplementation(params) {
  return runImplementationFlow(params);
}

async function runReviewer(params) {
  return runReviewFlow(params);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    const summary = publishRunnerFailure(error);
    console.error(`ERROR: ${summary}`);
    process.exit(1);
  });
}

export { main };
