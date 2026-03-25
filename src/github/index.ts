import { execFileSync } from 'child_process';
import type { AnyRecord } from '../types.js';

function resolveGithubAuthToken(options: AnyRecord = {}) {
  const envToken = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (envToken) {
    return envToken;
  }

  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (token) {
      return token;
    }
  } catch (_) {
    // Ignore; gh may be unavailable or not logged in.
  }

  if (options.required) {
    throw new Error('GitHub auth is required. Set GITHUB_TOKEN/GH_TOKEN or run "gh auth login".');
  }
  return '';
}

function hasGithubAuth(): boolean {
  return Boolean(resolveGithubAuthToken());
}


export { hasGithubAuth };
export { resolveGithubAuthToken };
export default {
  hasGithubAuth,
  resolveGithubAuthToken
};
