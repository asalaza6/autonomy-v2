import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveRuntimeEntry(...segments: string[]) {
  const candidate = path.join(__dirname, ...segments);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.join(__dirname, ...segments.slice(0, -1), 'index.js');
}

const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const CLI_PATH = path.join(__dirname, '..', '..', 'autonomy-v2', 'index.js');
const WORKER_PATH = resolveRuntimeEntry('..', 'worker', 'worker-main.js');
const CUSTOM_AGENT_WORKER_PATH = resolveRuntimeEntry('..', 'custom-agents', 'custom-agent-worker.js');
const DEFAULT_RUNNER_PATH = path.join(__dirname, '..', '..', 'autonomy-v2', 'runner', 'default-runner.js');
const IMPLEMENTATION_DUE_STATUSES = new Set(['queued', 'active']);
const BACKLOG_GRACE_MS = 15000;

export {
  AUTONOMY_SEGMENTS,
  BACKLOG_GRACE_MS,
  CLI_PATH,
  CUSTOM_AGENT_WORKER_PATH,
  DEFAULT_RUNNER_PATH,
  IMPLEMENTATION_DUE_STATUSES,
  RUNTIME_SEGMENTS,
  WORKER_PATH,
};
