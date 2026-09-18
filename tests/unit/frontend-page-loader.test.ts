import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveFrontendConfig } from '../../src/frontend/config.js';
import { createPageLoader } from '../../src/frontend/page-loader.js';
import type { AutonomyRuntime } from '../../src/frontend/runtime-types.js';
import type { LoadedFrontendPage } from '../../src/frontend/page-contract.js';

test('repository frontend overrides registered preset page and options without changing preset defaults', () => {
  const presets = { workflow: { frontend: '/package/Page.tsx', options: { title: 'Default', compact: true } } };
  assert.deepEqual(resolveFrontendConfig({ frontendPreset: 'workflow', frontend: './ui/Game.tsx', frontendOptions: { title: 'Game' } }, { rootDir: '/repo', presets }), {
    modulePath: '/repo/ui/Game.tsx', preset: 'workflow', options: { title: 'Game', compact: true },
  });
  assert.equal(presets.workflow.options.title, 'Default');
  assert.equal(resolveFrontendConfig({ frontendPreset: 'workflow' }, { rootDir: '/repo', presets }).modulePath, '/package/Page.tsx');
  assert.equal(resolveFrontendConfig({ frontend: './Only.tsx' }, { rootDir: '/repo' }).modulePath, '/repo/Only.tsx');
});

test('frontend config rejects missing pages, unknown presets and malformed options', () => {
  for (const value of [null, [], {}, { frontendPreset: 'missing' }, { frontend: 4 }, { frontend: './Page.tsx', frontendOptions: [] }]) {
    assert.throws(() => resolveFrontendConfig(value, { rootDir: '/repo' }));
  }
});

function fixture() {
  let config: unknown = { frontend: './First.tsx' };
  const subscriptions = new Map<string, () => void>();
  const pages: LoadedFrontendPage[] = [];
  const errors: Error[] = [];
  const watch = (paths: string[], callback: () => void) => {
    paths.forEach(path => subscriptions.set(path, callback));
    return () => paths.forEach(path => subscriptions.delete(path));
  };
  const runtime = { readJson: async () => config, watch } as unknown as AutonomyRuntime;
  return { runtime, subscriptions, pages, errors, setConfig: (value: unknown) => { config = value; } };
}

const context = { repository: { id: 'example', rootDir: '/repo' }, agentKey: 'worker' };

test('loader injects runtime and context, reloads selected page, disposes watches', async () => {
  const f = fixture();
  const versions: number[] = [];
  const component = () => null;
  const loader = createPageLoader({ ...f, context, configPath: 'config.json',
    importModule: async (_path, { revision }) => { versions.push(revision); return { default: component }; },
    onPage: page => f.pages.push(page), onError: error => f.errors.push(error),
  });
  const first = await loader.reload();
  assert.equal(first.props.runtime, f.runtime);
  assert.equal(first.props.context.agentKey, 'worker');
  assert.equal(first.component, component);
  f.setConfig({ frontend: './Second.tsx', frontendOptions: { title: 'Changed' } });
  f.subscriptions.get('config.json')!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pages.at(-1).modulePath, '/repo/Second.tsx');
  assert.deepEqual(f.pages.at(-1).props.context.frontend, { title: 'Changed' });
  assert.equal(f.subscriptions.has('/repo/First.tsx'), false);
  f.subscriptions.get('/repo/Second.tsx')!();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(versions, [1, 2, 3]);
  loader.dispose();
  loader.dispose();
  assert.equal(f.subscriptions.size, 0);
  await assert.rejects(loader.reload(), /disposed/);
});

test('loader rejects invalid exports and reports watched reload failures without dropping last page', async () => {
  const f = fixture();
  let valid = true;
  const loader = createPageLoader({ ...f, context, configPath: 'config.json',
    importModule: async () => ({ default: valid ? () => null : 4 }),
    onPage: page => f.pages.push(page), onError: error => f.errors.push(error),
  });
  await loader.reload();
  valid = false;
  f.subscriptions.get('/repo/First.tsx')!();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.pages.length, 1);
  assert.match(f.errors[0].message, /default-export/);
  loader.dispose();
});

test('stale imports and imports completed after disposal cannot mount', async () => {
  const f = fixture();
  const pending: Array<(value: { default: () => null }) => void> = [];
  const loader = createPageLoader({ ...f, context, configPath: 'config.json',
    importModule: () => new Promise(resolve => pending.push(resolve)),
    onPage: page => f.pages.push(page), onError: error => f.errors.push(error),
  });
  const first = loader.reload();
  await new Promise(resolve => setImmediate(resolve));
  f.setConfig({ frontend: './Second.tsx' });
  const second = loader.reload();
  await new Promise(resolve => setImmediate(resolve));
  pending[1]({ default: () => null });
  await second;
  pending[0]({ default: () => null });
  assert.equal(await first, null);
  assert.deepEqual(f.pages.map(page => page.modulePath), ['/repo/Second.tsx']);
  const third = loader.reload();
  await new Promise(resolve => setImmediate(resolve));
  loader.dispose();
  pending[2]({ default: () => null });
  assert.equal(await third, null);
  assert.equal(f.pages.length, 1);
});
