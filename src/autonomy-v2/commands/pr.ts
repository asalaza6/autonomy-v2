import { appendAgentLog, ensureInitialized, getAgent, getAutonomyPaths, getListOption, getStringOption, printOutput, requireOption, writeJson, } from './shared-core.js';
import { addIssueLabels, createOrFindPullRequest, resolveGithubRepo } from './shared-github.js';
import { buildLaneSourceSummary, buildTaskLaneKey, collectTaskScopeViolations, findPullRequestByLane, uniqueScopeViolations, uniqueStrings } from './shared-repo.js';
import { buildPersonaPrBody, buildPersonaPrTitle, buildPullRequestLabels } from './shared-core.js';
import { buildStablePullRequestId } from './shared-repo.js';
import { listCompletedLaneTasks, listImplementationLaneTasks, listLaneTasks } from './shared-lanes.js';
import { loadAllState } from './shared-prds.js';
import { queueReviewerTask } from './shared-worktrees.js';
import { resolvePrRecordTask } from './shared-lanes.js';
import { writeTaskQueues } from './shared-queues.js';
import { collectCurrentReviewerBlockers } from './shared-review-blockers.js';
import {
  getAgentConversationId,
  setAgentConversationReference,
} from '../../agents/conversation-references.js';
import {
  AGENT_ROLES,
  TASK_TYPES,
  buildRoleEventName,
  isImplementationRole,
  resolveGithubAuthToken,
} from './command-dependencies.js';

