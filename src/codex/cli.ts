import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import {
  buildSpawnExitMessage,
  ensureTrailingNewline,
  extractExecError,
  extractSpawnSyncError,
  logCodexFailure,
} from './codex-shared.js';

const DEFAULT_CAPTURE_LIMIT = 64 * 1024;

async function runCodexStructured({ cwd, prompt, schema, readOnly }) {
  const codexBin = process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-codex-'));
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'output.json');
  const streamOutput = shouldStreamCodexOutput();

  try {
    fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    const args = buildCodexArgs({ cwd, schemaPath, outputPath, readOnly });
    logCodexInvocation({ cwd, prompt, args, readOnly, streamOutput });
    await runCodexCommand({
      binary: codexBin,
      args,
      cwd,
      input: prompt,
      streamOutput,
    });
    return readCodexOutput(outputPath, streamOutput);
  } catch (error) {
    logCodexFailure(error, streamOutput);
    throw new Error(`Codex CLI failed: ${extractExecError(error)}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runCodexExec({ cwd, prompt, readOnly }) {
  const codexBin = process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const streamOutput = shouldStreamCodexOutput();
  try {
    const args = buildCodexExecArgs({ cwd, readOnly });
    logCodexInvocation({ cwd, prompt, args, readOnly, streamOutput });
    await runCodexCommand({
      binary: codexBin,
      args,
      cwd,
      input: prompt,
      streamOutput,
    });
  } catch (error) {
    logCodexFailure(error, streamOutput);
    throw new Error(`Codex CLI failed: ${extractExecError(error)}`);
  }
}

function runCodexStructuredSync({ cwd, prompt, schema, readOnly }) {
  const codexBin = process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-codex-'));
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'output.json');
  const streamOutput = shouldStreamCodexOutput();

  try {
    fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    const args = buildCodexArgs({ cwd, schemaPath, outputPath, readOnly });
    logCodexInvocation({ cwd, prompt, args, readOnly, streamOutput });
    runCodexCommandSync({
      binary: codexBin,
      args,
      cwd,
      input: prompt,
      streamOutput,
    });
    return readCodexOutput(outputPath, streamOutput);
  } catch (error) {
    logCodexFailure(error, streamOutput);
    throw new Error(`Codex CLI failed: ${extractExecError(error)}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildCodexArgs({ cwd, schemaPath, outputPath, readOnly }) {
  const args = ['--ask-for-approval', 'never', 'exec'];
  args.push('--sandbox', readOnly ? 'read-only' : 'danger-full-access');

  const model = String(process.env.AUTONOMY_CODEX_MODEL || '').trim();
  if (model) {
    args.push('-m', model);
  }

  const profile = String(process.env.AUTONOMY_CODEX_PROFILE || '').trim();
  if (profile) {
    args.push('-p', profile);
  }

  args.push(
    '--cd',
    cwd,
    '--ephemeral',
    '--color',
    'never',
    '--output-schema',
    schemaPath,
    '--output-last-message',
    outputPath,
    '-'
  );
  return args;
}

function buildCodexExecArgs({ cwd, readOnly }) {
  const args = ['--ask-for-approval', 'never', 'exec'];
  args.push('--sandbox', readOnly ? 'read-only' : 'danger-full-access');

  const model = String(process.env.AUTONOMY_CODEX_MODEL || '').trim();
  if (model) {
    args.push('-m', model);
  }

  const profile = String(process.env.AUTONOMY_CODEX_PROFILE || '').trim();
  if (profile) {
    args.push('-p', profile);
  }

  args.push(
    '--cd',
    cwd,
    '--ephemeral',
    '--color',
    'never',
    '-'
  );
  return args;
}

function readCodexOutput(outputPath, streamOutput) {
  if (!fs.existsSync(outputPath)) {
    throw new Error('Codex did not write an output payload.');
  }

  const raw = fs.readFileSync(outputPath, 'utf8').trim();
  if (!raw) {
    throw new Error('Codex output payload was empty.');
  }
  logCodexResult(raw, streamOutput);
  return JSON.parse(raw);
}

function runCodexCommandSync({ binary, args, cwd, input, streamOutput }) {
  const result = spawnSync(binary, args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: streamOutput ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
    maxBuffer: DEFAULT_CAPTURE_LIMIT,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(extractSpawnSyncError(result));
  }
}

function runCodexCommand({ binary, args, cwd, input, streamOutput }) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let stdoutCapture = '';
    let stderrCapture = '';

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const appendCapture = (current, chunk) => {
      const next = `${current}${String(chunk || '')}`;
      if (next.length <= DEFAULT_CAPTURE_LIMIT) {
        return next;
      }
      return next.slice(next.length - DEFAULT_CAPTURE_LIMIT);
    };

    const onData = (streamName, chunk) => {
      if (streamName === 'stdout') {
        stdoutCapture = appendCapture(stdoutCapture, chunk);
        if (streamOutput) {
          process.stdout.write(chunk);
        }
      } else {
        stderrCapture = appendCapture(stderrCapture, chunk);
        if (streamOutput) {
          process.stderr.write(chunk);
        }
      }
    };

    child.stdout.on('data', (chunk) => {
      onData('stdout', chunk);
    });
    child.stderr.on('data', (chunk) => {
      onData('stderr', chunk);
    });
    child.on('error', (error) => {
      error.stdout = stdoutCapture;
      error.stderr = stderrCapture;
      fail(error);
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        const error = new Error(buildSpawnExitMessage({ code, signal, stdout: stdoutCapture, stderr: stderrCapture }));
        error.stdout = stdoutCapture;
        error.stderr = stderrCapture;
        fail(error);
        return;
      }
      succeed();
    });

    child.stdin.end(input, 'utf8');
  });
}

function shouldStreamCodexOutput() {
  return process.env.AUTONOMY_STREAM_WORKER_OUTPUT === '1'
    || process.env.AUTONOMY_STREAM_CODEX_OUTPUT === '1';
}

function logCodexInvocation({ cwd, prompt, args, readOnly, streamOutput }) {
  if (!streamOutput) {
    return;
  }
  console.log(`[codex] invoke ${JSON.stringify({
    cwd,
    readOnly,
    command: [process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex'].concat(args),
  })}`);
  console.log('[codex] prompt:begin');
  process.stdout.write(ensureTrailingNewline(prompt));
  console.log('[codex] prompt:end');
}

function logCodexResult(raw, streamOutput) {
  if (!streamOutput) {
    return;
  }
  console.log('[codex] result:begin');
  process.stdout.write(ensureTrailingNewline(raw));
  console.log('[codex] result:end');
}

export { runCodexExec, runCodexStructured, runCodexStructuredSync };
