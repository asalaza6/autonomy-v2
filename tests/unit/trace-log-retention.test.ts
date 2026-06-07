import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { appendTraceLine } from '../../src/server/commands/trace.js';
import { attachWorkerOutput, writePrefixedChunks } from '../../src/server/commands/worker-streams.js';

test('appendTraceLine trims old stream output when the trace log exceeds its max size', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-trace-retention-'));
  const logPath = path.join(dir, 'stream.log');

  for (let index = 0; index < 24; index += 1) {
    appendTraceLine(logPath, `line-${String(index).padStart(2, '0')} ${'x'.repeat(20)}`, {
      traceLogMaxBytes: 220,
      traceLogTrimBytes: 90,
      traceLineMaxBytes: 1000,
    });
  }

  const contents = fs.readFileSync(logPath, 'utf8');
  assert.match(contents, /trace:trimmed/);
  assert.doesNotMatch(contents, /line-00/);
  assert.match(contents, /line-23/);
  assert.ok(fs.statSync(logPath).size < 220);
});

test('appendTraceLine truncates oversized single stream lines', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-trace-line-'));
  const logPath = path.join(dir, 'stream.log');

  appendTraceLine(logPath, `prefix ${'x'.repeat(300)}`, {
    traceLogMaxBytes: 10000,
    traceLogTrimBytes: 5000,
    traceLineMaxBytes: 80,
  });

  const contents = fs.readFileSync(logPath, 'utf8');
  assert.match(contents, /^prefix /);
  assert.match(contents, /\[truncated \d+ bytes\]/);
  assert.ok(Buffer.byteLength(contents, 'utf8') < 120);
});

test('writePrefixedChunks flushes oversized pending output without waiting for newline', () => {
  const lines: string[] = [];
  const remainder = writePrefixedChunks(
    'agent-a',
    123,
    'stdout',
    '',
    'x'.repeat(120),
    {},
    (line) => { lines.push(line); },
    () => '2026-05-21T00:00:00.000Z',
    80
  );

  assert.equal(remainder, '');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /agent-a \| pid=123 \| stdout/);
  assert.match(lines[0], /x{80}/);
});

test('attachWorkerOutput logs custom-agent conversation resume metadata', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-trace-attach-conversation-'));
  const child: any = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const attachedWorkers = new Map();

  attachWorkerOutput(attachedWorkers, {
    agentId: 'shadow-architecture-agent',
    pid: 1234,
    reason: 'custom-agent',
    child,
    conversation: {
      key: 'shadow-architecture-agent:prd-example',
      resumeSessionId: 'session-existing',
    },
  }, {
    rootDir,
    autoOpenTraceWindows: false,
  });

  child.emit('exit', 0, null);

  const tracePath = path.join(rootDir, '.autonomy', 'runtime', 'agents', 'shadow-architecture-agent', 'stream.log');
  const contents = fs.readFileSync(tracePath, 'utf8');
  assert.match(contents, /worker:attach/);
  assert.match(contents, /conversationId=session-existing/);
  assert.match(contents, /conversationKey=shadow-architecture-agent:prd-example/);
});
