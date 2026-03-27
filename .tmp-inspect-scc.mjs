import { Project } from 'ts-morph';
const project = new Project({ tsConfigFilePath: 'tsconfig.json' });
const sourceFiles = project.getSourceFiles().filter((f) => f.getFilePath().endsWith('.ts'));
const fileEdges = new Map();
for (const sf of sourceFiles) {
  const from = sf.getFilePath();
  const targets = new Set();
  sf.getImportDeclarations().forEach((imp) => {
    const s = imp.getModuleSpecifierSourceFile();
    if (!s || s.getFilePath() === from) {
      return;
    }
    targets.add(s.getFilePath().replace(/\\/g, '/'));
  });
  if (targets.size > 0) {
    fileEdges.set(from.replace(/\\/g, '/'), Array.from(targets));
  }
}
for (const [from, tos] of fileEdges) {
  if (from.includes('/src/server/orchestrator/') || from.includes('/src/autonomy-v2/runner/')) {
    console.log(from.replace(process.cwd().replace(/\\/g, '/') + '/', ''));
    console.log('  ->', tos.map((t) => t.replace(process.cwd().replace(/\\/g, '/') + '/', '')));
  }
}
