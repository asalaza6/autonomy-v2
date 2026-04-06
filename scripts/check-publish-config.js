import { execFileSync } from 'node:child_process';

function fail(message) {
  console.error(message);
  process.exit(1);
}

try {
  const username = execFileSync(
    'npm',
    ['whoami', '--registry=https://registry.npmjs.org/'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }
  ).trim();

  if (!username) {
    fail(
      'npm publish preflight failed: `npm whoami` returned an empty username. Check your npm auth before releasing.'
    );
  }

  console.log(`npm publish preflight passed for npm user "${username}".`);
} catch (error) {
  const details =
    error instanceof Error && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);

  fail(
    [
      'npm publish preflight failed: this shell is not authenticated to npmjs.org.',
      'Run `npm login` or replace the token in ~/.npmrc with a valid npm access token, then retry.',
      details ? `npm said: ${details}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  );
}
