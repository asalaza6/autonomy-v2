import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import type { ManagedSiteRecord, ManagedSiteDeployment } from '../../types.js';
import {
  getManagedSite,
  getManagedSiteRoot,
  updateManagedSite,
} from './manager-store.js';

type HerokuBuildResponse = {
  id?: string;
  status?: string;
  source_blob?: {
    url?: string;
    version?: string;
  };
  slug?: {
    id?: string | null;
  };
};

type HerokuAppResponse = {
  name?: string;
  web_url?: string;
};

async function deployManagedSiteToHeroku(rootDir: string, siteId: string, options: {
  appName?: string;
  apiBaseUrl?: string;
}) {
  const site = getManagedSite(rootDir, siteId);
  if (!site) {
    throw new Error(`Unknown site "${siteId}".`);
  }

  const apiBaseUrl = String(options.apiBaseUrl || process.env.AUTONOMY_MANAGER_HEROKU_API_BASE_URL || 'https://api.heroku.com').replace(/\/+$/, '');
  const apiKey = String(process.env.HEROKU_API_KEY || process.env.HEROKU_TOKEN || '').trim();
  if (!apiKey) {
    const updated = updateManagedSite(rootDir, siteId, {
      deployment: {
        ...(site.deployment || { status: 'idle' }),
        target: 'heroku',
        status: 'skipped',
        provider: 'heroku',
        lastError: 'Missing HEROKU_API_KEY or HEROKU_TOKEN.',
        updatedAt: new Date().toISOString(),
      },
    });
    return {
      site: updated || site,
      skipped: true,
    };
  }

  const bundlePath = buildHerokuSourceBundle(rootDir, site);
  const appName = slugifyHerokuAppName(options.appName || site.slug);
  const app = await requestHerokuJson<HerokuAppResponse>(`${apiBaseUrl}/apps`, {
    method: 'POST',
    token: apiKey,
    body: {
      name: appName,
    },
  });
  const herokuAppName = String(app.name || appName);
  const source = await requestHerokuJson<{ source_blob?: { put_url?: string; get_url?: string } }>(
    `${apiBaseUrl}/apps/${encodeURIComponent(herokuAppName)}/sources`,
    {
      method: 'POST',
      token: apiKey,
    }
  );
  const putUrl = String(source.source_blob?.put_url || '');
  const getUrl = String(source.source_blob?.get_url || '');
  if (!putUrl || !getUrl) {
    throw new Error('Heroku source upload URLs were not returned.');
  }

  const sourceBuffer = fs.readFileSync(bundlePath);
  const putResponse = await fetch(putUrl, {
    method: 'PUT',
    headers: {
      'content-type': '',
    },
    body: sourceBuffer,
  });
  if (!putResponse.ok) {
    throw new Error(`Heroku source upload failed: ${await putResponse.text() || putResponse.statusText}`);
  }

  const build = await requestHerokuJson<HerokuBuildResponse>(
    `${apiBaseUrl}/apps/${encodeURIComponent(herokuAppName)}/builds`,
    {
      method: 'POST',
      token: apiKey,
      body: {
        source_blob: {
          url: getUrl,
          version: String(site.updatedAt || site.createdAt || new Date().toISOString()),
        },
      },
    }
  );

  const appUrl = String(app.web_url || `https://${herokuAppName}.herokuapp.com`);
  const deployment: ManagedSiteDeployment = {
    target: 'heroku',
    status: build.status === 'failed' ? 'failed' : 'pending',
    provider: 'heroku',
    appName: herokuAppName,
    appUrl,
    buildId: build.id,
    version: String(site.updatedAt || site.createdAt || new Date().toISOString()),
    sourceBundlePath: bundlePath,
    updatedAt: new Date().toISOString(),
  };

  const updatedSite = updateManagedSite(rootDir, siteId, {
    publicUrl: appUrl,
    deployment,
  });

  return {
    site: updatedSite || site,
    app,
    build,
    bundlePath,
  };
}

function buildHerokuSourceBundle(rootDir: string, site: ManagedSiteRecord) {
  const bundleDir = path.join(rootDir, '.autonomy', 'manager', 'deploy');
  fs.mkdirSync(bundleDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(bundleDir, `${site.slug}-`));
  const siteRoot = getManagedSiteRoot(rootDir, site);
  copyDirectory(siteRoot, tempDir);
  const bundlePath = path.join(bundleDir, `${site.slug}.tgz`);
  execFileSync('tar', ['-czf', bundlePath, '-C', tempDir, '.'], {
    stdio: 'ignore',
  });
  fs.rmSync(tempDir, { recursive: true, force: true });
  return bundlePath;
}

function copyDirectory(sourceDir: string, targetDir: string) {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.readdirSync(sourceDir, { withFileTypes: true }).forEach((entry) => {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
      return;
    }
    if (entry.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(sourcePath);
      fs.symlinkSync(linkTarget, targetPath);
      return;
    }
    fs.copyFileSync(sourcePath, targetPath);
  });
}

async function requestHerokuJson<T>(url: string, init: {
  method?: string;
  token: string;
  body?: unknown;
}) {
  const headers: Record<string, string> = {
    accept: 'application/vnd.heroku+json; version=3',
    authorization: `Bearer ${init.token}`,
  };
  let body: string | undefined;
  if (typeof init.body !== 'undefined') {
    body = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(url, {
    method: init.method || 'GET',
    headers,
    body,
  });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function slugifyHerokuAppName(value: string) {
  return String(value || 'managed-site')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63) || 'managed-site';
}

export {
  buildHerokuSourceBundle,
  deployManagedSiteToHeroku,
  slugifyHerokuAppName,
};
