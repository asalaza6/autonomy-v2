const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname);
const CLI_BIN = path.join(PROJECT_ROOT, 'bin', 'autonomy-v2');
const SERVER_BIN = path.join(PROJECT_ROOT, 'bin', 'autonomy-v2-server');

test('packaged autonomy-v2 runs init, prd:add, and PM planning against an external workspace root', () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxborne-autonomy-v2-package-'));

  fs.mkdirSync(path.join(repoDir, 'src', 'barebones-starter', 'games', 'apps', 'aquarium'), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, 'src', 'barebones-starter', 'games', 'apps', 'aquarium', 'README.md'),
    'aquarium fixture\n',
    'utf8'
  );

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'autonomy-package-test@example.com']);
  git(repoDir, ['config', 'user.name', 'Autonomy Package Test']);
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'fixture']);
  git(repoDir, ['branch', 'dev']);

  runNode(CLI_BIN, ['init', '--root', repoDir]);

  assert.ok(fs.existsSync(path.join(repoDir, 'prompts', 'autonomous', 'v2', 'config', 'agents.json')));
  assert.ok(fs.existsSync(path.join(repoDir, '.autonomy', 'runtime', 'state', 'runtime.json')));

  runNode(CLI_BIN, [
    'prd:add',
    '--root',
    repoDir,
    '--id',
    'prd-package-001',
    '--title',
    'Package smoke PRD',
    '--task-spec',
    JSON.stringify({
      id: 'prd-package-001-aquarium-agent-1',
      title: 'Aquarium package smoke task',
      agentId: 'aquarium-agent',
      description: 'Create one aquarium task through packaged PM planning.',
      allowedPaths: ['src/barebones-starter/games/apps/aquarium/**'],
      acceptance: ['Only aquarium files are queued for this package smoke task.'],
      sprintId: 'multi-agent-mvp',
    }),
  ]);

  const committedPrdSpec = git(repoDir, ['show', 'dev:prompts/autonomous/v2/specs/prds/prd-package-001.json']);
  assert.match(committedPrdSpec, /"id": "prd-package-001"/);

  const tickResult = JSON.parse(runNode(SERVER_BIN, ['tick', '--root', repoDir, '--inline', '--json'], {
    env: {
      AUTONOMY_CODEX_STUB: '1',
    },
  }));

  assert.equal(tickResult.sync.imported.length, 1);
  const runtimePrds = JSON.parse(fs.readFileSync(
    path.join(repoDir, '.autonomy', 'runtime', 'state', 'prds.json'),
    'utf8'
  ));
  assert.equal(runtimePrds.prds[0].id, 'prd-package-001');
  assert.equal(runtimePrds.prds[0].status, 'planned');
  assert.deepEqual(runtimePrds.prds[0].plannedTaskIds, ['prd-package-001-aquarium-agent-1']);
});

function runNode(scriptPath, args, options = {}) {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd || PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
