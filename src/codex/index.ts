import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { AGENT_ROLES, getRoleAgentLabel, getRoleLabel, isImplementationRole, } from '../agents/role-catalog.js';

const DEFAULT_CAPTURE_LIMIT = 64 * 1024;
const DEFAULT_ERROR_PREVIEW_LIMIT = 1000;

function planPrdTasksWithCodex({ rootDir, agent, config, sprint, prd }) {
  const implementationAgents = (config.agents || []).filter((candidate) => isImplementationRole(candidate.role));
  const laneLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
  const prompt = [
    readOptionalFile(rootDir, agent.systemPrompt),
    `You are planning ${laneLabel} work for an autonomy-first repository.`,
    '',
    `Available ${laneLabel} lanes:`,
    JSON.stringify(
      implementationAgents.map((candidate) => ({
        id: candidate.id,
        personaName: candidate.personaName || candidate.id,
        include: candidate.include || [],
        exclude: candidate.exclude || [],
      })),
      null,
      2
    ),
    '',
    'Product request to decompose:',
    JSON.stringify(
      {
        id: prd.id,
        title: prd.title,
        specification: prd.specification || '',
        requirements: prd.requirements || [],
        taskHints: prd.tasks || [],
        sprintId: prd.sprintId || sprint.sprintId || 'shared',
      },
      null,
      2
    ),
    '',
    'Rules:',
    `- Create ${laneLabel} tasks only. Do not create reviewer tasks.`,
    '- Keep tasks atomic and lane-scoped.',
    `- Each task must target exactly one ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)}.`,
    '- Scope is defined by the chosen agent include/exclude rules. Do not emit task-level scope fields.',
    '- Prefer stable ids of the form "<prd-id>-<lane>-<n>".',
    '- Acceptance criteria must be concrete and testable.',
    '',
    'Return JSON only.',
  ].filter(Boolean).join('\n');

  const output = runCodexStructuredSync({
    cwd: rootDir,
    prompt,
    readOnly: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['tasks', 'summary'],
      properties: {
        summary: {
          type: 'string',
        },
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'agentId', 'description', 'acceptance', 'sprintId'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              agentId: { type: 'string' },
              description: { type: 'string' },
              acceptance: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
              },
              sprintId: { type: 'string' },
            },
          },
        },
      },
    },
  });

  return {
    summary: String(output.summary || '').trim(),
    tasks: validatePlannedTasks({
      prd,
      tasks: output.tasks || [],
      implementationAgents,
      fallbackSprintId: prd.sprintId || sprint.sprintId || 'shared',
    }),
  };
}

async function executeTaskWithCodex({ rootDir, agent, task, laneTasks, pr, branch, worktreePath }) {
  const laneLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
  const prompt = [
    readOptionalFile(rootDir, agent.systemPrompt),
    `You are executing a ${laneLabel} lane inside the assigned git worktree.`,
    '',
    'Hard rules:',
    '- Edit only files within the assigned agent scope and current lane work.',
    '- Implement only the primary task in this run. Do not edit files that belong exclusively to later queued lane tasks.',
    '- Do not modify .autonomy/**, prompts/autonomous/**, or git metadata.',
    '- Do not commit, push, merge, or open/update pull requests. The wrapper will handle git and PR state.',
    '- Keep the diff tightly focused on the assigned work.',
    '- You may inspect the repo and run local commands as needed.',
    '',
    'Primary task:',
    JSON.stringify(task, null, 2),
    '',
    'Lane plan context (later queued lane tasks are context only; they must remain untouched in this run):',
    JSON.stringify(laneTasks, null, 2),
    '',
    'Current lane PR context:',
    JSON.stringify(
      pr
        ? {
            id: pr.id,
            title: pr.title,
            body: pr.body,
            baseBranch: pr.baseBranch,
            headBranch: pr.headBranch,
            reviews: pr.reviews || [],
          }
        : null,
      null,
      2
    ),
    '',
    `Current branch: ${branch}`,
    `Worktree path: ${worktreePath}`,
    '',
    'Make the requested changes directly in the worktree. No structured response is required.',
  ].join('\n');

  await runCodexExec({
    cwd: worktreePath,
    prompt,
    readOnly: false,
  });

  return {
    status: 'completed',
    summary: '',
    notes: '',
  };
}

