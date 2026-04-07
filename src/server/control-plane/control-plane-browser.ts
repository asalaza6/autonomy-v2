import { renderToHtml } from './control-plane-jsx-runtime/jsx-runtime.js';
import { ControlPlanePage } from './control-plane-page.js';

function buildControlPlaneHtml(options: { devMode?: boolean; devToken?: string } = {}) {
  const devMode = options.devMode === true;
  const devToken = JSON.stringify(String(options.devToken || ''));
  const devBootstrap = `<script>window.__AUTONOMY_CONTROL_PLANE_DEV__=${devMode ? 'true' : 'false'};window.__AUTONOMY_CONTROL_PLANE_DEV_TOKEN__=${devToken};</script>`;
  return `<!doctype html>${renderToHtml(ControlPlanePage()).replace('</head>', `${devBootstrap}</head>`)}`;
}

export {
  buildControlPlaneHtml,
};
