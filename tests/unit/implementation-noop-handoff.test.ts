import test from 'node:test';
import assert from 'node:assert/strict';

import { getAgentDefinition } from '../../src/agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES } from '../../src/agents/role-catalog.js';

test('implementation runner noop still records lane completion and advances PR handoff', async () => {
  const definition = getAgentDefinition(AGENT_ROLES.IMPLEMENTATION);
  const recordedCompletions: any[] = [];
  const finalizedRuns: any[] = [];

  const context: any = {
    phase: 'runner',
    rootDir: '/tmp/example',
    agent: {
      id: 'architecture-agent',
      role: AGENT_ROLES.IMPLEMENTATION,
      checks: ['npm test'],
      gitIdentity: { name: 'builder', email: 'builder@example.com' },
    },
    config: {
      integrationBranch: 'dev',
      agents: [
        {
          id: 'architecture-agent',
          role: AGENT_ROLES.IMPLEMENTATION,
          checks: ['npm test'],
          gitIdentity: { name: 'builder', email: 'builder@example.com' },
        },
      ],
    },
    current: {
      queues: {},
    },
    runtimeStore: {
      loadState() {
        return {
          config: context.config,
          queues: {},
        };
      },
    },
    queueStore: {
      getTask() {
        return {
          id: 'task-1',
          title: 'Task 1',
          agentId: 'architecture-agent',
          prdId: 'prd-1',
          sprintId: 'shared',
          checks: ['npm test'],
          acceptance: ['done'],
        };
      },
      buildTaskLaneKey() {
        return 'prd-1:architecture-agent';
      },
      getLaneTasks() {
        return [
          {
            id: 'task-1',
            title: 'Task 1',
            agentId: 'architecture-agent',
            prdId: 'prd-1',
            sprintId: 'shared',
            checks: ['npm test'],
            acceptance: ['done'],
          },
        ];
      },
      isPendingImplementationTask() {
        return false;
      },
      markImplementationTaskComplete() {
        return {
          queuePath: '/tmp/example/prompts/autonomous/v2/queues/architecture-agent.json',
          relativePath: 'prompts/autonomous/v2/queues/architecture-agent.json',
        };
      },
    },
    prStore: {
      getPrForLane() {
        return null;
      },
      finalizeTaskRun(payload: any) {
        finalizedRuns.push(payload);
      },
    },
    branchLockStore: {
      getCompletedLaneTasks() {
        return [];
      },
      recordLaneTaskCompletion(task: any) {
        recordedCompletions.push(task.id);
        return [{ id: task.id }];
      },
    },
    logger: {
      logRunnerEvent() {},
      appendRunnerLog() {},
    },
    codex: {
      useStub() {
        return false;
      },
      async executeTask() {
        return { status: 'noop' };
      },
    },
    scm: {
      ensureCheckEnvironment() {},
      listChangedFiles() {
        return [];
      },
      runCheckCommands() {
        return [];
      },
      buildCommitMessage() {
        return 'auto(architecture-agent): draft task-1';
      },
      runGit() {},
      hasStagedGitChanges() {
        return false;
      },
    },
    scopeEvaluator: {
      evaluate() {
        return { ok: true, violations: [] };
      },
    },
    reviewClient: {
      hasGithubAuth() {
        return false;
      },
    },
  };

  const result: any = await definition.execute(context, {
    kind: 'task',
    agentId: 'architecture-agent',
    reason: 'runner',
    taskId: 'task-1',
    branch: 'agent/shared/architecture-agent/prd-1-architecture-agent',
    worktreePath: '/tmp/example/.autonomy/worktrees/architecture-agent/shared-prd-1-architecture-agent',
  });

  assert.equal(result.status, 'noop');
  assert.equal(result.reason, 'no_staged_changes');
  assert.deepEqual(recordedCompletions, ['task-1']);
  assert.equal(finalizedRuns.length, 1);
  assert.equal(finalizedRuns[0].shouldRecordPr, true);
  assert.equal(finalizedRuns[0].publish, false);
  assert.deepEqual(finalizedRuns[0].completedTaskIds, ['task-1']);
});
