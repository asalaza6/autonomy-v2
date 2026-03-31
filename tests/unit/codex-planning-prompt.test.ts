import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPlanningPrompt,
} from '../../src/codex/planning.js';

test('buildPlanningPrompt includes the PRD and lane context', () => {
  const prompt = buildPlanningPrompt({
    rootDir: '/tmp/example',
    agentSystemPromptPath: '',
    laneLabel: 'implementation',
    implementationAgents: [
      {
        id: 'builder',
        personaName: 'builder',
        include: [],
        exclude: [],
      },
    ],
    prd: {
      id: 'prd-1',
      title: 'Example PRD',
      specification: 'Build it',
      requirements: ['Do the thing'],
      tasks: [],
    },
    sprintId: 'shared',
    worktreePath: '/tmp/example/.autonomy/control/pm-plan/prd-1',
    specRelativePath: 'prompts/autonomous/v2/specs/prds/prd-1.json',
  });

  assert.match(prompt, /Available implementation lanes:/);
  assert.match(prompt, /"id": "builder"/);
  assert.match(prompt, /"id": "prd-1"/);
  assert.match(prompt, /No structured response is required\./);
  assert.match(prompt, /Target file: .*prd-1\.json/);
  assert.match(prompt, /Return nothing\./);
});
