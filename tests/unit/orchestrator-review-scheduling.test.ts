import test from 'node:test';
import assert from 'node:assert/strict';

import { AGENT_ROLES } from '../../src/agents/role-catalog.js';
import { findDueAgents } from '../../src/server/orchestrator/orchestrator-runtime-core.js';

test('scheduler does not start reviewer in the same tick as its source implementation agent', () => {
  const config = {
    integrationBranch: 'dev',
    branchPrefixes: {
      task: 'task',
    },
    worktreesRoot: '.worktrees',
    agents: [
      { id: 'builder', role: AGENT_ROLES.IMPLEMENTATION, taskQueue: 'queues/builder.json', checks: ['npm test'] },
      { id: 'gate', role: AGENT_ROLES.REVIEW, taskQueue: 'queues/gate.json' },
    ],
  };
  const queues = {
    builder: {
      agentId: 'builder',
      role: AGENT_ROLES.IMPLEMENTATION,
      tasks: [{ id: 'task-1', status: 'queued', laneKey: 'lane-1', sprintId: 'shared', createdAt: '2026-01-01T00:00:00.000Z' }],
    },
    gate: {
      agentId: 'gate',
      role: AGENT_ROLES.REVIEW,
      tasks: [{ id: 'review-1', status: 'queued', sourceAgentId: 'builder', prId: 'pr-1' }],
    },
  };

  const dueAgents = findDueAgents(
    '/tmp/example',
    config as any,
    queues as any,
    { locks: [] } as any,
    { prds: [] } as any,
    { workers: {} } as any,
  );

  assert.deepEqual(dueAgents, [
    { agentId: 'builder', reason: 'queued_task' },
  ]);
});
