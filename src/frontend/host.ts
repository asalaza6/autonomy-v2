import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createFrontendRuntime } from './configured-runtime.js';
import { createPageLoader } from './page-loader.js';

/** Launch the packaged local React control panel for any initialized consumer. */
export async function runFrontend(rootDir: string) {
  const require = createRequire(import.meta.url);
  // These are runtime dependencies of the package host, not consumer scripts.
  const { build } = require('esbuild') as typeof import('esbuild');
  const { chromium } = require('playwright') as typeof import('playwright');
  const instance = await createFrontendRuntime({ rootDir });
  let loaded: any;
  const loader = createPageLoader({
    ...instance,
    importModule: (modulePath) => import(pathToFileURL(modulePath).href),
    onPage: page => { loaded = page; },
    onError: error => { throw error; },
  });
  await loader.reload();
  if (!loaded) throw new Error('No frontend page was configured for this repository.');

  const methods = ['readFile', 'readJson', 'listFiles', 'listAgents', 'getAgent', 'listRuns', 'getRun', 'readLogs', 'runAction', 'getOperation'];
  const script = await build({
    stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Page from ${JSON.stringify(loaded.modulePath)};
window.autonomyCallbacks=new Map();let next=0;
const runtime=Object.fromEntries(${JSON.stringify(methods)}.map(name=>[name,(...args)=>window.autonomyCall(name,args)]));
runtime.watch=(paths,callback)=>{const id=++next;window.autonomyCallbacks.set(id,callback);window.autonomyWatch(id,paths);return ()=>{window.autonomyCallbacks.delete(id);window.autonomyUnwatch(id);};};
 createRoot(document.getElementById('root')).render(React.createElement(Page,{runtime,context:${JSON.stringify(loaded.props.context)},options:${JSON.stringify(loaded.props.options)}}));`, resolveDir: rootDir }, bundle: true, write: false, format: 'iife', platform: 'browser'
  });
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const watches = new Map<number, () => void>();
  await page.exposeFunction('autonomyCall', async (name: string, args: unknown[]) => {
    if (!methods.includes(name)) throw new Error(`Unknown runtime method: ${name}`);
    return (instance.runtime as any)[name](...args);
  });
  await page.exposeFunction('autonomyWatch', (id: number, paths: string[]) => {
    watches.set(id, instance.runtime.watch(paths, changed => { void page.evaluate(({ id, changed }) => (window as any).autonomyCallbacks.get(id)?.(changed), { id, changed }).catch(() => {}); }));
  });
  await page.exposeFunction('autonomyUnwatch', (id: number) => { watches.get(id)?.(); watches.delete(id); });
  await page.setContent('<!doctype html><html><head><title>Autonomy control panel</title></head><body><div id="root"></div></body></html>');
  await page.addScriptTag({ content: script.outputFiles[0].text });
  await new Promise<void>(() => {});
}
