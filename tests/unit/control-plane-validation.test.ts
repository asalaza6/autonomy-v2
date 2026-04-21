import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertControlPlaneRepoId,
  normalizeControlPlaneConfig,
  normalizeRepoRecord,
  validateAgentChatSubmission,
  validateDeploySubmission,
  validatePrdAddSubmission,
} from '../../src/server/control-plane/control-plane-validation.js';
import { parseRepoRoots } from '../../src/server/control-plane/control-plane-main.js';

test('control plane config normalizes a repo-local identity record', () => {
  const config = normalizeControlPlaneConfig();
  assert.equal(config.repoId, 'default');
  assert.equal(config.label, 'Current workspace');
  assert.equal(config.deploymentUrl, undefined);
});

test('control plane config preserves optional deployment metadata', () => {
  const config = normalizeControlPlaneConfig({
    repoId: 'alpha',
    label: 'Alpha',
    deployCommand: ['git', 'push', 'heroku', 'main'],
    deploymentUrl: ' https://deploy.example.com/app ',
    deploymentLabel: ' Live app ',
  });

  assert.equal(config.repoId, 'alpha');
  assert.deepEqual(config.deployCommand, ['git', 'push', 'heroku', 'main']);
  assert.equal(config.deploymentUrl, 'https://deploy.example.com/app');
  assert.equal(config.deploymentLabel, 'Live app');
});

test('repo record normalization accepts legacy id fields for compatibility', () => {
  const repo = normalizeRepoRecord({
    id: 'alpha',
    label: 'Alpha',
  });

  assert.equal(repo?.repoId, 'alpha');
  assert.equal(repo?.label, 'Alpha');
});

test('prd submission validation enforces discovered repo registration and required fields', () => {
  const repos = [
    {
      repoId: 'alpha',
      label: 'Alpha',
    },
  ];

  assert.throws(() => validatePrdAddSubmission(repos, {
    repoId: 'missing',
    id: 'prd-1',
    title: 'Example',
    specification: 'Spec text',
  }));

  const { payload } = validatePrdAddSubmission(repos, {
    repoId: 'alpha',
    id: 'prd-1',
    title: 'Example',
    requirements: ['First requirement'],
  });

  assert.equal(payload.repoId, 'alpha');
  assert.equal(payload.id, 'prd-1');
  assert.deepEqual(payload.requirements, ['First requirement']);
});

test('prd submission validation autogenerates title and id when omitted', () => {
  const repos = [
    {
      repoId: 'alpha',
      label: 'Alpha',
    },
  ];

  const { payload } = validatePrdAddSubmission(repos, {
    repoId: 'alpha',
    specification: 'Build a better admin dashboard for pool service scheduling and payments',
  });

  assert.equal(payload.title, 'Build a better admin dashboard for pool service scheduling and');
  assert.match(payload.id, /^prd-build-a-better-admin-[a-f0-9]{6}$/);
});

test('deploy submission validation enforces discovered repo registration', () => {
  const repos = [
    {
      repoId: 'alpha',
      label: 'Alpha',
    },
  ];

  assert.throws(() => validateDeploySubmission(repos, {
    repoId: 'missing',
  }));

  const { payload } = validateDeploySubmission(repos, {
    repoId: 'alpha',
  });

  assert.equal(payload.repoId, 'alpha');
});

test('agent chat submission validation enforces discovered repos and message content', () => {
  const repos = [
    {
      repoId: 'alpha',
      label: 'Alpha',
    },
  ];

  assert.throws(() => validateAgentChatSubmission(repos, {
    repoId: 'missing',
    message: 'What is happening?',
  }));
  assert.throws(() => validateAgentChatSubmission(repos, {
    repoId: 'alpha',
    message: '   ',
  }));

  const { payload } = validateAgentChatSubmission(repos, {
    repoId: 'alpha',
    conversationId: 'chat-1',
    message: 'What is happening?',
  });

  assert.equal(payload.repoId, 'alpha');
  assert.equal(payload.conversationId, 'chat-1');
  assert.equal(payload.prompt, 'What is happening?');
});

test('bridge repo map defaults the current working directory when omitted', () => {
  const repoRoots = parseRepoRoots('', '/Users/me/projects/moving-game');
  assert.equal(repoRoots.__path_0, '/Users/me/projects/moving-game');
});

test('bridge repo map accepts raw paths without requiring repo ids', () => {
  const repoRoots = parseRepoRoots('/Users/me/projects/app-one,/Users/me/projects/admin-app');
  assert.equal(repoRoots.__path_0, '/Users/me/projects/app-one');
  assert.equal(repoRoots.__path_1, '/Users/me/projects/admin-app');
});

test('repo-local control plane config requires a repo id before registration', () => {
  assert.throws(() => assertControlPlaneRepoId({}));
  assert.equal(assertControlPlaneRepoId({ repoId: 'alpha' }), 'alpha');
});
