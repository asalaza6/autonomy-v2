import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFrontendRuntime } from '../../src/frontend/configured-runtime.js';
import { resolveFrontendConfig } from '../../src/frontend/config.js';
import { createActionRegistry } from '../../src/frontend/actions.js';

function fixture(t: { after(fn: () => void): void }) {
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'control-presets-')));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const write = (name: string, data: string | object) => fs.writeFileSync(path.join(rootDir, name), typeof data === 'string' ? data : JSON.stringify(data));
  return { rootDir, write };
}

test('repository-only controls load their own worker actions and pass file options', async (t) => {
  const { rootDir, write } = fixture(t);
  write('actions.mjs', `export const execution = 'worker'; export default { 'game:run': {
    validate(input) { if (typeof input.value !== 'number') throw Error('value required'); return {value:input.value}; },
    lockKey: 'game', async run(input, context) { await context.runtime.writeJson('game-result.json', input); const result = await context.runtime.runProcess(process.execPath, ['-e', 'process.stdout.write("ready")']); if (result.stdout !== 'ready') throw Error('Process failed'); context.log('game worker'); return {total:input.value + context.options.offset, root:context.rootDir}; }
  } };`);
  write('options.json', { offset: 3 });
  const config = { controls: { actions: './actions.mjs', frontend: './frontend.tsx', options: './options.json' } };
  write('config.json', config);
  const { runtime } = await createFrontendRuntime({ rootDir, configPath: 'config.json' });
  t.after(() => runtime.dispose());
  await assert.rejects(() => runtime.runAction('chat:send', {}), /Unknown action/);
  await assert.rejects(() => runtime.runAction('game:run', { value: 'bad' }), /value required/);
  const operation = await runtime.runAction('game:run', { value: 4, modulePath: 'ignored' });
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await runtime.getOperation(operation.id);
    if (result.status !== 'running') {
      assert.equal(result.status, 'success', result.error);
      assert.deepEqual(result.result, { total: 7, root: rootDir });
      assert.match(result.logs.join(''), /game worker/);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(rootDir, 'game-result.json'), 'utf8')), { value: 4 });
      const page = resolveFrontendConfig(config, { rootDir });
      assert.equal(page.modulePath, path.join(rootDir, 'frontend.tsx'));
      assert.deepEqual(page.options, { offset: 3 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Worker did not finish');
});

test('preset defaults and per-file overrides use the same definition and replace actions', async (t) => {
  const { rootDir, write } = fixture(t);
  write('config.json', { controls: { preset: 'development' } });
  const preset = await createFrontendRuntime({ rootDir, configPath: 'config.json' });
  t.after(() => preset.runtime.dispose());
  assert.deepEqual(preset.controls.options, {});
  assert.match(preset.controls.actions, /control-presets\/development\/actions.js$/);
  write('own.mjs', 'export default { custom: { validate: input => input, run: (input, context) => context.options } };');
  write('own.json', { custom: true });
  write('config.json', { controls: { preset: 'development', actions: 'own.mjs', options: 'own.json', frontend: 'own.tsx' } });
  const own = await createFrontendRuntime({ rootDir, configPath: 'config.json' });
  t.after(() => own.runtime.dispose());
  await assert.rejects(() => own.runtime.runAction('prd:add', {}), /Unknown action/);
  assert.deepEqual(own.controls.options, { custom: true });
  assert.equal(own.controls.frontend, path.join(rootDir, 'own.tsx'));
});

test('host loader supports TypeScript actions inline and rejects TypeScript worker modules', async () => {
  const definition = { default: { custom: { validate: (input: unknown) => input, run: (_input: unknown, context) => context.options } } };
  const registry = await createActionRegistry({ modules: [{ path: '/repo/actions.ts', options: { n: 1 } }], importModule: async () => definition });
  assert.deepEqual(await registry.custom.run({}, { rootDir: '/repo', runtime: {} as any, log() {} }), { n: 1 });
  await assert.rejects(() => createActionRegistry({ modules: [{ path: '/repo/actions.ts' }] }), /host importModule/);
  await assert.rejects(() => createActionRegistry({ modules: [{ path: '/repo/actions.ts' }], importModule: async () => ({ ...definition, execution: 'worker' }) }), /compiled JavaScript/);
});


test('page loader reloads repository options and supports an actual repository-only React component', async t => {
  const { rootDir, write } = fixture(t);
  write('options.json', { title: 'First' });
  write('page.mjs', 'export default function Page({options}) { return options.title; }');
  write('config.json', { controls: { frontend: 'page.mjs', options: 'options.json' } });
  const instance = await createFrontendRuntime({ rootDir, configPath: 'config.json' });
  t.after(() => instance.runtime.dispose());
  await assert.rejects(() => instance.runtime.runAction('agent:toggle', {}), /Unknown action/);
  const { createPageLoader } = await import('../../src/frontend/page-loader.js');
  const { pathToFileURL } = await import('node:url');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const watches = new Map<string, () => void>();
  const pages = [];
  const loader = createPageLoader({ ...instance,
    watch(paths, callback) { for (const file of paths) watches.set(file, () => callback(file)); return () => { for (const file of paths) watches.delete(file); }; },
    importModule: file => import(pathToFileURL(file).href), onPage: page => pages.push(page), onError(error) { throw error; },
  });
  t.after(() => loader.dispose());
  await loader.reload();
  assert.equal(renderToStaticMarkup(createElement(pages[0].component, pages[0].props)), 'First');
  write('options.json', { title: 'Updated' });
  watches.get(path.join(rootDir, 'options.json'))();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renderToStaticMarkup(createElement(pages.at(-1).component, pages.at(-1).props)), 'Updated');
});
