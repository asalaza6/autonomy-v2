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

test('PM definition reports runnable only when a queued PRD exists without active planning work', () => {
  const definition = getAgentDefinition(AGENT_ROLES.PM);
  const queuedContext = buildBaseContext({
    agent: { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
    current: {
      prds: {
        prds: [
          { id: 'prd-1', status: 'queued' },
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
          { id: 'prd-1', status: 'queued' },
          { id: 'prd-2', status: 'planning' },
        ],
      },
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

test('PM definition claims queued PRDs through the injected PRD store', () => {
  const definition = getAgentDefinition(AGENT_ROLES.PM);
  const calls = [];
  const context = buildBaseContext({
    phase: 'worker',
    agent: { id: 'pm-agent', role: AGENT_ROLES.PM, gitIdentity: { name: 'pm', email: 'pm@example.com' } },
    prdStore: {
      loadPrds() {
        return {
          prds: [
            { id: 'prd-1', status: 'queued', createdAt: '2026-01-01T00:00:00.000Z' },
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.status, 'planning');
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
