import test from 'node:test';
import assert from 'node:assert/strict';

import { getAgentDefinition } from '../../src/agents/AgentDefinitionRegistry.js';
import { AGENT_ROLES } from '../../src/agents/role-catalog.js';

function buildBaseContext(overrides = {}) {
  return {
    phase: 'schedule' as const,
    rootDir: '/tmp/example',
    agent: { id: 'agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'a', email: 'a@example.com' } },
    config: {
      integrationBranch: 'dev',
      agents: [
        { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
        { id: 'builder', role: AGENT_ROLES.IMPLEMENTATION, checks: ['npm test'], gitIdentity: { name: 'builder', email: 'builder@example.com' } },
        { id: 'gate', role: AGENT_ROLES.REVIEW, gitIdentity: { name: 'gate', email: 'gate@example.com' } },
      ],
    },
    sprint: { sprintId: 'shared' },
    options: {},
    current: {},
    queueStore: {},
    prdStore: {},
    prStore: {},
    branchLockStore: {},
    runtimeStore: {},
    scm: {},
    reviewClient: {},
    codex: {},
    scopeEvaluator: {},
    clock: { now: () => '2026-01-01T00:00:00.000Z' },
    logger: {},
    ...overrides,
  };
}

test('PM definition reports runnable only when a queued PRD exists without active planned work', () => {
  const definition = getAgentDefinition(AGENT_ROLES.PM);
  const queuedContext = buildBaseContext({
    agent: { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
    current: {
      prds: {
        prds: [
          { id: 'prd-1', status: 'queued', isQueued: false },
        ],
      },
    },
    prdStore: {
      listPrds(prdsState) {
        return prdsState.prds;
      },
    },
  });
  const blockedContext = buildBaseContext({
    agent: { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
    current: {
      prds: {
        prds: [
          { id: 'prd-1', status: 'queued', isQueued: false },
          { id: 'prd-2', status: 'planned', plannedTaskIds: ['task-2'], isQueued: false },
        ],
      },
      queues: {
        builder: { agentId: 'builder', role: AGENT_ROLES.IMPLEMENTATION, tasks: [{ id: 'task-2', status: 'queued' }] },
      },
      branchLocks: { locks: [] },
    },
    prdStore: {
      listPrds(prdsState) {
        return prdsState.prds;
      },
    },
  });

  assert.equal(definition.canRun(queuedContext), true);
  assert.equal(definition.canRun(blockedContext), false);
});

test('PM definition does not persist planning state when claiming queued PRDs', () => {
  const definition = getAgentDefinition(AGENT_ROLES.PM);
  const calls = [];
  const context = buildBaseContext({
    phase: 'worker',
    agent: { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
    prdStore: {
      loadPrds() {
        return {
          prds: [
            { id: 'prd-1', status: 'queued', isQueued: false, createdAt: '2026-01-01T00:00:00.000Z' },
          ],
        };
      },
      listPrds(prdsState) {
        return prdsState.prds;
      },
      commitPrdState(payload, options) {
        calls.push({ payload, options });
      },
    },
  });

  const work = definition.claimWork(context);
  assert.equal(work.kind, 'prd');
  assert.equal(work.prd.id, 'prd-1');
  assert.equal(calls.length, 0);
});

test('PM definition blocks queued PRDs while an unarchived active PRD still exists', () => {
  const definition = getAgentDefinition(AGENT_ROLES.PM);
  const context = buildBaseContext({
    agent: { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
    current: {
      prds: {
        prds: [
          { id: 'prd-active', status: 'completed', plannedTaskIds: [], isQueued: false },
          { id: 'prd-queued', status: 'queued', isQueued: true },
        ],
      },
      queues: {},
      branchLocks: { locks: [] },
    },
    prdStore: {
      listPrds(prdsState) {
        return prdsState.prds;
      },
    },
  });

  assert.equal(definition.canRun(context), false);
});

test('PM definition persists spec, queue updates, and planned state in one tracked-files commit', () => {
  const definition = getAgentDefinition(AGENT_ROLES.PM);
  const trackedCommits = [];
  const stateCommits = [];
  const context = buildBaseContext({
    phase: 'worker',
    agent: { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
    config: {
      integrationBranch: 'dev',
      agents: [
        { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
        { id: 'builder', role: AGENT_ROLES.IMPLEMENTATION, taskQueue: 'queues/builder.json', checks: ['npm test'], gitIdentity: { name: 'builder', email: 'builder@example.com' } },
      ],
    },
    queueStore: {
      loadQueues() {
        return {};
      },
      buildQueueState(agent, tasks = []) {
        return { agentId: agent.id, role: agent.role, tasks };
      },
      listTasks(queue) {
        return queue.tasks || [];
      },
    },
    prdStore: {
      readTrackedPrdStateMap() {
        return new Map();
      },
      commitTrackedFiles(updates, options) {
        trackedCommits.push({ updates, options });
      },
      commitPrdState(payload, options) {
        stateCommits.push({ payload, options });
      },
    },
    codex: {
      useStub() {
        return false;
      },
      planPrdTasks() {
        return {
          tasks: [
            {
              id: 'task-1',
              title: 'Implement feature',
              agentId: 'builder',
              acceptance: ['works'],
            },
          ],
        };
      },
    },
  });

  const result = definition.execute(context, {
    kind: 'prd',
    agentId: 'pm-agent',
    reason: 'queued_prd',
    prd: {
      id: 'prd-1',
      title: 'PRD 1',
      status: 'queued',
      isQueued: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      specification: 'Build it',
      requirements: ['Do the thing'],
    },
  });

  if (result instanceof Promise) {
    assert.fail('PM execute should return synchronously in worker mode.');
  }
  assert.equal(result.status, 'planned');
  assert.equal(trackedCommits.length, 1);
  assert.equal(stateCommits.length, 0);
  assert.equal(trackedCommits[0].options.commitMessage, 'autonomy(queue): enqueue plan prd-1');
  assert.equal(trackedCommits[0].updates.some((entry) => entry.relativePath === 'prompts/autonomous/v2/specs/prds/prd-1.json'), true);
  assert.equal(trackedCommits[0].updates.some((entry) => entry.relativePath === 'prompts/autonomous/v2/state/prds/prd-1.json'), true);
  assert.equal(trackedCommits[0].updates.some((entry) => entry.relativePath === 'queues/builder.json'), true);
});

test('implementation definition uses queue context plus dispatch predicate for scheduling', () => {
  const definition = getAgentDefinition(AGENT_ROLES.IMPLEMENTATION);
  const context = buildBaseContext({
    agent: { id: 'builder', role: AGENT_ROLES.IMPLEMENTATION, gitIdentity: { name: 'builder', email: 'builder@example.com' } },
    current: {
      queues: {
        builder: { agentId: 'builder', role: AGENT_ROLES.IMPLEMENTATION, tasks: [{ id: 't-1', status: 'queued' }] },
      },
      branchLocks: { locks: [] },
    },
    queueStore: {
      resolveImplementationQueueContext(_agent, queue) {
        return { queue };
      },
      listTasks(queue) {
        return queue.tasks || [];
      },
      implementationTaskNeedsDispatch(task) {
        return task.status === 'queued';
      },
    },
  });

  assert.equal(definition.canRun(context), true);
  assert.equal(definition.canRun({ ...context, options: { suppressNonPmDispatch: true } }), false);
});

test('review definition reports runnable when a queued review task exists', () => {
  const definition = getAgentDefinition(AGENT_ROLES.REVIEW);
  const context = buildBaseContext({
    agent: { id: 'gate', role: AGENT_ROLES.REVIEW, gitIdentity: { name: 'gate', email: 'gate@example.com' } },
    current: {
      queues: {
        gate: { agentId: 'gate', role: AGENT_ROLES.REVIEW, tasks: [{ id: 'review-1', status: 'queued' }] },
      },
    },
    queueStore: {
      listTasks(queue) {
        return queue.tasks || [];
      },
    },
  });

  assert.equal(definition.canRun(context), true);
});

test('review definition waits for the source implementation agent to finish before running', () => {
  const definition = getAgentDefinition(AGENT_ROLES.REVIEW);
  const baseContext = buildBaseContext({
    agent: { id: 'gate', role: AGENT_ROLES.REVIEW, gitIdentity: { name: 'gate', email: 'gate@example.com' } },
    current: {
      queues: {
        gate: {
          agentId: 'gate',
          role: AGENT_ROLES.REVIEW,
          tasks: [{ id: 'review-1', status: 'queued', sourceAgentId: 'builder' }],
        },
      },
      runtime: {
        workers: {
          builder: { agentId: 'builder', status: 'running' },
        },
      },
    },
    queueStore: {
      listTasks(queue) {
        return queue.tasks || [];
      },
    },
  });

  assert.equal(definition.canRun(baseContext), false);
  assert.equal(definition.canRun({
    ...baseContext,
    current: {
      ...baseContext.current,
      runtime: {
        workers: {
          builder: { agentId: 'builder', status: 'idle' },
        },
      },
    },
  }), true);
});
