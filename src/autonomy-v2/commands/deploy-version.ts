import fs from 'fs';
import path from 'path';
import { runGitRead } from './shared-repo.js';

type DeployVersionData = {
  currentVersion: string | null;
  previousVersion: string | null;
  sourceVersion: string | null;
  targetVersion: string | null;
  isNewVersion: boolean;
  packageVersion?: string | null;
  previousPackageVersion?: string | null;
  sourcePackageVersion?: string | null;
  targetPackageVersion?: string | null;
  sourceSha?: string | null;
  targetSha?: string | null;
  sourceBuildNumber?: number | null;
  targetBuildNumber?: number | null;
};

function buildDeployCreatedVersionData(rootDir: string, sourceRef: string, targetRef: string): DeployVersionData {
  const sourceVersion = buildRefVersion(rootDir, sourceRef);
  const targetVersion = buildRefVersion(rootDir, targetRef);
  const currentVersion = sourceVersion.version || sourceVersion.packageVersion || targetVersion.version || readPackageVersion(rootDir);

  return {
    currentVersion,
    previousVersion: targetVersion.version,
    sourceVersion: sourceVersion.version,
    targetVersion: targetVersion.version,
    isNewVersion: buildRefsDiffer(sourceVersion, targetVersion)
      || isVersionNewer(sourceVersion.packageVersion, targetVersion.packageVersion),
    packageVersion: sourceVersion.packageVersion || targetVersion.packageVersion || readPackageVersion(rootDir),
    previousPackageVersion: targetVersion.packageVersion,
    sourcePackageVersion: sourceVersion.packageVersion,
    targetPackageVersion: targetVersion.packageVersion,
    sourceSha: sourceVersion.sha,
    targetSha: targetVersion.sha,
    sourceBuildNumber: sourceVersion.buildNumber,
    targetBuildNumber: targetVersion.buildNumber,
  };
}

function buildDeploymentVersionSnapshot(rootDir: string, sourceRef: string, targetRef: string): DeployVersionData {
  const sourceVersion = buildRefVersion(rootDir, sourceRef);
  const targetVersion = buildRefVersion(rootDir, targetRef);

  return {
    currentVersion: targetVersion.version || targetVersion.packageVersion || readPackageVersion(rootDir),
    previousVersion: null,
    sourceVersion: sourceVersion.version,
    targetVersion: targetVersion.version,
    isNewVersion: false,
    packageVersion: targetVersion.packageVersion || readPackageVersion(rootDir),
    previousPackageVersion: null,
    sourcePackageVersion: sourceVersion.packageVersion,
    targetPackageVersion: targetVersion.packageVersion,
    sourceSha: sourceVersion.sha,
    targetSha: targetVersion.sha,
    sourceBuildNumber: sourceVersion.buildNumber,
    targetBuildNumber: targetVersion.buildNumber,
  };
}

function buildUnavailableDeploymentVersionSnapshot(rootDir: string): DeployVersionData {
  const packageVersion = readPackageVersion(rootDir);
  return {
    currentVersion: packageVersion,
    previousVersion: null,
    sourceVersion: null,
    targetVersion: null,
    isNewVersion: false,
    packageVersion,
    previousPackageVersion: null,
    sourcePackageVersion: null,
    targetPackageVersion: null,
    sourceSha: null,
    targetSha: null,
    sourceBuildNumber: null,
    targetBuildNumber: null,
  };
}

function buildRefVersion(rootDir: string, ref: string) {
  const packageVersion = readPackageVersionAtRef(rootDir, ref);
  const sha = readGitValue(rootDir, ['rev-parse', ref]);
  const shortSha = readGitValue(rootDir, ['rev-parse', '--short=12', ref]);
  const rawBuildNumber = readGitValue(rootDir, ['rev-list', '--count', ref]);
  const buildNumber = rawBuildNumber ? Number(rawBuildNumber) : null;
  const version = formatBuildVersion({
    packageVersion,
    buildNumber,
    shortSha,
  });

  return {
    version,
    packageVersion,
    sha,
    buildNumber: Number.isFinite(buildNumber) ? buildNumber : null,
  };
}

function formatBuildVersion({
  packageVersion,
  buildNumber,
  shortSha,
}: {
  packageVersion: string | null;
  buildNumber: number | null;
  shortSha: string | null;
}) {
  if (!buildNumber || !shortSha) {
    return packageVersion;
  }
  const baseVersion = packageVersion || '0.0.0';
  return `${baseVersion}+build.${buildNumber}.${shortSha}`;
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

function readGitValue(rootDir: string, args: string[]) {
  try {
    return runGitRead(rootDir, args).trim() || null;
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

function buildRefsDiffer(left: { sha?: string | null }, right: { sha?: string | null }) {
  return Boolean(left.sha && right.sha && left.sha !== right.sha);
}

export {
  buildDeployCreatedVersionData,
  buildDeploymentVersionSnapshot,
  buildUnavailableDeploymentVersionSnapshot,
};
