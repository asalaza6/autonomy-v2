import fs from 'fs';
import path from 'path';
import { getAgentDefinition } from '../../agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES } from '../../agents/role-catalog.js';
import { evaluateScope } from '../scope/index.js';
import { createImplementationRunnerExecutionContext } from './agent-context.js';
import { ensureDir, logRunnerEvent, summarizeText, uniqueStrings, useCodexStub } from './shared.js';
import { buildCommitMessage, buildQueueMetadataCommitMessage, finalizeTaskRun, listChangedFiles, markImplementationTaskComplete, readGit, recordImplementationTaskCommitSha, resolveTargetFile, runGit, tryPushBranch } from './workspace.js';
import { buildTaskLaneKey, getAgentConfig, getCompletedLaneTasks, getLaneTasks, getPrForLane, getTask, isPendingImplementationTask, loadState, recordLaneTaskCompletion } from './state.js';
import {
  ensureCheckEnvironment,
  runCheckCommands,
} from './gate-support.js';
import { appendRunnerLog } from './persistence.js';
import { crossLayerRunnerDependencies } from './runner-dependencies.js';

const runnerDependencies = {
  ...crossLayerRunnerDependencies,
  AGENT_ROLES,
  appendRunnerLog,
  buildCommitMessage,
  buildQueueMetadataCommitMessage,
  buildTaskLaneKey,
  ensureCheckEnvironment,
  ensureDir,
  evaluateScope,
  finalizeTaskRun,
  fs,
  getAgentConfig,
  getCompletedLaneTasks,
  getLaneTasks,
  getPrForLane,
  getTask,
  isPendingImplementationTask,
  listChangedFiles,
  loadState,
  logRunnerEvent,
  markImplementationTaskComplete,
  path,
  readGit,
  recordImplementationTaskCommitSha,
  recordLaneTaskCompletion,
  resolveTargetFile,
  runCheckCommands,
  runGit,
  summarizeText,
  tryPushBranch,
  uniqueStrings,
  useCodexStub,
};

async function runImplementationFlow(params, deps) {
  const definition = getAgentDefinition(AGENT_ROLES.IMPLEMENTATION);
  const context = createImplementationRunnerExecutionContext(params, deps);
  return definition.execute(context, {
    kind: 'task',
    agentId: params.agentId,
    reason: 'runner',
    taskId: params.taskId,
    branch: params.branch,
    worktreePath: params.worktreePath,
  });
}

function runImplementation(params) {
  return runImplementationFlow(params, runnerDependencies);
}

export { runImplementation, runImplementationFlow };
