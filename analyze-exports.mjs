import { Project } from "ts-morph";

const project = new Project({
  tsConfigFilePath: "tsconfig.json",
});

const result = {};

for (const sourceFile of project.getSourceFiles()) {
  const exports = sourceFile.getExportedDeclarations();

  exports.forEach((decls, name) => {
    if (!result[name]) {
      result[name] = {
        exportedFrom: sourceFile.getFilePath(),
        importedBy: new Set(),
      };
    }

    decls.forEach((decl) => {
      const refs = decl.findReferences();

      refs.forEach(ref => {
        ref.getReferences().forEach(r => {
          const file = r.getSourceFile().getFilePath();

          // skip self-reference in export file
          if (file !== sourceFile.getFilePath()) {
            result[name].importedBy.add(file);
          }
        });
      });
    });
  });
}

// clean output
const output = Object.fromEntries(
  Object.entries(result).map(([k, v]) => [
    k,
    {
      exportedFrom: v.exportedFrom,
      importedBy: Array.from(v.importedBy),
    },
  ])
);

console.log(JSON.stringify(output, null, 2));
