import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  describeRepoControlAccess,
  ensureRepoControlAccess,
  listDiscoveredRepos,
  loadControlPlaneState,
  setRepoStatus,
} from '../../src/server/control-plane/control-plane-store.js';

test('describing repo control access does not claim exclusive ownership', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-access-view-'));
  const repo = {
    repoId: 'alpha',
    label: 'Alpha',
    exclusiveControl: true,
  } as const;

  const access = describeRepoControlAccess(rootDir, repo, {
    sessionId: 'viewer-1',
    sessionLabel: 'viewer',
  });

  assert.equal(access.canManage, true);
  assert.equal(access.isOwner, false);
  assert.equal(access.owner, null);
  assert.deepEqual(loadControlPlaneState(rootDir).controlOwnership, {});
});

test('exclusive ownership can be claimed, observed as read-only, and taken over deterministically', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-access-claim-'));
  const repo = {
    repoId: 'alpha',
    label: 'Alpha',
    exclusiveControl: true,
    controlTakeover: 'takeover',
  } as const;

  const ownerAccess = ensureRepoControlAccess(rootDir, repo, {
    sessionId: 'session-owner',
    sessionLabel: 'Owner',
  });
  assert.equal(ownerAccess.canManage, true);
  assert.equal(ownerAccess.isOwner, true);
  assert.equal(ownerAccess.owner?.sessionId, 'session-owner');

  const viewerAccess = describeRepoControlAccess(rootDir, repo, {
    sessionId: 'session-viewer',
    sessionLabel: 'Viewer',
  });
  assert.equal(viewerAccess.canManage, false);
  assert.equal(viewerAccess.readOnly, true);
  assert.equal(viewerAccess.refusalReason, 'owned-by-another-session');
  assert.equal(viewerAccess.owner?.sessionId, 'session-owner');

  const takeoverAccess = ensureRepoControlAccess(rootDir, repo, {
    sessionId: 'session-viewer',
    sessionLabel: 'Viewer',
    takeover: true,
  });
  assert.equal(takeoverAccess.canManage, true);
  assert.equal(takeoverAccess.isOwner, true);
  assert.equal(takeoverAccess.owner?.sessionId, 'session-viewer');
  assert.equal(takeoverAccess.owner?.takeoverCount, 1);
});

test('exclusive ownership can refuse takeover attempts', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-access-refuse-'));
  const repo = {
    repoId: 'alpha',
    label: 'Alpha',
    exclusiveControl: true,
    controlTakeover: 'refuse',
  } as const;

  ensureRepoControlAccess(rootDir, repo, {
    sessionId: 'session-owner',
    sessionLabel: 'Owner',
  });
  const access = ensureRepoControlAccess(rootDir, repo, {
    sessionId: 'session-viewer',
    sessionLabel: 'Viewer',
    takeover: true,
  });

  assert.equal(access.canManage, false);
  assert.equal(access.readOnly, true);
  assert.equal(access.refusalReason, 'takeover-refused');
  assert.equal(access.owner?.sessionId, 'session-owner');
});

test('repo status registration preserves exclusive control metadata for later access checks', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-control-access-status-'));
  setRepoStatus(rootDir, 'alpha', {}, {
    repoId: 'alpha',
    label: 'Alpha',
    exclusiveControl: true,
    controlTakeover: 'refuse',
  });

  const [repo] = listDiscoveredRepos(rootDir);
  assert.equal(repo?.exclusiveControl, true);
  assert.equal(repo?.controlTakeover, 'refuse');

  const ownerAccess = ensureRepoControlAccess(rootDir, repo!, {
    sessionId: 'session-owner',
    sessionLabel: 'Owner',
  });
  const viewerAccess = describeRepoControlAccess(rootDir, repo!, {
    sessionId: 'session-viewer',
    sessionLabel: 'Viewer',
  });

  assert.equal(ownerAccess.isOwner, true);
  assert.equal(viewerAccess.readOnly, true);
  assert.equal(viewerAccess.refusalReason, 'takeover-refused');
});
