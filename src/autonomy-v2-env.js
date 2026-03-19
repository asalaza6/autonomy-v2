const fs = require('fs');
const path = require('path');

const DEFAULT_ENV_FILES = [
  '.env.autonomy.local',
  '.env.autonomy',
  '.env.local',
  '.env',
];

function loadAutonomyEnv(rootDir) {
  const baseDir = rootDir || process.cwd();
  DEFAULT_ENV_FILES.forEach((fileName) => {
    const filePath = path.join(baseDir, fileName);
    if (!fs.existsSync(filePath)) {
      return;
    }
    parseEnvFile(filePath);
  });
}

function parseEnvFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      return;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

module.exports = {
  loadAutonomyEnv,
};
