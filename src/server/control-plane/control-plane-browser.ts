import { renderToHtml } from './control-plane-jsx-runtime/jsx-runtime.js';
import { ControlPlaneMissingEntrancePage, ControlPlanePage } from './control-plane-page.js';

function buildControlPlaneHtml(props: {
  entrance: 'manager' | 'project';
  repoId?: string;
}) {
  return `<!doctype html>${renderToHtml(ControlPlanePage(props))}`;
}

function buildControlPlaneMissingEntranceHtml() {
  return `<!doctype html>${renderToHtml(ControlPlaneMissingEntrancePage())}`;
}

export {
  buildControlPlaneHtml,
  buildControlPlaneMissingEntranceHtml,
};
