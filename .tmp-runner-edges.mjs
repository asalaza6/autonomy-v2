import { Project } from 'ts-morph';
const project = new Project({ tsConfigFilePath: 'tsconfig.json' });
const sourceFiles = project.getSourceFiles().filter((f)=>f.getFilePath().endsWith('.ts'));
const cwd = process.cwd().replace(/\\/g,'/');
for (const sf of sourceFiles) {
  const from = sf.getFilePath().replace(/\\/g,'/');
  if (!from.includes('/src/autonomy-v2/runner/')) {
    continue;
  }
  const list = sf.getImportDeclarations()
    .map((imp) => imp.getModuleSpecifierSourceFile())
    .filter((m) => Boolean(m))
    .map((m) => m.getFilePath().replace(/\\/g,'/'));
  const relFrom = from.replace(cwd + '/', '');
  if (list.length === 0) {
    console.log(relFrom, 'imports nothing');
    continue;
  }
  console.log(relFrom, '->', list.map((t) => t.replace(cwd + '/','')).sort());
}
