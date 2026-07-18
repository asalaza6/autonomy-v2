import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-custom-agent-test-'));
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeExecutable(filePath: string, source: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function writeFluxborneFixture(rootDir: string, options: {
  shouldRun?: boolean;
  conversationMode?: string;
  codexFails?: boolean;
} = {}) {
  const scriptsDir = path.join(rootDir, 'scripts', 'agent');
  const workspace = path.join(rootDir, '.autonomy', 'runtime', 'game-agent');
  const decisionPath = path.join(scriptsDir, 'decision.mjs');
  const lifecyclePath = path.join(scriptsDir, 'lifecycle.mjs');
  const codexPath = path.join(scriptsDir, 'fake-codex');
  const lifecycleLog = path.join(rootDir, 'lifecycle.jsonl');
  const codexLog = path.join(rootDir, 'codex.json');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'docs', 'AGENT.md'), '# Agent context\n', 'utf8');

  writeExecutable(decisionPath, `#!/usr/bin/env node
import fs from 'node:fs';
const envelope = JSON.parse(fs.readFileSync(0, 'utf8'));
if (envelope.phase !== 'shouldRun') process.exit(2);
process.stdout.write(JSON.stringify({
  shouldRun: ${options.shouldRun !== false},
  reason: 'fixture decision',
  jobId: 'job-1',
  target: { jobId: 'job-1', gameId: 'fixture-game' }
}) + '\\n');
`);
  writeExecutable(lifecyclePath, `#!/usr/bin/env node
import fs from 'node:fs';
const envelope = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.env.FIXTURE_LIFECYCLE_LOG, JSON.stringify(envelope) + '\\n');
if (envelope.phase === 'environment') {
  process.stdout.write(JSON.stringify({ cwd: ${JSON.stringify(workspace)} }) + '\\n');
} else if (envelope.phase === 'prompt') {
  process.stdout.write(JSON.stringify({ prompt: 'implement the fixture task' }) + '\\n');
} else if (envelope.phase === 'finalize') {
  process.stdout.write(JSON.stringify({ finalized: true }) + '\\n');
}
`);
  writeExecutable(codexPath, `#!/usr/bin/env node
import fs from 'node:fs';
const prompt = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.FIXTURE_CODEX_LOG, JSON.stringify({ args: process.argv.slice(2), prompt }));
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify({ thread_id: 'thread-fixture' }) + '\\n');
${options.codexFails ? "process.stderr.write('fixture Codex failure\\n'); process.exit(9);" : ''}
`);

  writeJson(path.join(rootDir, 'prompts', 'autonomous', 'v2', 'config', 'custom-agents.json'), {
    schemaVersion: 1,
    enabled: true,
    kind: 'fluxborne-game-agents',
    promptRole: 'Fluxborne game implementation and deployment agent',
    context: {
      globalReadOnly: ['docs/AGENT.md'],
      workspaceReadWrite: ['context.md', 'notes.md', 'recent-summary.md'],
      allowRuntimeStateChanges: true,
    },
    agents: [{
      id: 'game-agent',
      enabled: true,
      target: { type: 'repository', id: 'fluxborne' },
      workspace: '.autonomy/runtime/game-agent',
      spawn: {
        mode: 'poll',
        intervalSeconds: 10,
        singletonKey: 'agent.id',
        decision: {
          mode: 'command',
          command: process.execPath,
          args: [decisionPath],
          timeoutMs: 15_000,
        },
      },
      environment: {
        command: process.execPath,
        args: [lifecyclePath],
        cwd: '.',
        env: { FIXTURE_LIFECYCLE_LOG: lifecycleLog },
        timeoutMs: 30_000,
      },
      execution: {
        prompt: {
          command: process.execPath,
          args: [lifecyclePath],
          cwd: '.',
          env: { FIXTURE_LIFECYCLE_LOG: lifecycleLog },
          timeoutMs: 30_000,
        },
      },
      finalize: {
        command: process.execPath,
        args: [lifecyclePath],
        cwd: '.',
        env: { FIXTURE_LIFECYCLE_LOG: lifecycleLog },
        timeoutMs: 30_000,
      },
      conversation: { mode: options.conversationMode || 'fresh' },
    }],
  });

  return { rootDir, workspace, lifecycleLog, codexLog, codexPath };
}

function waitForChild(child: ChildProcess) {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

async function withEnvironment(values: Record<string, string | undefined>, callback: () => Promise<void> | void) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    await callback();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
}

export {
  makeRoot,
  waitForChild,
  withEnvironment,
  writeExecutable,
  writeFluxborneFixture,
  writeJson,
};
