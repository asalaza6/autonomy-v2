import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildServiceConnectionSummaries,
  createProviderDeployExecution,
  verifyServiceConnection,
} from '../../src/autonomy-v2/control-plane/service-auth.js';

test('service auth verifies a connection from dynamic env aliases without exposing raw secrets', () => {
  const repoDir = createServiceAuthRepo({
    serviceProviders: [
      {
        providerId: 'netlify-like',
        label: 'Netlify-like',
        authStrategies: ['manual-token'],
        authFields: [
          { field: 'apiToken', label: 'API token', required: true, secret: true },
          { field: 'siteId', label: 'Site ID', required: true, secret: false },
        ],
        verifyCommand: {
          command: {
            command: process.execPath,
            args: [
              '-e',
              'if (process.env.NETLIFY_TOKEN === "valid-token" && process.env.NETLIFY_SITE_ID === "site-123") { console.log(JSON.stringify({ ok: true, accountMetadata: { team: "Core", site: "Marketing" }, capabilityMetadata: { region: "us-west" } })); process.exit(0); } process.exit(1);',
            ],
            env: {
              NETLIFY_TOKEN: '{{apiToken}}',
              NETLIFY_SITE_ID: '{{siteId}}',
            },
          },
        },
        deployCommand: {
          command: {
            command: process.execPath,
            args: ['-e', 'console.log(process.env.NETLIFY_TOKEN); console.log(process.env.NETLIFY_SITE_ID);'],
            env: {
              NETLIFY_TOKEN: '{{apiToken}}',
              NETLIFY_SITE_ID: '{{siteId}}',
            },
          },
        },
      },
    ],
    serviceConnections: [
      {
        providerId: 'netlify-like',
        connectionId: 'primary',
        label: 'Primary site',
        authStrategy: 'manual-token',
        envAliases: {
          apiToken: 'NETLIFY_TOKEN_SECRET',
          siteId: 'NETLIFY_SITE_ID_SECRET',
        },
      },
    ],
    providerDeploy: {
      providerId: 'netlify-like',
      connectionId: 'primary',
    },
  });
  fs.writeFileSync(path.join(repoDir, '.env.autonomy.local'), 'NETLIFY_TOKEN_SECRET=valid-token\nNETLIFY_SITE_ID_SECRET=site-123\n', 'utf8');

  const summary = verifyServiceConnection(repoDir, {
    providerId: 'netlify-like',
    connectionId: 'primary',
  });

  assert.equal(summary.status, 'connected');
  assert.equal(summary.failureClass, null);
  assert.equal(summary.accountMetadata?.team, 'Core');
  assert.equal(summary.accountMetadata?.site, 'Marketing');
  assert.equal(summary.fieldStatuses?.every((field) => field.resolved === true), true);
  assert.equal(JSON.stringify(summary).includes('valid-token'), false);

  const deployExecution = createProviderDeployExecution(repoDir, {
    providerId: 'netlify-like',
    connectionId: 'primary',
  });

  assert.equal(Boolean(deployExecution), true);
  assert.equal((deployExecution?.deployCommand as any).env.NETLIFY_TOKEN, 'valid-token');
  assert.deepEqual(deployExecution?.redactions, ['valid-token', 'site-123']);
});

test('service auth summaries classify missing aliases and unresolved env values safely', () => {
  const repoDir = createServiceAuthRepo({
    serviceProviders: [
      {
        providerId: 'heroku-like',
        authFields: [
          { field: 'apiToken', required: true, secret: true },
          { field: 'appName', required: true, secret: false },
        ],
      },
    ],
    serviceConnections: [
      {
        providerId: 'heroku-like',
        connectionId: 'missing-alias',
        authStrategy: 'manual-token',
        envAliases: {
          apiToken: 'HEROKU_TOKEN',
        },
      },
      {
        providerId: 'heroku-like',
        connectionId: 'missing-value',
        authStrategy: 'manual-token',
        envAliases: {
          apiToken: 'HEROKU_TOKEN',
          appName: 'HEROKU_APP',
        },
      },
    ],
  });
  fs.writeFileSync(path.join(repoDir, '.env.autonomy.local'), 'HEROKU_TOKEN=token-only\n', 'utf8');

  const summaries = buildServiceConnectionSummaries(repoDir);
  const missingAlias = summaries.find((entry) => entry.connectionId === 'missing-alias');
  const missingValue = summaries.find((entry) => entry.connectionId === 'missing-value');

  assert.equal(missingAlias?.status, 'needs-reconnect');
  assert.equal(missingAlias?.failureClass, 'missing-env-alias');
  assert.equal(missingValue?.status, 'needs-reconnect');
  assert.equal(missingValue?.failureClass, 'unresolved-secret-field');
});

test('service auth verification classifies invalid credentials and insufficient scopes', () => {
  const repoDir = createServiceAuthRepo({
    serviceProviders: [
      {
        providerId: 'scoped-provider',
        authFields: [
          { field: 'apiToken', required: true, secret: true },
        ],
        verifyCommand: {
          command: {
            command: process.execPath,
            args: [
              '-e',
              'if (process.env.SCOPED_TOKEN === "scope-problem") { console.log(JSON.stringify({ ok: false, failureClass: "insufficient-scopes", status: "insufficient-scopes" })); process.exit(1); } process.exit(1);',
            ],
            env: {
              SCOPED_TOKEN: '{{apiToken}}',
            },
          },
        },
      },
    ],
    serviceConnections: [
      {
        providerId: 'scoped-provider',
        connectionId: 'bad-token',
        authStrategy: 'manual-token',
        envAliases: {
          apiToken: 'BAD_PROVIDER_TOKEN',
        },
      },
      {
        providerId: 'scoped-provider',
        connectionId: 'bad-scope',
        authStrategy: 'manual-token',
        envAliases: {
          apiToken: 'SCOPE_PROVIDER_TOKEN',
        },
      },
    ],
  });
  fs.writeFileSync(path.join(repoDir, '.env.autonomy.local'), 'BAD_PROVIDER_TOKEN=wrong-token\nSCOPE_PROVIDER_TOKEN=scope-problem\n', 'utf8');

  const invalid = verifyServiceConnection(repoDir, {
    providerId: 'scoped-provider',
    connectionId: 'bad-token',
  });
  const insufficient = verifyServiceConnection(repoDir, {
    providerId: 'scoped-provider',
    connectionId: 'bad-scope',
  });

  assert.equal(invalid.status, 'verification-failed');
  assert.equal(invalid.failureClass, 'invalid-credential');
  assert.equal(insufficient.status, 'insufficient-scopes');
  assert.equal(insufficient.failureClass, 'insufficient-scopes');
});

function createServiceAuthRepo(controlPlaneConfig: Record<string, unknown>) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-service-auth-'));
  const configDir = path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config');
  const runtimeDir = path.join(repoDir, '.autonomy', 'runtime');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'control-plane.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      repoId: 'default',
      label: 'Default repo',
      ...controlPlaneConfig,
    }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(configDir, 'agents.json'),
    `${JSON.stringify({ schemaVersion: 1, agents: [] }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(configDir, 'sprint.json'),
    `${JSON.stringify({ sprintId: 'test' }, null, 2)}\n`,
    'utf8',
  );
  return repoDir;
}
