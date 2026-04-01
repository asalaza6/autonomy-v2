import {
  ensureInitialized,
  getAutonomyPaths,
  getStringOption,
  printOutput,
  readJson,
} from './shared-core.js';
import { archiveCompletedPrdSpecs, loadAllState, loadTrackedPrds, } from './shared-prds.js';
import { syncIntegrationSpecs } from './shared-sync.js';
import { executePrdAdd, } from '../control-plane/prd-service.js';
import { validateAutonomyConfig } from './command-dependencies.js';

function run(rootDir, options, command) {
  if (command === 'prd:add') {
    return handlePrdAdd(rootDir, options);
  }
  if (command === 'prd:list') {
    return handlePrdList(rootDir, options);
  }
  return handleArchiveCompletedPrds(rootDir, options);
}

function handlePrdAdd(rootDir, options) {
  ensureInitialized(rootDir);
  const result = executePrdAdd(rootDir, options);

  printOutput(options, {
    ...result.prdSpec,
    integrationBranch: result.integrationBranch,
    commit: result.commit,
    queueCommit: result.queueCommit,
  }, () => {
    console.log(`Committed PRD spec ${result.prdSpec.id} to ${result.integrationBranch}`);
    console.log(`Spec: ${result.commit.specPath}`);
    if (result.commit.commitSha) {
      console.log(`Commit: ${result.commit.commitSha}`);
    }
    if (result.commit.pushMessage) {
      console.log(result.commit.pushMessage);
    }
  });
}

function handlePrdList(rootDir, options) {
  ensureInitialized(rootDir);
  syncIntegrationSpecs(rootDir, options);
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  const prds = loadTrackedPrds(rootDir, config, {
    prs: readJson(paths.prsState),
  });
  const statusFilter = getStringOption(options, 'status', '');
  const filtered = prds.prds.filter((prd) => !statusFilter || prd.status === statusFilter);

  printOutput(options, filtered, () => {
    if (filtered.length === 0) {
      console.log('No PRDs found.');
      return;
    }
    filtered.forEach((prd) => {
      console.log(`${prd.id} | ${prd.status} | planned=${(prd.plannedTaskIds || []).length} | ${prd.title}`);
    });
  });
}

function handleArchiveCompletedPrds(rootDir, options) {
  ensureInitialized(rootDir);
  const state = loadAllState(rootDir);
  const prds = loadTrackedPrds(rootDir, state.config, {
    taskQueues: state.taskQueues,
    prs: state.prs,
  });
  const archived = archiveCompletedPrdSpecs(rootDir, {
    config: state.config,
    taskQueues: state.taskQueues,
    prs: state.prs,
    prds,
  });

  printOutput(options, { archived }, () => {
    if (archived.length === 0) {
      console.log('No completed PRD specs were archived.');
      return;
    }
    console.log(`Archived ${archived.length} completed PRD spec${archived.length === 1 ? '' : 's'}:`);
    archived.forEach((entry) => {
      console.log(`- ${entry.id} | ${entry.from} -> ${entry.to}`);
    });
  });
}


export { run };
