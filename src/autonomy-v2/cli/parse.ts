import path from 'path';
import { AGENT_ROLES, buildRoleEventName } from '../../agents/role-catalog.js';
import type { CliOptions } from '../types.js';

function parseCli(argv: string[]): { command: string; options: CliOptions } {
  const options: CliOptions = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (typeof next === 'undefined' || next.startsWith('--')) {
        addOption(options, key, true);
      } else {
        addOption(options, key, next);
        index += 1;
      }
      continue;
    }

    positionals.push(token);
  }

  return {
    command: positionals[0] || '',
    options,
  };
}

function isMutatingCommand(command: string) {
  return new Set([
    'init',
    'task:add',
    'task:finish',
    'prd:add',
    'prd:archive-completed',
    'worktree:prepare',
    'pr:record',
    buildRoleEventName(AGENT_ROLES.REVIEW, 'record'),
    'merge',
  ]).has(command);
}

function resolveRootDir(rootOption: string) {
  if (!rootOption) {
    return process.cwd();
  }

  return path.isAbsolute(rootOption)
    ? rootOption
    : path.resolve(process.cwd(), rootOption);
}

function addOption(options: CliOptions, key: string, value: string | boolean) {
  if (Object.prototype.hasOwnProperty.call(options, key)) {
    if (!Array.isArray(options[key])) {
      options[key] = [options[key]];
    }
    options[key].push(value);
    return;
  }

  options[key] = value;
}

export { isMutatingCommand };
export { parseCli };
export { resolveRootDir };
