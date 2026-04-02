import { renderToHtml } from './control-plane-jsx-runtime/jsx-runtime.js';
import { ControlPlanePage } from './control-plane-page.js';

function buildControlPlaneHtml() {
  return `<!doctype html>${renderToHtml(ControlPlanePage())}`;
}

export {
  buildControlPlaneHtml,
};
