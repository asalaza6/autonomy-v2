import test from 'node:test';
import assert from 'node:assert/strict';

import { h, renderToHtml } from '../../src/server/control-plane/control-plane-jsx-runtime/jsx-runtime.js';
import { VersionStatus } from '../../src/server/control-plane/control-plane-version-view.js';

test('manager version display includes new-version indication for newly created deploy versions', () => {
  const html = renderToHtml(h(VersionStatus, { versionStatus: {
    version: '1.4.45',
    previousVersion: '1.4.44',
    isNew: true,
    detail: 'Created during deploy from 1.4.44',
  } }));

  assert.match(html, /1\.4\.45/);
  assert.match(html, /New version/);
  assert.match(html, /Created during deploy from 1\.4\.44/);
});

test('manager version display omits new-version indication for current versions', () => {
  const html = renderToHtml(h(VersionStatus, { versionStatus: {
    version: '1.4.44',
    isNew: false,
    detail: 'Current version',
  } }));

  assert.match(html, /1\.4\.44/);
  assert.doesNotMatch(html, /New version/);
});
