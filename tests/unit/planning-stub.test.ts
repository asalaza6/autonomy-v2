import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { AGENT_ROLES } from '../../src/agents/role-catalog.js';
import { planPrdTasksWithCodex } from '../../src/codex/planning.js';

test('PM planning stub uses fallback tasks without creating a Codex planning worktree', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-planning-stub-'));
  const previousStub = process.env.AUTONOMY_CODEX_STUB;
  process.env.AUTONOMY_CODEX_STUB = '1';

  try {
    const result = planPrdTasksWithCodex({
      rootDir,
      agent: { id: 'pm-agent', role: AGENT_ROLES.PM },
      config: {
        integrationBranch: 'dev',
        agents: [
          { id: 'pm-agent', role: AGENT_ROLES.PM },
          { id: 'architecture-agent', role: AGENT_ROLES.IMPLEMENTATION },
        ],
      },
      sprint: { sprintId: 'multi-agent-mvp' },
      prd: {
        id: 'prd-stub-planning',
        title: 'Stub planning',
        specification: 'Plan this without Codex.',
        requirements: [],
      },
    });

    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].id, 'prd-stub-planning-architecture-agent-1');
    assert.equal(result.tasks[0].agentId, 'architecture-agent');
    assert.equal(
      fs.existsSync(path.join(rootDir, '.autonomy', 'control', 'pm-agent-plan')),
      false,
    );
  } finally {
    if (typeof previousStub === 'undefined') {
      delete process.env.AUTONOMY_CODEX_STUB;
    } else {
      process.env.AUTONOMY_CODEX_STUB = previousStub;
    }
  }
});