async function run(rootDir, options) {
  ensureInitialized(rootDir);
  const state = loadAllState(rootDir);
  const task = resolvePrRecordTask(rootDir, state, requireOption(options, 'task'));
  const agent = getAgent(state.config, task.agentId);
  if (!isImplementationRole(agent.role) && agent.role !== TASK_TYPES.CONFLICT) {
    throw new Error(`Agent "${agent.id}" cannot publish pull requests.`);
  }
  const headBranch = requireOption(options, 'head-branch');
  const baseBranch = getStringOption(options, 'base-branch', task.baseBranch || state.config.integrationBranch);
  if ((state.config.blockedBranches || []).includes(baseBranch) || baseBranch !== state.config.integrationBranch) {
    throw new Error(`PR base branch must be ${state.config.integrationBranch}; received ${baseBranch}.`);
  }

  const laneKey = task.laneKey || buildTaskLaneKey(task);
  const explicitCompletedTaskIds = uniqueStrings(getListOption(options, 'completed-task'));
  const completedLaneTasks = listCompletedLaneTasks(state.branchLocks, task.agentId, laneKey);
  const completedTaskIds = uniqueStrings([
    ...(explicitCompletedTaskIds.length > 0 ? explicitCompletedTaskIds : [task.id]),
    ...completedLaneTasks.map((candidate) => candidate.id),
  ]);
  const laneScopeViolations = uniqueScopeViolations(completedLaneTasks.flatMap((candidate) => {
    return collectTaskScopeViolations(candidate);
  }));
  const laneTasks = isImplementationRole(agent.role)
    ? listImplementationLaneTasks(rootDir, state, task.agentId, laneKey, { task }).tasks
    : listLaneTasks(state.taskQueues, task.agentId, laneKey);
  const pendingLaneTasks = laneTasks
    .filter((candidate) => !completedTaskIds.includes(candidate.id));
  const currentReviewerBlockers = collectCurrentReviewerBlockers(
    null,
    completedLaneTasks.concat([task]).concat(pendingLaneTasks)
  );
  let record = findPullRequestByLane(state.prs, task);
  const now = new Date().toISOString();
  if (!record) {
    const defaultSource = buildLaneSourceSummary(task, completedLaneTasks, pendingLaneTasks);
    record = {
      id: buildStablePullRequestId(laneKey),
      taskId: task.id,
      laneKey,
      prdId: task.prdId || null,
      sprintId: task.sprintId || null,
      agentId: task.agentId,
      sourceTitle: getStringOption(options, 'title', defaultSource.title),
      sourceBody: getStringOption(options, 'body', defaultSource.body),
      taskIds: uniqueStrings([
        ...completedLaneTasks.map((candidate) => candidate.id),
        task.id,
        ...pendingLaneTasks.map((candidate) => candidate.id),
        ...completedTaskIds,
      ]),
      completedTaskIds: completedTaskIds.slice(),
      pendingTaskIds: pendingLaneTasks.map((candidate) => candidate.id),
      checks: uniqueStrings([
        ...completedLaneTasks.flatMap((candidate) => candidate.checks || []),
        ...(task.checks || []),
        ...pendingLaneTasks.flatMap((candidate) => candidate.checks || []),
      ]),
      acceptance: uniqueStrings([
        ...completedLaneTasks.flatMap((candidate) => candidate.acceptance || []),
        ...(task.acceptance || []),
        ...pendingLaneTasks.flatMap((candidate) => candidate.acceptance || []),
      ]),
      scopeViolations: laneScopeViolations.slice(),
      reviewerBlockers: currentReviewerBlockers,
      headBranch,
      baseBranch,
      status: pendingLaneTasks.length === 0 ? 'open' : 'building',
      reviews: [],
      createdAt: now,
      updatedAt: now,
      remote: null,
    };
    state.prs.pullRequests.push(record);
  } else {
    record.sourceTitle = getStringOption(options, 'title', record.sourceTitle || task.title);
    record.sourceBody = getStringOption(options, 'body', record.sourceBody || task.description || '');
    record.taskId = task.id;
    record.laneKey = laneKey;
    record.prdId = task.prdId || record.prdId || null;
    record.sprintId = task.sprintId || record.sprintId || null;
    record.taskIds = uniqueStrings([
      ...completedLaneTasks.map((candidate) => candidate.id),
      ...(record.taskIds || []),
      task.id,
      ...pendingLaneTasks.map((candidate) => candidate.id),
      ...completedTaskIds,
    ]);
    record.completedTaskIds = uniqueStrings([
      ...(record.completedTaskIds || []),
      ...completedTaskIds,
    ]);
    record.pendingTaskIds = pendingLaneTasks.map((candidate) => candidate.id);
    record.checks = uniqueStrings([
      ...completedLaneTasks.flatMap((candidate) => candidate.checks || []),
      ...(record.checks || []),
      ...(task.checks || []),
      ...pendingLaneTasks.flatMap((candidate) => candidate.checks || []),
    ]);
    record.acceptance = uniqueStrings([
      ...completedLaneTasks.flatMap((candidate) => candidate.acceptance || []),
      ...(record.acceptance || []),
      ...(task.acceptance || []),
      ...pendingLaneTasks.flatMap((candidate) => candidate.acceptance || []),
    ]);
    record.scopeViolations = uniqueScopeViolations([
      ...(record.scopeViolations || []),
      ...laneScopeViolations,
    ]);
    record.reviewerBlockers = currentReviewerBlockers;
    record.headBranch = headBranch;
    record.baseBranch = baseBranch;
    record.status = pendingLaneTasks.length === 0 ? 'open' : 'building';
    record.updatedAt = now;
    delete record.conflict;
  }

  record.title = buildPersonaPrTitle(agent, record.sourceTitle);
  record.body = buildPersonaPrBody(agent, task, state.sprint, record.sourceBody);
  const implementationConversationId = [
    task,
    ...completedLaneTasks,
  ].map((candidate) => getAgentConversationId(candidate, {
    agentId: task.agentId,
    role: AGENT_ROLES.IMPLEMENTATION,
  })).find(Boolean) || '';
  if (implementationConversationId) {
    setAgentConversationReference(record, {
      agentId: task.agentId,
      role: AGENT_ROLES.IMPLEMENTATION,
    }, implementationConversationId, now);
  }

  if (options.publish === true && (!record.remote || !record.remote.number)) {
    const repo = resolveGithubRepo(rootDir);
    const token = resolveGithubAuthToken({ required: true });
    const published = await createOrFindPullRequest(repo, token, {
      title: record.title,
      body: record.body,
      head: headBranch,
      base: baseBranch,
      draft: options.draft === true,
    });
    record.remote = {
      number: published.number,
      url: published.html_url,
    };
    const labels = buildPullRequestLabels(agent, baseBranch);
    if (labels.length > 0) {
      await addIssueLabels(repo, token, published.number, labels);
      record.labels = labels;
    }
  } else if (record.remote && record.remote.number && !record.labels) {
    const labels = buildPullRequestLabels(agent, baseBranch);
    if (labels.length > 0) {
      record.labels = labels;
    }
  }

  let reviewerTask = null;
  if (pendingLaneTasks.length === 0) {
    reviewerTask = queueReviewerTask(state.taskQueues, state.config, record, task, now);
  }
  const paths = getAutonomyPaths(rootDir);
  writeJson(paths.prsState, state.prs);
  writeTaskQueues(rootDir, state.config, state.taskQueues);
  appendAgentLog(rootDir, state.config, task.agentId, 'pr:record', {
    input: {
      taskId: task.id,
      laneKey,
      headBranch,
      baseBranch,
      completedTaskIds,
    },
    output: {
      prId: record.id,
      status: record.status,
      remote: record.remote,
      pendingTaskIds: record.pendingTaskIds,
      scopeViolations: record.scopeViolations || [],
    },
  });
  if (reviewerTask) {
    appendAgentLog(rootDir, state.config, reviewerTask.agentId, buildRoleEventName(AGENT_ROLES.REVIEW, 'queued'), {
      input: {
        prId: record.id,
        sourceTaskId: task.id,
        sourceAgentId: task.agentId,
      },
      output: {
        reviewerTaskId: reviewerTask.id,
        reviewRound: reviewerTask.reviewRound,
        status: reviewerTask.status,
      },
    });
  }

  printOutput(options, record, () => {
    console.log(`Recorded PR ${record.id} for task ${task.id}`);
    if (record.remote) {
      console.log(`Remote PR #${record.remote.number}: ${record.remote.url}`);
    }
  });
}


export { run };
