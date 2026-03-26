import path from 'path';

const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const PRD_SPECS_DIR = path.posix.join(...AUTONOMY_SEGMENTS, 'specs', 'prds');
const PRD_QUEUE_DIR = path.posix.join(PRD_SPECS_DIR, 'queue');
const PRD_ARCHIVE_DIR = path.posix.join(PRD_SPECS_DIR, 'archived');
const PRD_STATE_DIR = path.posix.join(...AUTONOMY_SEGMENTS, 'specs', 'prd-state');
const GIT_NETWORK_TIMEOUT_MS = 15000;
const HTTP_REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_SYNC_STATE = {
  integrationBranch: 'dev',
  lastFetchedRef: null,
  importedSpecs: {},
};

export {
  AUTONOMY_SEGMENTS,
  DEFAULT_SYNC_STATE,
  GIT_NETWORK_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  PRD_ARCHIVE_DIR,
  PRD_QUEUE_DIR,
  PRD_SPECS_DIR,
  PRD_STATE_DIR,
  RUNTIME_SEGMENTS,
};
