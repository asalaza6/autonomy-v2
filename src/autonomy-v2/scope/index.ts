import path from 'path';
import type { AnyRecord } from '../../types.js';
import { execFileSync } from 'child_process';

function normalizeRepoPath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesAnyGlob(filePath, globs) {
  const normalizedPath = normalizeRepoPath(filePath);
  return globs.some((glob) => globToRegExp(normalizeRepoPath(glob)).test(normalizedPath));
}

function globToRegExp(glob) {
  const normalizedGlob = normalizeRepoPath(glob);
  const segments = normalizedGlob.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return /^$/;
  }
  let pattern = '^';
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const isPrevWildcardStar = i > 0 && segments[i - 1] === '**';
    if (segment === '**') {
      if (i > 0) {
        pattern += '/';
      }
      if (i === segments.length - 1) {
        pattern += '.*';
      } else {
        pattern += '(?:[^/]+/)*';
      }
      continue;
    }
    if (i > 0 && !isPrevWildcardStar) {
      pattern += '/';
    }
    const escaped = segment.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    pattern += escaped;
  }
  return new RegExp(`${pattern}$`);
}

function evaluateScope({ files, agent, task: _task }: { files: string[]; agent: AnyRecord; task?: AnyRecord }) {
  const violations = [];
  const includeGlobs = agent.include || [];
  const excludeGlobs = agent.exclude || [];

  for (const file of files) {
    const inAgentScope = includeGlobs.length === 0 || matchesAnyGlob(file, includeGlobs);
    const excluded = excludeGlobs.length > 0 && matchesAnyGlob(file, excludeGlobs);

    if (!inAgentScope) {
      violations.push({ file, reason: 'outside agent include scope' });
      continue;
    }
    if (excluded) {
      violations.push({ file, reason: 'matches agent exclude scope' });
    }
  }

  return {
    ok: violations.length === 0,
    files,
    includeGlobs,
    excludeGlobs,
    violations,
  };
}

function collectFilesForValidation(rootDir, options, getListOption) {
  const explicitFiles = getListOption(options, 'files');
  if (explicitFiles.length > 0) {
    return explicitFiles.map(normalizeRepoPath);
  }

  if (options.worktree) {
    const worktreePath = path.isAbsolute(options.worktree)
      ? options.worktree
      : path.join(rootDir, options.worktree);
    const output = execFileSync('git', ['diff', '--name-only'], {
      cwd: worktreePath,
      encoding: 'utf8',
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(normalizeRepoPath);
  }

  return [];
}


;
export { evaluateScope };
;
;
;
