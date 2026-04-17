import fs from 'fs';
import path from 'path';
import { runGitRead } from './shared-repo.js';

type DeployVersionData = {
  currentVersion: string | null;
  previousVersion: string | null;
  sourceVersion: string | null;
  targetVersion: string | null;
  isNewVersion: boolean;
};

function buildDeployCreatedVersionData(rootDir: string, sourceRef: string, targetRef: string): DeployVersionData {
  const sourceVersion = readPackageVersionAtRef(rootDir, sourceRef);
  const targetVersion = readPackageVersionAtRef(rootDir, targetRef);
  const currentVersion = sourceVersion || targetVersion || readPackageVersion(rootDir);

  return {
    currentVersion,
    previousVersion: targetVersion,
    sourceVersion,
    targetVersion,
    isNewVersion: isVersionNewer(currentVersion, targetVersion),
  };
}

function buildDeploymentVersionSnapshot(rootDir: string, sourceRef: string, targetRef: string): DeployVersionData {
  const sourceVersion = readPackageVersionAtRef(rootDir, sourceRef);
  const targetVersion = readPackageVersionAtRef(rootDir, targetRef);

  return {
    currentVersion: targetVersion || readPackageVersion(rootDir),
    previousVersion: null,
    sourceVersion,
    targetVersion,
    isNewVersion: false,
  };
}

function buildUnavailableDeploymentVersionSnapshot(rootDir: string): DeployVersionData {
  return {
    currentVersion: readPackageVersion(rootDir),
    previousVersion: null,
    sourceVersion: null,
    targetVersion: null,
    isNewVersion: false,
  };
}

function readPackageVersion(rootDir: string) {
  try {
    return readPackageVersionFromText(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function readPackageVersionAtRef(rootDir: string, ref: string) {
  const normalizedRef = String(ref || '').trim();
  if (!normalizedRef) {
    return null;
  }
  try {
    return readPackageVersionFromText(runGitRead(rootDir, ['show', `${normalizedRef}:package.json`]));
  } catch (_) {
    return null;
  }
}

function readPackageVersionFromText(text: string) {
  try {
    const manifest = JSON.parse(text);
    return normalizeVersionString(manifest && manifest.version);
  } catch (_) {
    return null;
  }
}

function normalizeVersionString(value: unknown) {
  const version = String(value || '').trim();
  return version || null;
}

function isVersionNewer(currentVersion: string | null | undefined, previousVersion: string | null | undefined) {
  const current = normalizeVersionString(currentVersion);
  const previous = normalizeVersionString(previousVersion);
  if (!current || !previous) {
    return false;
  }
  return compareVersionStrings(current, previous) > 0;
}

function compareVersionStrings(left: string, right: string) {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) {
    return left === right ? 0 : -1;
  }

  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }
  return 0;
}

function parseVersionParts(value: string) {
  const match = String(value || '').trim().match(/^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/);
  if (!match) {
    return null;
  }
  return match[1].split('.').map((part) => Number(part));
}

export {
  buildDeployCreatedVersionData,
  buildDeploymentVersionSnapshot,
  buildUnavailableDeploymentVersionSnapshot,
  isVersionNewer,
  normalizeVersionString,
};
