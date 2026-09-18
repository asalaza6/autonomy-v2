import type { LocalAction } from '../../src/runtime/index.js';
type Context = Parameters<LocalAction['run']>[1];
const PACKAGE = '@asalaza6/autonomy-v2';

export async function updatePackage(context: Context) {
  return context.runtime.withLock(async () => {
    const { runtime, options = {} } = context;
    const manifest = await runtime.readJson<Record<string, any>>('package.json');
    const files = await runtime.listFiles('.');
    const manager = String(options.packageManager || (manifest.packageManager || '').split('@')[0] || (files.some(file => file.path === 'pnpm-lock.yaml') ? 'pnpm' : files.some(file => file.path === 'yarn.lock') ? 'yarn' : 'npm'));
    if (!['npm', 'pnpm', 'yarn'].includes(manager)) throw new Error(`Unsupported package manager: ${manager}`);
    const args = manager === 'npm' ? ['install', `${PACKAGE}@latest`, '--save-optional'] : ['add', `${PACKAGE}@latest`, '--optional'];
    const result = await runtime.runProcess(manager, args, { timeoutMs: 600000 });
    context.log(result.stdout); context.log(result.stderr);
    if (result.status !== 0) throw new Error(`Package update failed: ${result.stderr || result.stdout}`);
    const installed = await runtime.readJson<Record<string, any>>(`node_modules/${PACKAGE}/package.json`, {});
    const refreshedManifest = await runtime.readJson<Record<string, any>>('package.json');
    let refresh: Record<string, unknown> = { skipped: true, reason: 'not-initialized' };
    const config = await runtime.readJson('prompts/autonomous/v2/config/control-plane.json', null);
    if (config) {
      // Refresh belongs to the newly installed package, which may change its generic scaffold.
      const refreshed = await runtime.runProcess(process.execPath, [`node_modules/${PACKAGE}/dist/bin/autonomy-v2.js`, 'refresh', '--root', context.rootDir, '--json']);
      if (refreshed.status !== 0) throw new Error(`Package installed but refresh failed: ${refreshed.stderr || refreshed.stdout}`);
      refresh = { skipped: false, result: JSON.parse(refreshed.stdout) };
    }
    return { packageName: PACKAGE, packageManager: manager, installedVersion: installed.version || null, newDeclaredVersion: refreshedManifest.optionalDependencies?.[PACKAGE] || null, refresh };
  });
}
