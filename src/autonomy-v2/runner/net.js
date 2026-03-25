const { execFileSync } = require('child_process');

function resolveGithubRepo(rootDir) {
  const remoteUrl = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.hostname === 'github.com') {
      const trimmedPath = parsedUrl.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
      const segments = trimmedPath.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return {
          owner: segments[0],
          repo: segments.slice(1).join('/'),
        };
      }
    }
  } catch (error) {
    // Fall back to regex parsing for non-URL formats.
  }

  const httpsMatch = remoteUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
    };
  }

  throw new Error(`Unsupported GitHub remote URL: ${remoteUrl}`);
}

function postIssueComment(repo, token, issueNumber, body) {
  return githubRequest(repo, token, 'POST', `/issues/${issueNumber}/comments`, { body });
}

function githubRequest(repo, token, method, endpoint, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo.owner}/${repo.repo}${endpoint}`,
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'autonomy-v2-runner',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };

  if (body) {
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }

  const response = execHttpRequest(options, body);
  if (response.statusCode >= 200 && response.statusCode < 300) {
    return response.payload;
  }
  throw new Error(`GitHub API ${response.statusCode}: ${response.payload.message || response.raw}`);
}

function execHttpRequest(options, body) {
  const result = {
    statusCode: 0,
    payload: {},
    raw: '',
  };

  const response = execFileSync(process.execPath, ['-e', buildHttpClientScript()], {
    cwd: __dirname,
    env: {
      ...process.env,
      AUTONOMY_HTTP_OPTIONS: JSON.stringify(options),
      AUTONOMY_HTTP_BODY: body || '',
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

  if (response) {
    const parsed = JSON.parse(response);
    result.statusCode = parsed.statusCode;
    result.payload = parsed.payload;
    result.raw = parsed.raw;
  }
  return result;
}

function buildHttpClientScript() {
  return `
const https = require('https');
const options = JSON.parse(process.env.AUTONOMY_HTTP_OPTIONS);
const body = process.env.AUTONOMY_HTTP_BODY || '';
const req = https.request(options, (res) => {
  let raw = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { raw += chunk; });
  res.on('end', () => {
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch (_) {}
    process.stdout.write(JSON.stringify({ statusCode: res.statusCode, payload, raw }));
  });
});
req.on('error', (error) => {
  process.stderr.write(error.message);
  process.exit(1);
});
if (body) req.write(body);
req.end();
`;
}

module.exports = {
  postIssueComment,
  resolveGithubRepo,
};
