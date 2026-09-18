import path from 'node:path';
import { resolveControlDefinition } from './control-config.js';

export interface FrontendPreset {
  /** Host-resolvable module reference, e.g. a packaged page's absolute path. */
  frontend: string;
  options?: Record<string, unknown>;
}

export interface ResolvedFrontendConfig {
  modulePath: string;
  optionsPath?: string;
  preset?: string;
  options: Record<string, unknown>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function resolveFrontendConfig(
  value: unknown,
  options: { rootDir: string; presets?: Record<string, FrontendPreset> },
): ResolvedFrontendConfig {
  const config = record(value, 'Frontend configuration');
  if (config.controls !== undefined) {
    const controls = resolveControlDefinition(config.controls, options.rootDir);
    if (!controls.frontend) throw new Error('Configure controls.frontend; this control preset has no page.');
    return { modulePath: controls.frontend, preset: controls.preset, options: controls.options, ...(controls.optionsPath ? { optionsPath: controls.optionsPath } : {}) };
  }
  const presetId = config.frontendPreset;
  if (presetId !== undefined && (typeof presetId !== 'string' || !presetId.trim())) {
    throw new Error('frontendPreset must be a nonempty string.');
  }
  const preset = typeof presetId === 'string' && Object.hasOwn(options.presets || {}, presetId)
    ? options.presets![presetId]
    : undefined;
  if (presetId !== undefined && !preset) throw new Error(`Unknown frontend preset: ${presetId}`);
  const reference = config.frontend ?? preset?.frontend;
  if (typeof reference !== 'string' || !reference.trim() || reference.includes('\0')) {
    throw new Error('Configure frontend with a page module path, or select a registered frontendPreset.');
  }
  // Repository overrides are relative to its root. Preset references belong to the registering host.
  const modulePath = config.frontend !== undefined ? path.resolve(options.rootDir, reference) : reference;
  return {
    modulePath,
    ...(presetId !== undefined ? { preset: presetId as string } : {}),
    options: {
      ...(preset?.options || {}),
      ...(config.frontendOptions === undefined ? {} : record(config.frontendOptions, 'frontendOptions')),
    },
  };
}
