import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import type { ManagedSiteContent, ManagedSiteRecord } from '../../types.js';

function getPackageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../');
}

function getPackageVersion() {
  try {
    const packageJsonPath = path.join(getPackageRoot(), 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return String(packageJson.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}


function buildManagedSiteFiles(site: ManagedSiteRecord & { content?: ManagedSiteContent }) {
  const autonomyVersion = `^${getPackageVersion()}`;
  return {
    'package.json': `${JSON.stringify({
      name: site.slug,
      private: true,
      type: 'module',
      version: '0.0.0',
      engines: {
        node: '>=20',
      },
      dependencies: {
        '@asalaza6/autonomy-v2': autonomyVersion,
      },
    }, null, 2)}\n`,
  };
}

function buildDefaultSiteContent(site: ManagedSiteRecord): ManagedSiteContent {
  return {
    title: site.name,
    headline: site.name,
    description: site.description || 'Managed site created by the Autonomy v2 manager.',
    body: 'This site is running locally under the manager and can also be published to Heroku.',
    footer: 'Autonomy v2 managed site',
    accent: '#245b75',
  };
}

async function compileManagedSite(rootDir: string, site: ManagedSiteRecord) {
  return path.resolve(rootDir, site.siteDir);
}

function initializeManagedSiteRepository(siteRoot: string) {
  if (fs.existsSync(path.join(siteRoot, '.git'))) {
    return readManagedSiteRepositoryBranch(siteRoot);
  }

  try {
    execFileSync('git', ['init', '-b', 'main'], {
      cwd: siteRoot,
      stdio: 'ignore',
    });
  } catch {
    execFileSync('git', ['init'], {
      cwd: siteRoot,
      stdio: 'ignore',
    });
    try {
      execFileSync('git', ['checkout', '-b', 'main'], {
        cwd: siteRoot,
        stdio: 'ignore',
      });
    } catch {
      // Keep the default branch if the local git version is older.
    }
  }

  execFileSync('git', ['config', 'user.name', 'Autonomy v2'], {
    cwd: siteRoot,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.email', 'autonomy@example.com'], {
    cwd: siteRoot,
    stdio: 'ignore',
  });
  return readManagedSiteRepositoryBranch(siteRoot);
}

function installManagedSiteDependencies(siteRoot: string) {
  execFileSync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: siteRoot,
    stdio: 'ignore',
  });
}

function runManagedSiteAutonomyInit(siteRoot: string) {
  execFileSync('npx', ['autonomy-v2', 'init', '--root', '.'], {
    cwd: siteRoot,
    stdio: 'ignore',
  });
}

function commitManagedSiteRepository(siteRoot: string, message = 'Initial site bootstrap') {
  execFileSync('git', ['add', '.'], {
    cwd: siteRoot,
    stdio: 'ignore',
  });
  execFileSync('git', ['commit', '-m', message], {
    cwd: siteRoot,
    stdio: 'ignore',
  });
  return readManagedSiteRepositoryBranch(siteRoot);
}

function readManagedSiteRepositoryBranch(siteRoot: string) {
  try {
    const branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: siteRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return branch || 'main';
  } catch {
    return 'main';
  }
}

async function scaffoldManagedSite(rootDir: string, site: ManagedSiteRecord & { content?: ManagedSiteContent }) {
  const siteRoot = path.resolve(rootDir, site.siteDir);
  fs.mkdirSync(siteRoot, { recursive: true });
  const files = buildManagedSiteFiles(site);
  Object.entries(files).forEach(([relativePath, contents]) => {
    const filePath = path.join(siteRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents, 'utf8');
  });
  initializeManagedSiteRepository(siteRoot);
  return siteRoot;
}

export {
  buildDefaultSiteContent,
  buildManagedSiteFiles,
  compileManagedSite,
  commitManagedSiteRepository,
  initializeManagedSiteRepository,
  installManagedSiteDependencies,
  readManagedSiteRepositoryBranch,
  scaffoldManagedSite,
  runManagedSiteAutonomyInit,
};
