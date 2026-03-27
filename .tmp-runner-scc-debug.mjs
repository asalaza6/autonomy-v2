import fs from 'node:fs';
const entries = Object.values(JSON.parse(fs.readFileSync('/tmp/autonomy-export-map.json','utf8')));
const targets = new Set([
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/default-runner.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/index.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/gate-support.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/persistence.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/state.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/shared.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/net.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/workspace.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/task-flow.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/gate-flow.ts',
  '/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/constants.ts',
]);
const cwd = '/Users/bytedance/Documents/GitHub/autonomy-v2';
const edges = new Map();
for (const t of targets) {
  edges.set(t, new Set());
}
for (const e of entries) {
  const target = e.exportedFrom;
  for (const importer of e.importedBy) {
    const key = importer;
    if (importer === target) continue;
    if (!targets.has(key) && !targets.has(target)) continue;
    if (targets.has(target)) {
      edges.get(target).add(importer);
    }
    if (targets.has(importer) && !targets.has(target)) {
      edges.get(importer).add(target);
    }
  }
}
for (const [from, tos] of edges) {
  if (tos.size === 0) continue;
  console.log(from.replace(cwd + '/', ''), '->', Array.from(tos).map((p)=>p.replace(cwd + '/', '')).sort());
}
