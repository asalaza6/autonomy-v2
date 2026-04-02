import { spawnSync } from 'child_process';
import type { ManagedSiteRecord, ManagedSiteDeployment } from '../../types.js';
import { getManagedSite, getManagedSiteRoot, updateManagedSite } from './manager-store.js';
import { appendManagedSiteLog } from './manager-process.js';

type HerokuAppInfo = {
  app?: {
    id?: string;
    name?: string;
    web_url?: string;
  };
  name?: string;
  web_url?: string;
  id?: string;
};

async function deployManagedSiteToHeroku(rootDir: string, siteId: string, options: {
  appName?: string;
}) {
  const site = getManagedSite(rootDir, siteId);
  if (!site) {
    throw new Error(`Unknown site "${siteId}".`);
  }

  const siteRoot = getManagedSiteRoot(rootDir, site);
  const appName = slugifyHerokuAppName(options.appName || site.slug);
  const herokuCli = resolveCliCommand('AUTONOMY_MANAGER_HEROKU_CLI', 'heroku');
  const gitCli = resolveCliCommand('AUTONOMY_MANAGER_GIT_CLI', 'git');
  const version = String(site.updatedAt || site.createdAt || new Date().toISOString());

  try {
    appendManagedSiteLog(rootDir, siteId, `[manager] deploy started for ${siteId} -> ${appName}\n`);

    const existingApp = readHerokuAppInfo(rootDir, siteId, siteRoot, herokuCli, appName);
    if (existingApp) {
      appendManagedSiteLog(rootDir, siteId, `[manager] found existing Heroku app ${appName}\n`);
      runCliCommand(herokuCli, ['git:remote', '-a', appName], siteRoot, rootDir, siteId);
    } else {
      appendManagedSiteLog(rootDir, siteId, `[manager] creating Heroku app ${appName}\n`);
      runCliCommand(herokuCli, ['create', appName], siteRoot, rootDir, siteId);
    }

    appendManagedSiteLog(rootDir, siteId, `[manager] pushing ${siteId} to Heroku using git push heroku main\n`);
    runCliCommand(gitCli, ['push', 'heroku', 'main'], siteRoot, rootDir, siteId);

    const appInfo = readHerokuAppInfo(rootDir, siteId, siteRoot, herokuCli, appName) || existingApp || {};
    const appUrl = normalizeAppUrl(appInfo, appName);
    const deployment: ManagedSiteDeployment = {
      target: 'heroku',
      status: 'deployed',
      provider: 'heroku',
      appName,
      appUrl,
      version,
      updatedAt: new Date().toISOString(),
    };

    const updatedSite = updateManagedSite(rootDir, siteId, {
      publicUrl: appUrl,
      deployment,
      updatedAt: new Date().toISOString(),
    });
    appendManagedSiteLog(rootDir, siteId, `[manager] deploy complete for ${siteId} -> ${appUrl}\n`);

    return {
      site: updatedSite || site,
      app: appInfo,
      appUrl,
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    const deployment: ManagedSiteDeployment = {
      ...(site.deployment || { status: 'idle' }),
      target: 'heroku',
      status: 'failed',
      provider: 'heroku',
      appName,
      lastError: message,
      updatedAt: new Date().toISOString(),
    };
    const updatedSite = updateManagedSite(rootDir, siteId, {
      deployment,
      updatedAt: new Date().toISOString(),
    });
    appendManagedSiteLog(rootDir, siteId, `[manager] deploy failed for ${siteId}: ${message}\n`);
    throw new Error(message);
  }
}

function readHerokuAppInfo(rootDir: string, siteId: string, cwd: string, herokuCli: string, appName: string) {
  const result = runCliCommand(herokuCli, ['apps:info', '--json', '-a', appName], cwd, rootDir, siteId, {
    allowFailure: true,
  });
  if (result.status !== 0 || !result.stdout.trim()) {
    return null;
  }
  try {
    return JSON.parse(result.stdout) as HerokuAppInfo;
  } catch {
    return null;
  }
}

function runCliCommand(command: string, args: string[], cwd: string, rootDir: string, siteId: string, options: {
  allowFailure?: boolean;
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
    },
  });

  if (result.stdout) {
    appendManagedSiteLog(rootDir, siteId, result.stdout);
  }
  if (result.stderr) {
    appendManagedSiteLog(rootDir, siteId, result.stderr);
  }

  if (!options.allowFailure && result.status !== 0) {
    const errorText = String(result.stderr || result.stdout || `Command failed: ${command} ${args.join(' ')}`);
    throw new Error(errorText.trim());
  }

  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function resolveCliCommand(envName: string, defaultCommand: string) {
  const command = String(process.env[envName] || '').trim();
  return command || defaultCommand;
}

function normalizeAppUrl(appInfo: HerokuAppInfo | null, appName: string) {
  const webUrl = String(appInfo?.app?.web_url || appInfo?.web_url || '').trim();
  return webUrl || `https://${appName}.herokuapp.com`;
}

function slugifyHerokuAppName(value: string) {
  return String(value || 'managed-site')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 63) || 'managed-site';
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export {
  deployManagedSiteToHeroku,
  slugifyHerokuAppName,
};
