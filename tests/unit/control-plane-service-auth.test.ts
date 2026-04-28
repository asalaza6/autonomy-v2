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
import { loadAutonomyEnv } from '../../src/env/env-main.js';

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

test('service auth executes repo-relative provider commands from the selected repo root', () => {
  const repoDir = createServiceAuthRepo({
    serviceProviders: [
      {
        providerId: 'repo-relative',
        authFields: [
          { field: 'apiToken', required: true, secret: true },
        ],
        verifyCommand: {
          command: {
            command: process.execPath,
            args: ['verify.js'],
            cwd: 'scripts',
          },
        },
        preflightCommand: {
          command: {
            command: process.execPath,
            args: ['preflight.js'],
            cwd: 'scripts',
          },
        },
        deployCommand: {
          command: {
            command: process.execPath,
            args: ['deploy.js'],
            cwd: 'scripts',
          },
        },
        postDeployMetadataCommand: {
          command: {
            command: process.execPath,
            args: ['post-deploy.js'],
            cwd: 'scripts',
          },
        },
      },
    ],
    serviceConnections: [
      {
        providerId: 'repo-relative',
        connectionId: 'primary',
        authStrategy: 'manual-token',
        envAliases: {
          apiToken: 'REPO_RELATIVE_TOKEN',
        },
      },
    ],
  });
  fs.writeFileSync(path.join(repoDir, '.env.autonomy.local'), 'REPO_RELATIVE_TOKEN=repo-relative-token\n', 'utf8');
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'scripts', 'verify.js'),
    "console.log(JSON.stringify({ ok: process.cwd().endsWith('/scripts'), status: 'connected', accountMetadata: { cwd: process.cwd() } }));\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoDir, 'scripts', 'preflight.js'),
    "require('fs').writeFileSync('preflight-marker.txt', process.cwd(), 'utf8');\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoDir, 'scripts', 'deploy.js'),
    "console.log('repo-relative deploy');\n",
    'utf8',
  );
  fs.writeFileSync(
    path.join(repoDir, 'scripts', 'post-deploy.js'),
    "console.log(JSON.stringify({ ok: true, accountMetadata: { scriptCwd: process.cwd() }, capabilityMetadata: { verifiedFrom: require('path').basename(process.cwd()) } }));\n",
    'utf8',
  );

  const summary = verifyServiceConnection(repoDir, {
    providerId: 'repo-relative',
    connectionId: 'primary',
  });
  const deployExecution = createProviderDeployExecution(repoDir, {
    providerId: 'repo-relative',
    connectionId: 'primary',
  });
  const metadata = deployExecution?.postDeployMetadata?.({
    rootDir: repoDir,
    deployResult: {},
  });
  const scriptsDir = fs.realpathSync(path.join(repoDir, 'scripts'));

  assert.equal(summary.status, 'connected');
  assert.equal(fs.realpathSync(String(summary.accountMetadata?.cwd || '')), scriptsDir);
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(repoDir, 'scripts', 'preflight-marker.txt'), 'utf8')), scriptsDir);
  assert.equal((deployExecution?.deployCommand as any).cwd, 'scripts');
  assert.deepEqual(metadata, {
    accountMetadata: {
      scriptCwd: scriptsDir,
    },
    capabilityMetadata: {
      verifiedFrom: 'scripts',
    },
  });
});

test('service auth resolves conflicting env aliases per repo instead of shared process state', () => {
  const repoA = createServiceAuthRepo({
    repoId: 'repo-a',
    serviceProviders: [
      {
        providerId: 'shared-alias',
        authFields: [
          { field: 'apiToken', required: true, secret: true },
        ],
        verifyCommand: {
          command: {
            command: process.execPath,
            args: [
              '-e',
              'if (process.env.PROVIDER_TOKEN === "token-a") { console.log(JSON.stringify({ ok: true, accountMetadata: { repo: "A" } })); process.exit(0); } process.exit(1);',
            ],
            env: {
              PROVIDER_TOKEN: '{{apiToken}}',
            },
          },
        },
      },
    ],
    serviceConnections: [
      {
        providerId: 'shared-alias',
        connectionId: 'primary',
        authStrategy: 'manual-token',
        envAliases: {
          apiToken: 'SHARED_PROVIDER_TOKEN',
        },
      },
    ],
  });
  const repoB = createServiceAuthRepo({
    repoId: 'repo-b',
    serviceProviders: [
      {
        providerId: 'shared-alias',
        authFields: [
          { field: 'apiToken', required: true, secret: true },
        ],
        verifyCommand: {
          command: {
            command: process.execPath,
            args: [
              '-e',
              'if (process.env.PROVIDER_TOKEN === "token-b") { console.log(JSON.stringify({ ok: true, accountMetadata: { repo: "B" } })); process.exit(0); } process.exit(1);',
            ],
            env: {
              PROVIDER_TOKEN: '{{apiToken}}',
            },
          },
        },
      },
    ],
    serviceConnections: [
      {
        providerId: 'shared-alias',
        connectionId: 'primary',
        authStrategy: 'manual-token',
        envAliases: {
          apiToken: 'SHARED_PROVIDER_TOKEN',
        },
      },
    ],
  });
  fs.writeFileSync(path.join(repoA, '.env.autonomy.local'), 'SHARED_PROVIDER_TOKEN=token-a\n', 'utf8');
  fs.writeFileSync(path.join(repoB, '.env.autonomy.local'), 'SHARED_PROVIDER_TOKEN=token-b\n', 'utf8');

  const originalSharedToken = process.env.SHARED_PROVIDER_TOKEN;
  delete process.env.SHARED_PROVIDER_TOKEN;
  try {
    loadAutonomyEnv(repoA);
    loadAutonomyEnv(repoB);

    const runtimeEnv = {};
    const summaryA = verifyServiceConnection(repoA, {
      providerId: 'shared-alias',
      connectionId: 'primary',
    }, { runtimeEnv });
    const summaryB = verifyServiceConnection(repoB, {
      providerId: 'shared-alias',
      connectionId: 'primary',
    }, { runtimeEnv });

    assert.equal(summaryA.status, 'connected');
    assert.equal(summaryA.accountMetadata?.repo, 'A');
    assert.equal(summaryB.status, 'connected');
    assert.equal(summaryB.accountMetadata?.repo, 'B');
  } finally {
    restoreEnv('SHARED_PROVIDER_TOKEN', originalSharedToken);
  }
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

function restoreEnv(key: string, value: string | undefined) {
  if (typeof value === 'undefined') {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
