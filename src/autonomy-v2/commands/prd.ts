import { appendAgentLog, ensureInitialized, getAutonomyPaths, getAgent, getListOption, getStringOption, printOutput, readJson, requireOption, } from './shared-core.js';
import { archiveCompletedPrdSpecs, buildTrackedImplementationQueueUpdates, loadAllState, loadTrackedPrds, sanitizePlannedTaskSpecs, } from './shared-prds.js';
import { syncIntegrationSpecs } from './shared-sync.js';
import {
  AGENT_ROLES,
  buildPrdSpecPayload,
  commitPrdSpecToIntegrationBranch,
  commitTrackedFilesToIntegrationBranch,
  getRoleLabel,
  hasActivePrdSpecInIntegrationBranch,
  hasPrdSpecInIntegrationBranch,
  validateAutonomyConfig,
} from './command-dependencies.js';

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
  const paths = getAutonomyPaths(rootDir);
  const config = readJson(paths.agentsConfig);
  const id = requireOption(options, 'id');
  const title = requireOption(options, 'title');
  const trackedPrds = loadTrackedPrds(rootDir, config, {
    prs: readJson(paths.prsState),
  });
  const hasActivePrd = (trackedPrds.prds || []).some((prd) => ['planning', 'planned', 'queued'].includes(
    String((prd && prd.status) || '')
  ));
  const hasActiveIntegrationPrdSpec = hasActivePrdSpecInIntegrationBranch(rootDir, config.integrationBranch);
  const hasExistingPrdSpec = hasPrdSpecInIntegrationBranch(rootDir, config.integrationBranch, id);

  const now = new Date().toISOString();
  const specification = getStringOption(options, 'specification', '');
  const requirements = getListOption(options, 'requirement');
  const rawTaskSpecs = Object.prototype.hasOwnProperty.call(options, 'task-spec')
    ? (Array.isArray(options['task-spec']) ? options['task-spec'] : [options['task-spec']])
    : [];
  const taskSpecs = rawTaskSpecs.map((entry, index) => {
    try {
      const parsed = JSON.parse(String(entry));
      if (!parsed.id || !parsed.title || !parsed.agentId) {
        throw new Error('task-spec must include id, title, and agentId');
      }
      return parsed;
    } catch (error) {
      throw new Error(`Invalid --task-spec at index ${index}: ${error.message}`);
    }
  });
  if (taskSpecs.length === 0 && !specification && requirements.length === 0) {
    throw new Error('Provide at least one --task-spec or a --specification/--requirement input for PM planning.');
  }
  if (taskSpecs.length > 0 && (hasActivePrd || hasActiveIntegrationPrdSpec || hasExistingPrdSpec)) {
    throw new Error(`Cannot enqueue ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} task specs while the PRD spec would be queued instead of active on the integration branch.`);
  }

  const prdSpec = buildPrdSpecPayload({
    id,
    title,
    createdAt: now,
    specification,
    requirements,
  });
  const pmAgent = getAgent(config, `${AGENT_ROLES.PM}-agent`);
  const commitResult = commitPrdSpecToIntegrationBranch(rootDir, config.integrationBranch, prdSpec, {
    commitMessage: `autonomy(prd): upsert ${id}`,
    gitIdentity: pmAgent.gitIdentity,
    queueSpec: hasActivePrd || hasActiveIntegrationPrdSpec || hasExistingPrdSpec,
  });
  let queueCommitResult = null;
  if (taskSpecs.length > 0) {
    queueCommitResult = commitTrackedFilesToIntegrationBranch(
      rootDir,
      config.integrationBranch,
      buildTrackedImplementationQueueUpdates(
        rootDir,
        config,
        sanitizePlannedTaskSpecs(taskSpecs),
        {
          prd: {
            id,
            title,
            createdAt: now,
            sprintId: getStringOption(options, 'sprint-id', ''),
          },
          sprint: readJson(paths.sprintConfig),
          source: 'manual',
        }
      ),
      {
        commitMessage: `autonomy(queue): enqueue ${id}`,
        gitIdentity: pmAgent.gitIdentity,
      }
    );
  }
  appendAgentLog(rootDir, config, pmAgent.id, 'prd:committed', {
    input: {
      prdId: id,
      taskCount: taskSpecs.length,
      integrationBranch: config.integrationBranch,
    },
    output: {
      committed: commitResult.committed,
      pushed: commitResult.pushed,
      commitSha: commitResult.commitSha,
      specPath: commitResult.specPath,
      queueCommitSha: queueCommitResult ? queueCommitResult.commitSha : null,
      queuePaths: queueCommitResult ? queueCommitResult.paths : [],
      pushMessage: commitResult.pushMessage || null,
    },
  });

  printOutput(options, {
    ...prdSpec,
    integrationBranch: config.integrationBranch,
    commit: commitResult,
    queueCommit: queueCommitResult,
  }, () => {
    console.log(`Committed PRD spec ${id} to ${config.integrationBranch}`);
    console.log(`Spec: ${commitResult.specPath}`);
    if (commitResult.commitSha) {
      console.log(`Commit: ${commitResult.commitSha}`);
    }
    if (commitResult.pushMessage) {
      console.log(commitResult.pushMessage);
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