async function reviewPrWithCodex({ rootDir, agent, reviewTask, pr, branch, worktreePath, checkResults, diffFiles, scopeResult }) {
  const laneLabel = getRoleLabel(AGENT_ROLES.IMPLEMENTATION);
  const prompt = [
    readOptionalFile(rootDir, agent.systemPrompt),
    `You are reviewing a ${laneLabel} branch for merge into dev.`,
    '',
    'Hard rules:',
    '- Do not edit files.',
    '- Review the current branch checked out in this worktree against the base branch.',
    '- Missing or failing required checks are blocking.',
    '- Focus on regressions, correctness, scope violations, weak verification, and merge safety.',
    `- Treat the PR as lane-scoped: files within the ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} scope are in-scope even if sourceTitle/sourceBody mention only the most recent task.`,
    `- Do not request changes solely because the diff includes earlier completed lane-task files that are still within the ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} scope.`,
    '',
    'Review task:',
    JSON.stringify(reviewTask, null, 2),
    '',
    'Pull request context:',
    JSON.stringify(
      {
        id: pr.id,
        title: pr.title,
        body: pr.body,
        baseBranch: pr.baseBranch,
        headBranch: pr.headBranch,
        taskIds: pr.taskIds || [],
        completedTaskIds: pr.completedTaskIds || [],
        acceptance: pr.acceptance || [],
        [`${laneLabel}ScopeViolations`]: pr.scopeViolations || [],
        priorReviews: pr.reviews || [],
      },
      null,
      2
    ),
    '',
    'Deterministic check results already run by the wrapper:',
    JSON.stringify(checkResults || [], null, 2),
    '',
    'Deterministic diff files against the base branch:',
    JSON.stringify(diffFiles || [], null, 2),
    '',
    'Deterministic scope evaluation for those diff files:',
    JSON.stringify(scopeResult || { ok: true, violations: [] }, null, 2),
    '',
    `${laneLabel[0].toUpperCase()}${laneLabel.slice(1)}-time scope violations above are advisory context only; judge merge safety from the current diff and current deterministic scope evaluation.`,
    '',
    `Compare against origin/${pr.baseBranch} when available; do not rely on a stale local ${pr.baseBranch} ref.`,
    `Review branch: ${branch}`,
    `Review worktree path: ${worktreePath}`,
    '',
    'Return JSON only.',
  ].join('\n');

  const output = await runCodexStructured({
    cwd: worktreePath,
    prompt,
    readOnly: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['decision', 'summary', 'concerns'],
      properties: {
        decision: {
          type: 'string',
          enum: ['approved', 'changes_requested'],
        },
        summary: {
          type: 'string',
        },
        concerns: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  });

  const concerns = Array.isArray(output.concerns)
    ? output.concerns.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];

  return {
    decision: output.decision,
    summary: String(output.summary || '').trim(),
    concerns,
  };
}

