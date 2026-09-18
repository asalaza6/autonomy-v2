import type { LocalAction } from '../../src/runtime/index.js';
import { randomUUID } from 'node:crypto';
type Context = Parameters<LocalAction['run']>[1];
type RecordData = Record<string, any>;

function workflowPaths(options: RecordData = {}) {
  const specs = String(options.specsDir || 'prompts/autonomous/v2/specs/prds');
  const lifecycle = String(options.lifecycleDir || '.autonomy/runtime/custom-lifecycle');
  return { specs, lifecycle };
}

/** Git policy belongs to this workflow, while IO, processes and locks are runtime facilities. */
async function git(context: Context, args: string[], input?: string, env?: Record<string, string>) {
  const result = await context.runtime.runProcess('git', args, { input, env });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}
async function branch(context: Context) {
  const legacy = await context.runtime.readJson<RecordData>('prompts/autonomous/v2/config/agents.json', {});
  return String(context.options?.integrationBranch || legacy.integrationBranch || 'dev');
}
async function specs(context: Context, includeArchived = false) {
  const { specs: directory } = workflowPaths(context.options);
  const ref = await git(context, ['rev-parse', await branch(context)]);
  const files = await git(context, ['ls-tree', '-r', '--name-only', ref, '--', directory]);
  const result: { file: string; data: RecordData; queued: boolean }[] = [];
  for (const file of files.split('\n').filter(Boolean)) {
    const suffix = file.slice(directory.length + 1);
    if (!suffix.endsWith('.json') || (!includeArchived && suffix.startsWith('archived/'))) continue;
    if (suffix.includes('/') && ! /^(queue|archived)\/[^/]+\.json$/.test(suffix)) continue;
    const data = JSON.parse(await git(context, ['show', `${ref}:${file}`]));
    result.push({ file, data, queued: suffix.startsWith('queue/') });
  }
  return result;
}
export async function listPrds(context: Context) {
  return (await specs(context, true)).map(entry => ({ ...entry.data, queued: entry.queued }));
}
async function commit(context: Context, updates: { file: string; data?: unknown }[], message: string) {
  const { runtime } = context;
  const ref = await branch(context);
  const old = await git(context, ['rev-parse', `refs/heads/${ref}`]);
  const current = (await runtime.runProcess('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'])).stdout.trim();
  if (current === ref) {
    const dirty = await git(context, ['status', '--porcelain', '--', ...updates.map(entry => entry.file)]);
    if (dirty) throw new Error('Commit or discard changes to the affected PRD files first.');
  }
  const index = `.autonomy/runtime/controls/index-${randomUUID()}`;
  await runtime.writeFile(index + '.prepare', '');
  await runtime.removeFile(index + '.prepare');
  const env = { GIT_INDEX_FILE: `${context.rootDir}/${index}` };
  let sha = old;
  try {
    await git(context, ['read-tree', old], undefined, env);
    for (const update of updates) {
      if (update.data === undefined) await git(context, ['update-index', '--force-remove', '--', update.file], undefined, env);
      else {
        const blob = await git(context, ['hash-object', '-w', '--stdin'], JSON.stringify(update.data, null, 2) + '\n');
        await git(context, ['update-index', '--add', '--cacheinfo', '100644', blob, update.file], undefined, env);
      }
    }
    const tree = await git(context, ['write-tree'], undefined, env);
    const oldTree = await git(context, ['rev-parse', `${old}^{tree}`]);
    if (tree !== oldTree) {
      sha = await git(context, ['commit-tree', tree, '-p', old, '-m', message]);
      await git(context, ['update-ref', `refs/heads/${ref}`, sha, old]);
      if (current === ref) {
        for (const update of updates) {
          if (update.data === undefined) { await runtime.removeFile(update.file); await git(context, ['update-index', '--force-remove', '--', update.file]); }
          else { await runtime.writeJson(update.file, update.data); await git(context, ['add', '--', update.file]); }
        }
      }
    }
  } finally { await runtime.removeFile(index); }
  const remote = await runtime.runProcess('git', ['remote', 'get-url', 'origin']);
  const pushed = remote.status === 0 ? await runtime.runProcess('git', ['push', 'origin', ref]) : null;
  context.log(message);
  return { committed: sha !== old, commitSha: sha, pushed: pushed?.status === 0, pushMessage: pushed ? (pushed.stderr || pushed.stdout).trim() : null };
}

