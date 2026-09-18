import type { AutonomyRuntime, FrontendContext } from './runtime-types.js';
import { resolveFrontendConfig, type FrontendPreset } from './config.js';
import type { FrontendPage, LoadedFrontendPage } from './page-contract.js';

/** The host supplies compilation/import and React mounting; this layer has no transport. */
export function createPageLoader(options: {
  runtime: AutonomyRuntime;
  context: FrontendContext;
  configPath: string;
  presets?: Record<string, FrontendPreset>;
  importModule(modulePath: string, options: { revision: number }): Promise<{ default?: unknown }>;
  onPage(page: LoadedFrontendPage): void;
  onError(error: Error): void;
  /** Supply a host watcher for preset files outside the repository. */
  watch?: AutonomyRuntime['watch'];
}) {
  let disposed = false;
  let revision = 0;
  let stopPageWatch: (() => void) | undefined;
  const watch = options.watch || options.runtime.watch.bind(options.runtime);
  const changed = () => { void reload().catch(reportError); };
  const stopConfigWatch = watch([options.configPath], changed);

  function reportError(error: unknown) {
    if (!disposed) options.onError(error instanceof Error ? error : new Error(String(error)));
  }

  async function reload(): Promise<LoadedFrontendPage | null> {
    if (disposed) throw new Error('Frontend page loader is disposed.');
    const currentRevision = ++revision;
    const raw = await options.runtime.readJson(options.configPath);
    if (disposed || currentRevision !== revision) return null;
    const config = resolveFrontendConfig(raw, {
      rootDir: options.context.repository.rootDir,
      presets: options.presets,
    });
    stopPageWatch?.();
    stopPageWatch = watch([config.modulePath], changed);
    const module = await options.importModule(config.modulePath, { revision: currentRevision });
    if (disposed || currentRevision !== revision) return null;
    if (typeof module?.default !== 'function') {
      throw new Error(`Frontend module must default-export a React function component: ${config.modulePath}`);
    }
    const page: LoadedFrontendPage = {
      component: module.default as FrontendPage,
      modulePath: config.modulePath,
      props: {
        runtime: options.runtime,
        context: { ...options.context, preset: config.preset, frontend: config.options },
      },
    };
    options.onPage(page);
    return page;
  }

  return {
    reload,
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      stopConfigWatch();
      stopPageWatch?.();
    },
  };
}