async function runCodexStructured({ cwd, prompt, schema, readOnly }) {
  const codexBin = process.env.AUTONOMY_CODEX_BIN || process.env.CODEX_BIN || 'codex';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-v2-codex-'));
  const schemaPath = path.join(tempDir, 'schema.json');
  const outputPath = path.join(tempDir, 'output.json');
  const streamOutput = shouldStreamCodexOutput();

  try {
    fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    const args = buildCodexArgs({ cwd, schemaPath, outputPath, readOnly });
    logCodexInvocation({
      cwd,
      prompt,
      args,
      readOnly,
      streamOutput,
    });
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
    logCodexInvocation({
      cwd,
      prompt,
      args,
      readOnly,
      streamOutput,
    });
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

    logCodexInvocation({
      cwd,
      prompt,
      args,
      readOnly,
      streamOutput,
    });
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
  return new Promise((resolve, reject) => {
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
    }

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

function ensureTrailingNewline(value) {
  const text = String(value || '');
  return text.endsWith('\n') ? text : `${text}\n`;
}

function validatePlannedTasks({ prd, tasks, implementationAgents, fallbackSprintId }) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error(`Codex did not return any ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} tasks for PRD "${prd.id}".`);
  }

  const agentMap = new Map(implementationAgents.map((agent) => [agent.id, agent]));
  const seenIds = new Set();

  return tasks.map((task, index) => {
    const agentId = String(task.agentId || '').trim();
    const agent = agentMap.get(agentId);
    if (!agent) {
      throw new Error(`Codex returned unsupported ${getRoleAgentLabel(AGENT_ROLES.IMPLEMENTATION)} "${agentId}".`);
    }

    const id = sanitizeTaskId(task.id || buildGeneratedTaskId(prd.id, agentId, index + 1));
    if (!id) {
      throw new Error(`Codex returned an invalid task id at index ${index}.`);
    }
    if (seenIds.has(id)) {
      throw new Error(`Codex returned duplicate task id "${id}".`);
    }
    seenIds.add(id);

    const acceptance = normalizeStringList(task.acceptance);
    if (acceptance.length === 0) {
      throw new Error(`Task "${id}" must include at least one acceptance criterion.`);
    }

    return {
      id,
      title: String(task.title || '').trim() || `Implement ${agentId} work for ${prd.id}`,
      agentId,
      description: String(task.description || '').trim(),
      acceptance,
      sprintId: String(task.sprintId || '').trim() || fallbackSprintId,
    };
  });
}

function sanitizeTaskId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildGeneratedTaskId(prdId, agentId, index) {
  const lane = String(agentId || '').replace(/-agent$/, '');
  return `${prdId}-${lane}-${index}`;
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function readOptionalFile(rootDir, filePath) {
  if (!filePath) {
    return '';
  }
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
  if (!fs.existsSync(absolutePath)) {
    return '';
  }
  return fs.readFileSync(absolutePath, 'utf8').trim();
}

function normalizeNonEmptyString(value) {
  const normalized = String(value || '').trim();
  return normalized || '';
}

function isPreferredCodexErrorMessage(message) {
  const normalized = normalizeNonEmptyString(message);
  if (!normalized) {
    return false;
  }
  return /^Codex (produced no output for \d+ms|exceeded wall-clock timeout of \d+ms|did not write an output payload\.|output payload was empty\.)$/.test(normalized);
}

function classifyCodexFailure(summary) {
  const normalized = normalizeNonEmptyString(summary);
  if (/^Codex produced no output for \d+ms$/.test(normalized)) {
    return 'inactivity-timeout';
  }
  if (/^Codex exceeded wall-clock timeout of \d+ms$/.test(normalized)) {
    return 'wall-clock-timeout';
  }
  if (normalized === 'Codex did not write an output payload.') {
    return 'missing-output-payload';
  }
  if (normalized === 'Codex output payload was empty.') {
    return 'empty-output-payload';
  }
  return 'process-failure';
}

function trimErrorPreview(value) {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) {
    return '';
  }
  if (normalized.length <= DEFAULT_ERROR_PREVIEW_LIMIT) {
    return normalized;
  }
  return `...[truncated]\n${normalized.slice(-DEFAULT_ERROR_PREVIEW_LIMIT)}`;
}

function logCodexFailure(error, streamOutput) {
  if (!streamOutput) {
    return;
  }
  const summary = extractExecError(error);
  const message = normalizeNonEmptyString(error && error.message);
  const stderr = trimErrorPreview(error && error.stderr);
  const stdout = trimErrorPreview(error && error.stdout);
  const payload = {
    kind: classifyCodexFailure(summary),
    summary,
  };

  if (message && message !== summary) {
    payload.message = message;
  }
  if (stderr && stderr !== summary) {
    payload.stderr = stderr;
  }
  if (stdout && stdout !== summary) {
    payload.stdout = stdout;
  }

  console.error(`[codex] error ${JSON.stringify(payload)}`);
}

function extractExecError(error) {
  const message = normalizeNonEmptyString(error && error.message);
  if (isPreferredCodexErrorMessage(message)) {
    return message;
  }
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return message || 'unknown codex failure';
}

function extractSpawnSyncError(result) {
  const stderr = String(result && result.stderr || '').trim();
  if (stderr) {
    return stderr;
  }
  const stdout = String(result && result.stdout || '').trim();
  if (stdout) {
    return stdout;
  }
  if (result && result.signal) {
    return `process terminated by signal ${result.signal}`;
  }
  if (result && typeof result.status === 'number') {
    return `process exited with status ${result.status}`;
  }
  return 'unknown codex failure';
}

function buildSpawnExitMessage({ code, signal, stdout, stderr }) {
  const stderrText = String(stderr || '').trim();
  if (stderrText) {
    return stderrText;
  }
  const stdoutText = String(stdout || '').trim();
  if (stdoutText) {
    return stdoutText;
  }
  if (signal) {
    return `process terminated by signal ${signal}`;
  }
  if (typeof code === 'number') {
    return `process exited with status ${code}`;
  }
  return 'unknown codex failure';
}


export { executeTaskWithCodex };
export { planPrdTasksWithCodex };
export { runCodexStructured };
export { reviewPrWithCodex };
export default {
  executeTaskWithCodex,
  planPrdTasksWithCodex,
  runCodexStructured,
  reviewPrWithCodex
};