export async function executePrdAdd(input: RecordData, context: Context) {
  return context.runtime.withLock(async () => {
    const entries = await specs(context);
    if (entries.some(entry => entry.data.id === input.id)) throw new Error(`PRD "${input.id}" already exists.`);
    const queued = entries.some(entry => !entry.queued);
    const { specs: directory } = workflowPaths(context.options);
    const file = `${directory}/${queued ? 'queue/' : ''}${input.id}.json`;
    const now = new Date().toISOString();
    const data = { schemaVersion: 1, id: input.id, title: input.title, specification: input.specification || '', requirements: input.requirements || [], priority: input.priority || 'normal', createdAt: now, updatedAt: now };
    return { ...data, queued, specPath: file, ...(await commit(context, [{ file, data }], `autonomy(prd): add ${input.id}`)) };
  });
}
export async function executePrdPriorityUpdate(input: RecordData, context: Context) {
  return context.runtime.withLock(async () => {
    const entry = (await specs(context)).find(entry => entry.data.id === input.prdId);
    if (!entry) throw new Error(`Unknown PRD: ${input.prdId}`);
    const data = { ...entry.data, priority: input.priority, updatedAt: new Date().toISOString() };
    return { prdId: input.prdId, priority: input.priority, ...(await commit(context, [{ file: entry.file, data }], `autonomy(prd): prioritize ${input.prdId}`)) };
  });
}
export async function executePrdReset(input: RecordData, context: Context) {
  return context.runtime.withLock(async () => {
    const { runtime } = context;
    const entries = await specs(context);
    const entry = entries.find(entry => entry.data.id === input.prdId);
    if (!entry) return { noop: true, prdId: null, message: 'No matching active or queued PRD exists to reset.' };
    const { specs: directory, lifecycle } = workflowPaths(context.options);
    const now = new Date().toISOString();
    const archived = { ...entry.data, archive: { kind: 'reset', status: 'abandoned', archivedAt: now, reason: input.reason || undefined } };
    const result = await commit(context, [{ file: entry.file }, { file: `${directory}/archived/${input.prdId}.json`, data: archived }], `autonomy(prd): reset ${input.prdId}`);
    // The same custom lifecycle state is consumed by the agent presets and their stale-work guards.
    const removedTaskIds = new Set<string>();
    for (const file of await runtime.listFiles(`${lifecycle}/queues`)) {
      if (file.type !== 'file' || !file.path.endsWith('.json')) continue;
      const queue = await runtime.readJson<RecordData>(file.path);
      const tasks = (queue.tasks || []).map(task => {
        if (String(task.prdId || task.sourcePrdId || '') !== input.prdId) return task;
        removedTaskIds.add(task.id);
        return { ...task, status: 'archived', archivedAt: now, updatedAt: now, staleReason: 'PRD reset' };
      });
      await runtime.writeJson(file.path, { ...queue, tasks });
    }
    const prsPath = `${lifecycle}/state/prs.json`;
    const prs = await runtime.readJson<RecordData>(prsPath, { pullRequests: [] });
    await runtime.writeJson(prsPath, { ...prs, pullRequests: (prs.pullRequests || []).filter(pr => pr.prdId !== input.prdId && !removedTaskIds.has(pr.taskId)) });
    await runtime.writeJson(`${lifecycle}/prd-state/${input.prdId}.json`, { prdId: input.prdId, status: 'archived', archivedAt: now, updatedAt: now });
    return { prdId: input.prdId, queued: entry.queued, resetAt: now, removedTaskIds: [...removedTaskIds], ...result };
  });
}
