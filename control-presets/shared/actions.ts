import { randomUUID } from 'node:crypto';
import type { LocalAction, ActionCapabilities } from '../../src/runtime/index.js';
import { object, text, identifier, type Payload } from '../lib/validation.js';
type Context = Parameters<LocalAction['run']>[1];

async function sendChat(input: Payload, context: Context, executeModel: ActionCapabilities['executeModel']) {
  const file = `.autonomy/runtime/frontend/chat/${input.threadId}.json`;
  const existing = await context.runtime.readJson<{ messages?: { role: string; text: string; createdAt: string }[] }>(file, {});
  const messages = Array.isArray(existing.messages) ? existing.messages.slice(-39) : [];
  const userMessage = { role: 'user', text: String(input.message), createdAt: new Date().toISOString() };
  context.log(`Reading repository context for chat ${input.threadId}.`);
  const response = await executeModel({
    cwd: context.rootDir, readOnly: true, sandboxMode: 'read-only',
    schema: { type: 'object', additionalProperties: false, properties: { reply: { type: 'string' } }, required: ['reply'] },
    prompt: ['You are the local assistant for this repository. Answer the user using relevant repository files. Do not modify files or run mutating commands. No particular workflow is assumed.', 'Conversation:', JSON.stringify([...messages, userMessage])].join('\n\n'),
  });
  if (typeof response.reply !== 'string') throw new Error('Model did not return a reply.');
  const thread = { id: String(input.threadId), messages: [...messages, userMessage, { role: 'assistant', text: response.reply.slice(0, 20000), createdAt: new Date().toISOString() }].slice(-40), updatedAt: new Date().toISOString() };
  await context.runtime.writeJson(file, thread);
  context.log('Reply saved.'); return thread;
}
export function createActions(dependencies: { codex?: ActionCapabilities['executeModel'] } = {}): Record<string, LocalAction> {
  return {
    'chat:send': {
      validate(input) { const data = object(input, ['message', 'threadId']); return { message: text(data, 'message', true, 20000), threadId: identifier(data, 'threadId', false) || randomUUID() }; },
      lockKey: 'chat', run: (input: Payload, context) => sendChat(input, context, dependencies.codex || context.capabilities.executeModel),
    },
    'agent:toggle': {
      validate(input) { const data = object(input, ['agentKey', 'enabled']); if (typeof data.enabled !== 'boolean') throw new Error('enabled must be a boolean.'); return { agentKey: text(data, 'agentKey'), enabled: data.enabled }; },
      lockKey: 'repository-mutation',
      run(input: Payload, context) { const result = context.capabilities.setAgentEnabled(String(input.agentKey), input.enabled === true); context.log(`${input.agentKey}: ${input.enabled ? 'enabled' : 'disabled'}`); return result; },
    },
  };
}
export default createActions();
