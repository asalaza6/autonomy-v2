import { renderToHtml } from './control-plane-jsx-runtime/jsx-runtime.js';
import { ControlPlaneMissingEntrancePage, ControlPlanePage } from './control-plane-page.js';

function buildControlPlaneHtml(props: {
  entrance: 'manager' | 'project';
  repoId?: string;
  devMode?: boolean;
  devToken?: string;
}) {
  const devMode = props.devMode === true;
  const devToken = JSON.stringify(String(props.devToken || ''));
  const devBootstrap = `<script>window.__AUTONOMY_CONTROL_PLANE_DEV__=${devMode ? 'true' : 'false'};window.__AUTONOMY_CONTROL_PLANE_DEV_TOKEN__=${devToken};</script>`;
  return `<!doctype html>${renderToHtml(ControlPlanePage(props)).replace('</head>', `${devBootstrap}</head>`)}`;
}

function buildControlPlaneMissingEntranceHtml() {
  return `<!doctype html>${renderToHtml(ControlPlaneMissingEntrancePage())}`;
}

export {
  buildControlPlaneHtml,
  buildControlPlaneMissingEntranceHtml,
};
