import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { runCodexStructured } from '../codex/cli.js';
import { setCustomAgentEnabledOverride } from '../server/orchestrator/custom-agents.js';
import type { LocalAction } from './runtime-types.js';

export type ActionPreset = 'shared' | 'development' | 'maintenance';
export interface ActionRegistryOptions {
  presets?: ActionPreset[];
  /** Trusted host modules may replace actions; null removes an action. */
  overrides?: Record<string, LocalAction | null>;
}

type Payload = Record<string, unknown>;
type ActionContext = Parameters<LocalAction['run']>[1];
const groups: Record<ActionPreset, string[]> = {
  shared: ['chat:send', 'agent:toggle'],
  development: ['prd:add', 'prd:reset', 'prd:priority', 'deploy'],
  maintenance: ['package:update', 'server:restart'],
};

function object(input: unknown, keys: string[]): Payload {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Action input must be an object.');
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`Unknown input field: ${key}`);
  return input as Payload;
}

function text(input: Payload, key: string, required = true, max = 1000): string {
  const value = input[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max || value.includes('\0')) throw new Error(`Invalid ${key}.`);
  return value.trim();
}

function identifier(input: Payload, key: string, required = true) {
  const value = text(input, key, required, 200);
  if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error(`Invalid ${key}.`);
  return value;
}

function priority(input: Payload, required = true) {
  const value = text(input, 'priority', required);
  if (value && !['highest', 'high', 'normal', 'low'].includes(value)) throw new Error('Invalid priority.');
  return value;
}

/** Validation is also applied by the worker before its fixed dispatch. */
export function validateLocalAction(name: string, input: unknown): Payload {
  switch (name) {
    case 'chat:send': {
      const data = object(input, ['message', 'threadId']);
      return { message: text(data, 'message', true, 20000), threadId: identifier(data, 'threadId', false) || randomUUID() };
    }
    case 'agent:toggle': {
      const data = object(input, ['agentKey', 'enabled']);
      if (typeof data.enabled !== 'boolean') throw new Error('enabled must be a boolean.');
      return { agentKey: text(data, 'agentKey'), enabled: data.enabled };
    }
    case 'prd:add': {
      const data = object(input, ['id', 'title', 'specification', 'requirements', 'priority']);
      const specification = text(data, 'specification', false, 100000);
      const requirements = data.requirements ?? [];
      if (!Array.isArray(requirements) || requirements.length > 100 || requirements.some((value) => typeof value !== 'string' || !value.trim() || value.length > 10000 || value.includes('\0'))) throw new Error('Invalid requirements.');
      if (!specification && requirements.length === 0) throw new Error('Provide a specification or requirements.');
      return { id: identifier(data, 'id'), title: text(data, 'title'), specification, requirements, priority: priority(data, false) };
    }
    case 'prd:reset': {
      const data = object(input, ['prdId', 'reason']);
      return { prdId: identifier(data, 'prdId'), reason: text(data, 'reason', false, 10000) };
    }
    case 'prd:priority': {
      const data = object(input, ['prdId', 'priority', 'reason']);
      return { prdId: identifier(data, 'prdId'), priority: priority(data), reason: text(data, 'reason', false, 10000) };
    }
    case 'deploy': case 'package:update': case 'server:restart': return object(input, []);
    default: throw new Error(`Unknown action: ${name}`);
  }
}

function runCommand(name: string, input: Payload, context: ActionContext): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./action-worker.js', import.meta.url))], {
      cwd: context.rootDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-1048576); context.log(data.toString()); });
    child.stderr.on('data', (data: Buffer) => context.log(data.toString()));
    child.once('error', reject);
    child.stdin.on('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) return reject(new Error(`${name} failed (${signal || code}). See operation logs.`));
      try { resolve(JSON.parse(output)); } catch { resolve({ output: output.trim() }); }
    });
    child.stdin.end(JSON.stringify({ name, input, rootDir: context.rootDir }));
  });
}

interface ChatMessage { role: 'user' | 'assistant'; text: string; createdAt: string }
interface ChatThread { id: string; messages: ChatMessage[]; updatedAt: string }

function chatPath(root: string, id: string) {
  const rootDir = fs.realpathSync(root);
  let directory = rootDir;
  for (const segment of ['.autonomy', 'runtime', 'frontend', 'chat']) {
    directory = path.join(directory, segment);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
    const relative = path.relative(rootDir, fs.realpathSync(directory));
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('Chat path is outside the repository.');
  }
  const file = path.join(directory, `${id}.json`);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Chat history cannot be a symlink.');
  return file;
}

async function sendChat(input: Payload, context: ActionContext, codex: typeof runCodexStructured) {
  const file = chatPath(context.rootDir, String(input.threadId));
  const existing: ChatThread = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id: String(input.threadId), messages: [], updatedAt: '' };
  const messages = Array.isArray(existing.messages) ? existing.messages.slice(-39) : [];
  const userMessage: ChatMessage = { role: 'user', text: String(input.message), createdAt: new Date().toISOString() };
  context.log(`Reading repository context for chat ${input.threadId}.`);
  const response = await codex({
    cwd: context.rootDir,
    readOnly: true,
    sandboxMode: 'read-only',
    schema: { type: 'object', additionalProperties: false, properties: { reply: { type: 'string' } }, required: ['reply'] },
    prompt: ['You are the local assistant for this repository. Answer the user using relevant repository files. Do not modify files or run mutating commands. No particular workflow is assumed.', 'Conversation:', JSON.stringify([...messages, userMessage])].join('\n\n'),
  });
  if (typeof response?.reply !== 'string') throw new Error('Chat returned no reply.');
  const thread: ChatThread = {
    id: String(input.threadId),
    messages: [...messages, userMessage, { role: 'assistant' as const, text: response.reply.slice(0, 20000), createdAt: new Date().toISOString() }].slice(-40),
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(thread));
  fs.renameSync(temporary, file);
  context.log('Reply saved.');
  return thread;
}

export function createActionRegistry(options: ActionRegistryOptions = {}, dependencies: { codex?: typeof runCodexStructured } = {}): Record<string, LocalAction> {
  const registry: Record<string, LocalAction> = {};
  for (const preset of options.presets ?? ['shared']) {
    if (!Object.hasOwn(groups, preset)) throw new Error(`Unknown action preset: ${preset}`);
    for (const name of groups[preset]) {
      registry[name] = {
        validate: (input) => validateLocalAction(name, input),
        lockKey: name === 'chat:send' ? 'chat' : 'repository-mutation',
        run: (input: Payload, context) => {
          if (name === 'chat:send') return sendChat(input, context, dependencies.codex || runCodexStructured);
          if (name === 'agent:toggle') {
            const result = setCustomAgentEnabledOverride(context.rootDir, String(input.agentKey), input.enabled === true);
            context.log(`${input.agentKey}: ${input.enabled ? 'enabled' : 'disabled'}`);
            return result;
          }
          return runCommand(name, input, context);
        },
      };
    }
  }
  for (const [name, action] of Object.entries(options.overrides || {})) {
    if (action === null) delete registry[name];
    else registry[name] = action;
  }
  return registry;
}
