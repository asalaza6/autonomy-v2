import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLI_PATH = path.join(__dirname, '..', 'index.js');
const AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];

export {
  AUTONOMY_SEGMENTS,
  CLI_PATH,
  RUNTIME_SEGMENTS,
};
