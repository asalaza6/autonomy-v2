import type { AutonomyRuntime, FrontendContext } from './runtime-types.js';

export interface FrontendPageProps {
  context: FrontendContext;
  runtime: AutonomyRuntime;
}

/** React function components satisfy this contract; the host owns rendering. */
export type FrontendPage<Rendered = unknown> = (props: FrontendPageProps) => Rendered;

export interface LoadedFrontendPage {
  component: FrontendPage;
  props: FrontendPageProps;
  modulePath: string;
}
