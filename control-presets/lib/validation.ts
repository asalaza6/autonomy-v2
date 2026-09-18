export type Payload = Record<string, unknown>;
export function object(input: unknown, keys: string[]): Payload {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Action input must be an object.');
  for (const key of Object.keys(input)) if (!keys.includes(key)) throw new Error(`Unknown input field: ${key}`);
  return input as Payload;
}

export function text(input: Payload, key: string, required = true, max = 1000): string {
  const value = input[key];
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > max || value.includes('\0')) throw new Error(`Invalid ${key}.`);
  return value.trim();
}

export function identifier(input: Payload, key: string, required = true) {
  const value = text(input, key, required, 200);
  if (value && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error(`Invalid ${key}.`);
  return value;
}

export function priority(input: Payload, required = true) {
  const value = text(input, 'priority', required);
  if (value && !['highest', 'high', 'normal', 'low'].includes(value)) throw new Error('Invalid priority.');
  return value;
}

