import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const CLI_PATH = path.join(__dirname, '..', '..', 'autonomy-v2', 'index.js');
const WORKER_PATH = path.join(__dirname, '..', 'worker', 'index.js');
const DEFAULT_RUNNER_PATH = path.join(__dirname, '..', '..', 'autonomy-v2', 'runner', 'default-runner.js');
const IMPLEMENTATION_DUE_STATUSES = new Set(['queued', 'active']);
const BACKLOG_GRACE_MS = 15000;

export {
  AUTONOMY_SEGMENTS,
  BACKLOG_GRACE_MS,
  CLI_PATH,
  DEFAULT_RUNNER_PATH,
  IMPLEMENTATION_DUE_STATUSES,
  RUNTIME_SEGMENTS,
  WORKER_PATH,
};
