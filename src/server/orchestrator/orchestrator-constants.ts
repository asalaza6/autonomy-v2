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
const CUSTOM_AGENT_WORKER_PATH = resolveRuntimeEntry('..', 'custom-agents', 'custom-agent-worker.js');
const IMPLEMENTATION_DUE_STATUSES = new Set(['queued', 'active']);

export {
  AUTONOMY_SEGMENTS,
  CLI_PATH,
  CUSTOM_AGENT_WORKER_PATH,
  IMPLEMENTATION_DUE_STATUSES,
  RUNTIME_SEGMENTS,
};
