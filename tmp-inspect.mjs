import fs from 'node:fs';
import path from 'node:path';
import { Project } from 'ts-morph';

const project = new Project({ tsConfigFilePath: 'tsconfig.json' });
const selected = [
  'src/autonomy-v2/runner/default-runner.ts',
  'src/server/worker/runtime-core.ts',
  'src/server/orchestrator/runtime-core.ts',
  'src/server/orchestrator/workers-core.ts',
  'src/sync/syncer.ts',
  'src/autonomy-v2/commands/index.ts',
];

const edgeSet = new Map();
for (const sourceFile of project.getSourceFiles()) {
  const sourcePath = path.normalize(sourceFile.getFilePath());
  if (!edgeSet.has(sourcePath)) {
    edgeSet.set(sourcePath, new Set());
  }
  sourceFile.getImportDeclarations().forEach((importDeclaration) => {
    const importedSourceFile = importDeclaration.getModuleSpecifierSourceFile();
    if (!importedSourceFile) {
      return;
    }
    const importedPath = path.normalize(importedSourceFile.getFilePath());
    if (importedPath !== sourcePath) {
      edgeSet.get(sourcePath).add(importedPath);
    }
  });
}

for (const targets of edgeSet.values()) {
  for (const target of targets) {
    if (!edgeSet.has(target)) {
      edgeSet.set(target, new Set());
    }
  }
}

const sortedFiles = Array.from(edgeSet.keys()).sort();
const adjacency = new Map(sortedFiles.map((file) => [file, Array.from(edgeSet.get(file))]));

const indexBy = new Map();
const lowlink = new Map();
const compBy = new Map();
const stack = [];
const onStack = new Set();
let current = 0;
const comps = [];

function connect(file) {
  indexBy.set(file, current);
  lowlink.set(file, current);
  current += 1;
  stack.push(file);
  onStack.add(file);

  for (const target of adjacency.get(file)) {
    if (!indexBy.has(target)) {
      connect(target);
      lowlink.set(file, Math.min(lowlink.get(file), lowlink.get(target)));
    } else if (onStack.has(target)) {
      lowlink.set(file, Math.min(lowlink.get(file), indexBy.get(target)));
    }
  }

  if (lowlink.get(file) === indexBy.get(file)) {
    const members = [];
    while (stack.length > 0) {
      const top = stack.pop();
      if (!top) {
        break;
      }
      onStack.delete(top);
      compBy.set(top, comps.length);
      members.push(top);
      if (top === file) {
        break;
      }
    }
    comps.push(members);
  }
}

for (const file of sortedFiles) {
  if (!indexBy.has(file)) {
    connect(file);
  }
}

const outgoingByComp = new Map();
const incomingByComp = new Map();
for (let i = 0; i < comps.length; i += 1) {
  outgoingByComp.set(i, new Set());
  incomingByComp.set(i, 0);
}

for (const [source, targets] of adjacency) {
  const sourceComp = compBy.get(source);
  for (const target of targets) {
    const targetComp = compBy.get(target);
    if (sourceComp === undefined || targetComp === undefined || sourceComp === targetComp) {
      continue;
    }
    if (!outgoingByComp.get(sourceComp).has(targetComp)) {
      outgoingByComp.get(sourceComp).add(targetComp);
      incomingByComp.set(targetComp, (incomingByComp.get(targetComp) || 0) + 1);
    }
  }
}

const levelByComp = new Map();
let frontier = Array.from(incomingByComp.entries())
  .filter(([, incoming]) => incoming === 0)
  .map(([comp]) => comp)
  .sort((a, b) => a - b);
for (const comp of frontier) {
  levelByComp.set(comp, 0);
}
const remaining = new Map(incomingByComp);

while (frontier.length > 0) {
  const next = [];
  for (const sourceComp of frontier) {
    const sourceLevel = levelByComp.get(sourceComp) || 0;
    for (const targetComp of outgoingByComp.get(sourceComp)) {
      const nextLevel = sourceLevel + 1;
      const current = levelByComp.get(targetComp);
      if (current === undefined || nextLevel > current) {
        levelByComp.set(targetComp, nextLevel);
      }
      const updated = Math.max(0, (remaining.get(targetComp) || 0) - 1);
      remaining.set(targetComp, updated);
      if (updated === 0) {
        next.push(targetComp);
      }
    }
  }
  frontier = [...new Set(next)].sort((a, b) => a - b);
}

const levelByFile = new Map();
for (const [file, comp] of compBy) {
  levelByFile.set(file, levelByComp.get(comp) || 0);
}

for (const file of selected) {
  const absolute = path.resolve(file);
  const level = levelByFile.get(absolute);
  if (level === undefined) {
    console.log(`\n${file} not in graph`);
    continue;
  }
  const rows = [];
  for (const target of edgeSet.get(absolute)) {
    const targetLevel = levelByFile.get(target) || 0;
    const delta = targetLevel - level;
    rows.push([target, targetLevel, delta]);
  }
  const skips = rows.filter(([, , delta]) => delta > 1);
  console.log(`\n${file} depth=${level} total=${rows.length} skip=${skips.length}`);
  for (const [target, , delta] of rows.filter(([, , d]) => d > 1).sort((a, b) => b[2] - a[2])) {
    console.log(`  -> ${path.relative(process.cwd(), target)} delta=${delta}`);
  }
}

let totalEdges = 0;
let totalSkipEdges = 0;
for (const [source, targets] of edgeSet) {
  const sourceDepth = levelByFile.get(source);
  for (const target of targets) {
    totalEdges += 1;
    const delta = (levelByFile.get(target) || 0) - (sourceDepth || 0);
    if (delta > 1) {
      totalSkipEdges += 1;
    }
  }
}
console.log(`\nTotal edges: ${totalEdges}`);
console.log(`Skip edges: ${totalSkipEdges} ratio=${(totalSkipEdges / totalEdges).toFixed(4)}`);
