import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";

const DEFAULT_TSCONFIG = "tsconfig.json";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_GRAPH_FRONTEND_ENTRY = path.join(
  SCRIPT_DIR,
  "tools",
  "export-graph-app.tsx"
);
let exportGraphFrontendBundlePromise = null;

function parseArgs(argv) {
  const options = {
    format: "json",
    tsconfig: DEFAULT_TSCONFIG,
    input: null,
    output: null,
    relativeTo: process.cwd(),
    minImporters: 0,
    includeOrphans: true,
    focus: null,
    layout: "LR",
    tree: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--format") {
      options.format = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--tsconfig") {
      options.tsconfig = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--input") {
      options.input = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--output") {
      options.output = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--relative-to") {
      options.relativeTo = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--min-importers") {
      options.minImporters = Number.parseInt(requireValue(argv, ++index, arg), 10);
      continue;
    }

    if (arg === "--focus") {
      options.focus = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--layout") {
      options.layout = requireValue(argv, ++index, arg).toUpperCase();
      continue;
    }

    if (arg === "--tree") {
      options.tree = true;
      continue;
    }

    if (arg === "--hide-orphans") {
      options.includeOrphans = false;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.minImporters) || options.minImporters < 0) {
    throw new Error("--min-importers must be a non-negative integer");
  }

  if (!["json", "mermaid", "dot", "html"].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }

  if (!["LR", "RL", "TD", "BT"].includes(options.layout)) {
    throw new Error(`Unsupported layout: ${options.layout}`);
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function printHelp() {
  process.stdout.write(`Usage: node analyze-exports.mjs [options]

Build an export/import map from ts-morph, or render a saved JSON map as a graph.

Options:
  --format <json|mermaid|dot|html>  Output format. Default: json
  --input <file>                    Read an existing JSON export map instead of ts-morph
  --output <file>                   Write output to a file instead of stdout
  --tsconfig <file>                 tsconfig to analyze when --input is not used
  --relative-to <dir>               Base directory for graph labels. Default: cwd
  --focus <text>                    Keep only exports matching the symbol or path substring
  --min-importers <n>               Keep exports with at least n importers
  --hide-orphans                    Remove exports with no importers
  --layout <LR|RL|TD|BT>            Graph direction for Mermaid/DOT. Default: LR
  --tree                            Render a file-level tree (importer -> exported file)
  --help                            Show this help

Examples:
  node analyze-exports.mjs --format json > export-map.json
  node analyze-exports.mjs --input export-map.json --format mermaid --output docs/export-graph.mmd
  node analyze-exports.mjs --format html --focus role-catalog --min-importers 2 --output /tmp/export-graph.html
`);
}

async function buildExportMap(tsconfigPath) {
  const project = new Project({
    tsConfigFilePath: tsconfigPath,
  });

  const result = new Map();

  for (const sourceFile of project.getSourceFiles()) {
    const imports = new Set();
    sourceFile.getImportDeclarations().forEach((importDeclaration) => {
      const importedSourceFile = importDeclaration.getModuleSpecifierSourceFile();
      if (!importedSourceFile) {
        return;
      }

      const importedPath = importedSourceFile.getFilePath();
      if (importedPath !== sourceFile.getFilePath()) {
        imports.add(importedPath);
      }
    });

    const exportedDeclarations = sourceFile.getExportedDeclarations();

    exportedDeclarations.forEach((declarations, name) => {
      const key = `${sourceFile.getFilePath()}::${name}`;

      if (!result.has(key)) {
        result.set(key, {
          name,
          exportedFrom: sourceFile.getFilePath(),
          importedBy: new Set(),
          imports: new Set(imports),
        });
      }

      const entry = result.get(key);

      declarations.forEach((declaration) => {
        const references = declaration.findReferences();

        references.forEach((referenceSymbol) => {
          referenceSymbol.getReferences().forEach((reference) => {
            const filePath = reference.getSourceFile().getFilePath();

            if (filePath !== sourceFile.getFilePath()) {
              entry.importedBy.add(filePath);
            }
          });
        });
      });
    });
  }

  return Array.from(result.values())
    .map((entry) => ({
      name: entry.name,
      exportedFrom: entry.exportedFrom,
      importedBy: Array.from(entry.importedBy).sort(),
      imports: Array.from(entry.imports).sort(),
    }))
    .sort(compareEntries);
}

async function loadExportMap(inputPath) {
  const raw = await fs.readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw);

  return Object.entries(parsed)
    .map(([name, value]) => ({
      name,
      exportedFrom: value.exportedFrom,
      importedBy: Array.from(new Set(value.importedBy ?? [])).sort(),
      imports: Array.from(new Set(value.imports ?? [])).sort(),
    }))
    .sort(compareEntries);
}

function compareEntries(left, right) {
  return (
    left.exportedFrom.localeCompare(right.exportedFrom) ||
    left.name.localeCompare(right.name)
  );
}

function filterEntries(entries, options) {
  const focus = options.focus?.toLowerCase() ?? null;

  return entries.filter((entry) => {
    if (!options.includeOrphans && entry.importedBy.length === 0) {
      return false;
    }

    if (entry.importedBy.length < options.minImporters) {
      return false;
    }

    if (!focus) {
      return true;
    }

    return (
      entry.name.toLowerCase().includes(focus) ||
      entry.exportedFrom.toLowerCase().includes(focus) ||
      entry.importedBy.some((filePath) => filePath.toLowerCase().includes(focus))
    );
  });
}

function buildJson(entries) {
  return JSON.stringify(
    Object.fromEntries(
      entries.map((entry) => [
        entry.name,
        {
          exportedFrom: entry.exportedFrom,
          importedBy: entry.importedBy,
        },
      ])
    ),
    null,
    2
  );
}

function buildGraphContext(entries, options) {
  const exporters = new Map();
  const importerFiles = new Set();
  const exportNodeIds = new Map();
  const importerNodeIds = new Map();

  entries.forEach((entry, entryIndex) => {
    const exportNodeId = `exp_${entryIndex + 1}`;
    exportNodeIds.set(entry, exportNodeId);

    if (!exporters.has(entry.exportedFrom)) {
      exporters.set(entry.exportedFrom, []);
    }

    exporters.get(entry.exportedFrom).push(entry);

    entry.importedBy.forEach((filePath) => {
      importerFiles.add(filePath);
    });
  });

  Array.from(importerFiles)
    .sort()
    .forEach((filePath, fileIndex) => {
      importerNodeIds.set(filePath, `imp_${fileIndex + 1}`);
    });

  const edgeCount = entries.reduce(
    (count, entry) => count + entry.importedBy.length,
    0
  );

  const relativeTo = path.resolve(options.relativeTo);
  const exporterGroups = groupFilesByDirectory(
    relativeTo,
    Array.from(exporters.keys()).sort()
  );
  const importerGroups = groupFilesByDirectory(
    relativeTo,
    Array.from(importerFiles).sort()
  );

  return {
    entries,
    exporters,
    importerFiles: Array.from(importerFiles).sort(),
    exporterGroups,
    importerGroups,
    exportNodeIds,
    importerNodeIds,
    edgeCount,
    relativeTo,
    layout: options.layout,
  };
}

function buildMermaid(entries, options) {
  const context = buildGraphContext(entries, options);
  if (options.tree) {
    return buildMermaidTree(context, options);
  }

  const lines = [
    `%%{init: ${JSON.stringify(buildMermaidInit())}}%%`,
    `%% ${entries.length} exports, ${context.importerFiles.length} importers, ${context.edgeCount} edges`,
    `flowchart ${context.layout}`,
    "classDef exportNode fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#1e3a8a;",
    "classDef importerNode fill:#f8fafc,stroke:#64748b,stroke-width:1px,color:#0f172a;",
  ];

  lines.push('subgraph exporters["Exports"]');
  lines.push("direction TB");

  Array.from(context.exporterGroups.entries()).forEach(([directoryPath, exporterPaths], groupIndex) => {
    const directoryId = `exporter_group_${groupIndex + 1}`;
    lines.push(`subgraph ${directoryId}["${escapeMermaidLabel(directoryPath)}"]`);
    lines.push("direction TB");

    exporterPaths.forEach((exporterPath) => {
      const exporterEntries = context.exporters.get(exporterPath) ?? [];
      const fileSubgraphId = `${directoryId}_file_${sanitizeId(path.basename(exporterPath, path.extname(exporterPath)))}`;
      lines.push(
        `subgraph ${fileSubgraphId}["${escapeMermaidLabel(path.basename(exporterPath))}"]`
      );
      lines.push("direction TB");

      exporterEntries.forEach((entry) => {
        lines.push(`${context.exportNodeIds.get(entry)}["${escapeMermaidLabel(entry.name)}"]`);
      });

      lines.push("end");

      exporterEntries.forEach((entry) => {
        lines.push(`class ${context.exportNodeIds.get(entry)} exportNode;`);
      });
    });

    lines.push("end");
  });

  lines.push("end");

  if (context.importerFiles.length > 0) {
    lines.push('subgraph importers["Importers"]');
    lines.push("direction TB");

    Array.from(context.importerGroups.entries()).forEach(([directoryPath, filePaths], groupIndex) => {
      const directoryId = `importer_group_${groupIndex + 1}`;
      lines.push(
        `subgraph ${directoryId}["${escapeMermaidLabel(directoryPath)}"]`
      );
      lines.push("direction TB");

      filePaths.forEach((filePath) => {
        lines.push(
          `${context.importerNodeIds.get(filePath)}["${escapeMermaidLabel(path.basename(filePath))}"]`
        );
      });

      lines.push("end");
    });

    lines.push("end");

    context.importerFiles.forEach((filePath) => {
      lines.push(`class ${context.importerNodeIds.get(filePath)} importerNode;`);
    });
  }

  entries.forEach((entry) => {
    entry.importedBy.forEach((filePath) => {
      lines.push(`${context.exportNodeIds.get(entry)} --> ${context.importerNodeIds.get(filePath)}`);
    });
  });

  return lines.join("\n");
}

function buildFileDependencyGraph(context) {
  const fileNodeIds = new Map();
  const allFiles = new Set(Array.from(context.exporters.keys()));

  context.importerFiles.forEach((filePath) => {
    allFiles.add(filePath);
  });

  const sortedFiles = Array.from(allFiles).sort();
  const fileById = new Map();
  sortedFiles.forEach((filePath, index) => {
    const fileId = `node_${index + 1}`;
    fileNodeIds.set(filePath, fileId);
    fileById.set(fileId, filePath);
  });

  const edgeSet = new Set();
  const dependenciesByImporter = new Map();
  const edges = [];

  sortedFiles.forEach((filePath) => {
    dependenciesByImporter.set(fileNodeIds.get(filePath), new Set());
  });

  context.entries.forEach((entry) => {
    const targetFile = entry.exportedFrom;
    const targetId = fileNodeIds.get(targetFile);

    if (!targetId) {
      return;
    }

    entry.importedBy.forEach((importerFilePath) => {
      const sourceId = fileNodeIds.get(importerFilePath);
      const edgeId = `${sourceId}=>${targetId}`;

      if (!sourceId || sourceId === targetId || edgeSet.has(edgeId)) {
        return;
      }

      edgeSet.add(edgeId);
      const outgoing = dependenciesByImporter.get(sourceId) ?? new Set();
      outgoing.add(targetId);
      dependenciesByImporter.set(sourceId, outgoing);
      edges.push({ source: sourceId, target: targetId });
    });
  });

  return {
    sortedFiles,
    fileNodeIds,
    fileById,
    dependenciesByImporter,
    edges,
  };
}

function buildMermaidTree(context, selectedFileId = null) {
  const mermaidInit = buildMermaidInit();
  const { sortedFiles, fileNodeIds, fileById, dependenciesByImporter, edges } =
    buildFileDependencyGraph(context);
  const levelByFile = new Map();
  const incomingCounts = new Map();

  const allFileIds = new Set(fileNodeIds.values());
  const visibleFiles = new Set();

  if (selectedFileId && allFileIds.has(selectedFileId)) {
    const queue = [selectedFileId];
    while (queue.length > 0) {
      const sourceId = queue.shift();

      if (visibleFiles.has(sourceId)) {
        continue;
      }

      visibleFiles.add(sourceId);

      const targets = dependenciesByImporter.get(sourceId) ?? new Set();
      for (const targetId of targets) {
        if (!visibleFiles.has(targetId)) {
          queue.push(targetId);
        }
      }
    }
  } else {
    for (const fileId of allFileIds) {
      visibleFiles.add(fileId);
    }
  }

  const filteredEdges = edges.filter(
    ({ source, target }) => visibleFiles.has(source) && visibleFiles.has(target)
  );

  visibleFiles.forEach((fileId) => {
    incomingCounts.set(fileId, 0);
  });

  filteredEdges.forEach(({ target }) => {
    incomingCounts.set(target, (incomingCounts.get(target) ?? 0) + 1);
  });

  let frontier = Array.from(visibleFiles)
    .filter((fileId) => (incomingCounts.get(fileId) ?? 0) === 0)
    .sort();

  frontier.forEach((fileId) => {
    levelByFile.set(fileId, 0);
  });

  const remainingIncoming = new Map(incomingCounts);

  while (frontier.length > 0) {
    const nextFrontier = [];

    frontier.forEach((sourceId) => {
      const sourceLevel = levelByFile.get(sourceId);
      if (sourceLevel === undefined) {
        return;
      }

      const targets = dependenciesByImporter.get(sourceId);
      if (!targets) {
        return;
      }

      for (const targetId of targets) {
        if (!visibleFiles.has(targetId)) {
          continue;
        }

        const nextLevel = sourceLevel + 1;
        const existing = levelByFile.get(targetId);
        if (existing === undefined || nextLevel > existing) {
          levelByFile.set(targetId, nextLevel);
        }

        remainingIncoming.set(
          targetId,
          Math.max(0, (remainingIncoming.get(targetId) ?? 0) - 1)
        );
        if (remainingIncoming.get(targetId) === 0) {
          nextFrontier.push(targetId);
        }
      }
    });

    frontier = [...new Set(nextFrontier)].sort();
  }

  const unresolved = Array.from(visibleFiles).filter((fileId) => !levelByFile.has(fileId));
  if (unresolved.length > 0) {
    let fallbackLevel = 0;
    if (levelByFile.size > 0) {
      fallbackLevel = Math.max(...Array.from(levelByFile.values())) + 1;
    }

    unresolved.forEach((fileId) => {
      levelByFile.set(fileId, fallbackLevel);
      fallbackLevel += 1;
    });
  }

  const visibleFilePaths = Array.from(visibleFiles)
    .map((fileId) => fileById.get(fileId))
    .filter(Boolean)
    .sort();

  const levels = new Map();
  for (const [fileId, level] of levelByFile.entries()) {
    if (!levels.has(level)) {
      levels.set(level, []);
    }

    const filePath = fileById.get(fileId);
    if (!filePath) {
      continue;
    }

    levels.get(level).push(filePath);
  }

  const lines = [
    `%%{init: ${JSON.stringify({
      ...mermaidInit,
      maxEdges: 5000,
      maxTextSize: 1000000,
    })}}%%`,
    `%% ${visibleFilePaths.length} files, ${context.entries.length} exports, ${context.importerFiles.length} importers, ${filteredEdges.length} edges`,
    "flowchart TD",
    "direction TB",
    "classDef fileNode fill:#e2e8f0,stroke:#334155,stroke-width:1px,color:#0f172a;",
    "classDef fileRoot fill:#f8fafc,stroke:#0f172a,stroke-width:1px,color:#0f172a,stroke-dasharray: 3 3;",
  ];

  const sortedLevels = Array.from(levels.keys()).sort((left, right) => left - right);

  sortedLevels.forEach((level) => {
    const levelId = `file_level_${level}`;
    lines.push(`subgraph ${levelId}["Depth ${level}"]`);
    lines.push("direction TB");

    const filesInLevel = levels.get(level) ?? [];
    filesInLevel.sort().forEach((filePath) => {
      const nodeId = fileNodeIds.get(filePath);
      if (!nodeId) {
        return;
      }
      lines.push(`${nodeId}["${escapeMermaidLabel(path.basename(filePath))}"]`);
    });

    lines.push("end");
  });

  visibleFiles.forEach((fileId) => {
    if (levelByFile.get(fileId) === 0) {
      lines.push(`class ${fileId} fileRoot;`);
      return;
    }

    lines.push(`class ${fileId} fileNode;`);
  });

  const sortedEdges = new Set(filteredEdges.map(({ source, target }) => `${source}=>${target}`));
  for (const edgeId of sortedEdges) {
    const [source, target] = edgeId.split("=>");
    if (!source || !target) {
      continue;
    }

    lines.push(`${source} --> ${target}`);
  }

  return lines.join("\n");
}

function buildTreeGridData(context) {
  const graph = buildFileDependencyGraph(context);
  const incomingCounts = new Map();
  const importsByFile = new Map();

  for (const fileId of graph.fileById.keys()) {
    incomingCounts.set(fileId, 0);
  }

  context.entries.forEach((entry) => {
    const filePath = entry.exportedFrom;
    const importedFiles = importsByFile.get(filePath) ?? new Set();
    (entry.imports ?? []).forEach((importedPath) => {
      importedFiles.add(importedPath);
    });
    importsByFile.set(filePath, importedFiles);
  });

  graph.edges.forEach(({ target }) => {
    incomingCounts.set(target, (incomingCounts.get(target) ?? 0) + 1);
  });

  return {
    files: Array.from(graph.fileNodeIds.entries()).map(([filePath, fileId]) => ({
      id: fileId,
      path: filePath,
      label: path.basename(filePath),
      relative: relativeLabel(context.relativeTo, filePath),
      directory: relativeDirLabel(context.relativeTo, filePath),
      imports: Array.from(importsByFile.get(filePath) ?? []).sort(),
    })),
    edges: graph.edges,
    roots: Array.from(incomingCounts.entries())
      .filter(([, incoming]) => incoming === 0)
      .map(([fileId]) => fileId)
    .sort(),
  };
}

function buildReadableGridExport(treePayload, rootFileId = null) {
  if (!treePayload) {
    return null;
  }

  const fileById = new Map(treePayload.files.map((entry) => [entry.id, entry]));
  const allFileIds = new Set(fileById.keys());
  const selectedRootId =
    rootFileId && rootFileId !== "all" && allFileIds.has(rootFileId)
      ? rootFileId
      : treePayload.roots[0] ?? "all";
  const visibleFiles = new Set();

  if (selectedRootId !== "all") {
    const queue = [selectedRootId];
    while (queue.length > 0) {
      const source = queue.shift();
      if (visibleFiles.has(source)) {
        continue;
      }

      visibleFiles.add(source);
      treePayload.edges.forEach(({ source: edgeSource, target }) => {
        if (edgeSource === source && allFileIds.has(target) && !visibleFiles.has(target)) {
          queue.push(target);
        }
      });
    }
  } else {
    allFileIds.forEach((fileId) => {
      visibleFiles.add(fileId);
    });
  }

  const filteredEdges = treePayload.edges.filter(
    ({ source, target }) => visibleFiles.has(source) && visibleFiles.has(target)
  );

  const incomingCounts = new Map();
  visibleFiles.forEach((fileId) => {
    incomingCounts.set(fileId, 0);
  });
  filteredEdges.forEach(({ target }) => {
    incomingCounts.set(target, (incomingCounts.get(target) ?? 0) + 1);
  });

  const levelByFile = new Map();
  let frontier = Array.from(visibleFiles)
    .filter((fileId) => (incomingCounts.get(fileId) ?? 0) === 0)
    .sort();
  frontier.forEach((fileId) => {
    levelByFile.set(fileId, 0);
  });

  const remainingIncoming = new Map(incomingCounts);

  while (frontier.length > 0) {
    const nextFrontier = [];
    frontier.forEach((source) => {
      const sourceLevel = levelByFile.get(source);
      if (sourceLevel === undefined) {
        return;
      }

      treePayload.edges.forEach(({ source: edgeSource, target }) => {
        if (edgeSource !== source || !visibleFiles.has(target)) {
          return;
        }

        const nextLevel = sourceLevel + 1;
        const existing = levelByFile.get(target);
        if (existing === undefined || nextLevel > existing) {
          levelByFile.set(target, nextLevel);
        }

        const updated = Math.max(0, (remainingIncoming.get(target) ?? 0) - 1);
        remainingIncoming.set(target, updated);
        if (updated === 0) {
          nextFrontier.push(target);
        }
      });
    });
    frontier = [...new Set(nextFrontier)].sort();
  }

  const unresolved = Array.from(visibleFiles).filter((fileId) => !levelByFile.has(fileId));
  if (unresolved.length > 0) {
    let fallbackLevel = 0;
    if (levelByFile.size > 0) {
      fallbackLevel = Math.max(...Array.from(levelByFile.values())) + 1;
    }

    unresolved.forEach((fileId) => {
      levelByFile.set(fileId, fallbackLevel);
      fallbackLevel += 1;
    });
  }

  const rows = Array.from(visibleFiles)
    .map((fileId) => {
      const file = fileById.get(fileId);
      if (!file) {
        return null;
      }

      return {
        id: fileId,
        depth: levelByFile.get(fileId) ?? 0,
        file: file.relative,
        name: file.label,
        path: file.path,
        directory: file.directory,
        imports: Array.from(new Set(file.imports ?? [])).sort(),
        importPaths: [],
        exportPaths: [],
        negativeImports: 0,
        negativeExports: 0,
        balance: 0,
        negativeImportFiles: [],
        negativeExportFiles: [],
        balanceFiles: [],
      };
    })
    .filter(Boolean);

  const rowById = new Map(rows.filter(Boolean).map((row) => [row.id, row]));

  rows.forEach((row) => {
    const sourceRow = rowById.get(row.id);
    if (!sourceRow) {
      return;
    }

    (sourceRow.imports ?? []).forEach((importedPath) => {
      const targetRow = rows.find((candidate) => candidate.path === importedPath);
      if (!targetRow) {
        return;
      }

      sourceRow.importPaths.push(targetRow.path);
      targetRow.exportPaths.push(sourceRow.path);

      const currentDepth = sourceRow.depth ?? 0;
      const importDepth = targetRow.depth ?? 0;
      const exportDepth = sourceRow.depth ?? 0;
      const exportedCurrentDepth = targetRow.depth ?? 0;

      if (importDepth < currentDepth) {
        sourceRow.negativeImports += 1;
        sourceRow.negativeImportFiles.push(`(${importDepth}<${currentDepth}) ${targetRow.file}`);
      } else if (exportDepth > exportedCurrentDepth) {
        targetRow.negativeExports += 1;
        targetRow.negativeExportFiles.push(`(${exportDepth}>${exportedCurrentDepth}) ${sourceRow.file}`);
      } else {
        sourceRow.balance += 1;
        sourceRow.balanceFiles.push(targetRow.file);
      }
    });
  });

  const sortedRows = rows
    .map((row) => ({
      id: row.id,
      depth: row.depth,
      file: row.file,
      name: row.name,
      path: row.path,
      directory: row.directory,
      importPaths: Array.from(new Set(row.importPaths)).sort(),
      exportPaths: Array.from(new Set(row.exportPaths)).sort(),
      negativeImports: row.negativeImports,
      negativeExports: row.negativeExports,
      balance: row.balance,
      negativeImportFiles: Array.from(new Set(row.negativeImportFiles)).sort(),
      negativeExportFiles: Array.from(new Set(row.negativeExportFiles)).sort(),
      balanceFiles: Array.from(new Set(row.balanceFiles)).sort(),
    }))
    .sort((left, right) => left.depth - right.depth || left.file.localeCompare(right.file));

  const maxDepth = sortedRows.reduce((max, row) => Math.max(max, row.depth), 0);
  const rootFile = selectedRootId === "all" ? null : fileById.get(selectedRootId) ?? null;

  return {
    columns: [
      { key: "depth", label: "D", name: "Depth" },
      { key: "file", label: "File", name: "File" },
      { key: "negativeImports", label: "NI", name: "Negative imports" },
      { key: "negativeExports", label: "NE", name: "Negative exports" },
      { key: "balance", label: "B", name: "Balance" },
    ],
    root: rootFile
      ? {
          id: rootFile.id,
          path: rootFile.path,
          name: rootFile.label,
          relative: rootFile.relative,
        }
      : null,
    stats: {
      files: sortedRows.length,
      edges: filteredEdges.length,
      maxDepth,
    },
    rows: sortedRows,
  };
}

function buildDot(entries, options) {
  const context = buildGraphContext(entries, options);
  const lines = [
    "digraph ExportImportGraph {",
    `  rankdir=${context.layout};`,
    '  graph [fontname="Helvetica", pad="0.3", nodesep="0.35", ranksep="1.1"];',
    '  node [fontname="Helvetica", fontsize=10];',
    '  edge [color="#64748b"];',
  ];

  Array.from(context.exporterGroups.entries()).forEach(([directoryPath, exporterPaths], groupIndex) => {
    lines.push(`  subgraph cluster_exporter_group_${groupIndex + 1} {`);
    lines.push(`    label="${escapeDotLabel(directoryPath)}";`);
    lines.push('    color="#cbd5e1";');

    exporterPaths.forEach((exporterPath, exporterIndex) => {
      lines.push(`    subgraph cluster_exporter_${groupIndex + 1}_${exporterIndex + 1} {`);
      lines.push(`      label="${escapeDotLabel(path.basename(exporterPath))}";`);
      lines.push('      color="#dbeafe";');

      const exporterEntries = context.exporters.get(exporterPath) ?? [];
      exporterEntries.forEach((entry) => {
        lines.push(
          `      ${context.exportNodeIds.get(entry)} [label="${escapeDotLabel(entry.name)}", shape=box, style="rounded,filled", fillcolor="#dbeafe", color="#2563eb"];`
        );
      });

      lines.push("    }");
    });

    lines.push("  }");
  });

  if (context.importerFiles.length > 0) {
    lines.push("  subgraph cluster_importers {");
    lines.push('    label="Importers";');
    lines.push('    color="#cbd5e1";');

    Array.from(context.importerGroups.entries()).forEach(([directoryPath, filePaths], groupIndex) => {
      lines.push(`    subgraph cluster_importer_group_${groupIndex + 1} {`);
      lines.push(`      label="${escapeDotLabel(directoryPath)}";`);
      lines.push('      color="#e2e8f0";');

      filePaths.forEach((filePath) => {
        lines.push(
          `      ${context.importerNodeIds.get(filePath)} [label="${escapeDotLabel(path.basename(filePath))}", shape=box, style="rounded,filled", fillcolor="#f8fafc", color="#64748b"];`
        );
      });

      lines.push("    }");
    });

    lines.push("  }");
  }

  entries.forEach((entry) => {
    entry.importedBy.forEach((filePath) => {
      lines.push(`  ${context.exportNodeIds.get(entry)} -> ${context.importerNodeIds.get(filePath)};`);
    });
  });

  lines.push("}");

  return lines.join("\n");
}

async function buildHtml(entries, options, treeGridData = null, frontendScriptPath = null) {
  const context = buildGraphContext(entries, options);
  const useTree = Boolean(options.tree);
  const mermaid = useTree ? buildMermaidTree(context) : buildMermaid(entries, options);
  const importerCount = new Set(entries.flatMap((entry) => entry.importedBy)).size;
  const edgeCount = entries.reduce((count, entry) => count + entry.importedBy.length, 0);
  const payload = {
    useTree,
    mermaidDefinition: mermaid,
    mermaidInit: buildMermaidInit(),
    stats: {
      exports: entries.length,
      importers: importerCount,
      edges: edgeCount,
    },
    treeGridData: useTree ? treeGridData ?? buildTreeGridData(context) : null,
  };

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Export Import Graph</title>
  </head>
  <body>
    <div id="app"></div>
    <script>window.__EXPORT_GRAPH_DATA__ = ${escapeScriptJson(JSON.stringify(payload))};</script>
    ${
      frontendScriptPath
        ? `<script src="${escapeHtml(frontendScriptPath)}"></script>`
        : `<script>${(await getExportGraphFrontendBundle()).js}</script>`
    }
  </body>
</html>`;
}

function escapeMermaidLabel(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeDotLabel(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeScriptJson(value) {
  return value.replaceAll("</script>", "<\\/script>").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function relativeLabel(basePath, targetPath) {
  const label = path.relative(basePath, targetPath) || path.basename(targetPath);
  return label.split(path.sep).join("/");
}

function groupFilesByDirectory(basePath, filePaths) {
  const groups = new Map();

  filePaths.forEach((filePath) => {
    const directory = relativeDirLabel(basePath, filePath);
    const existing = groups.get(directory) ?? [];
    existing.push(filePath);
    groups.set(directory, existing);
  });

  return new Map(
    Array.from(groups.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([directory, paths]) => [directory, paths.sort()])
  );
}

function relativeDirLabel(basePath, targetPath) {
  const relativeDirectory = path.relative(basePath, path.dirname(targetPath));
  const normalized = (relativeDirectory || ".").split(path.sep).join("/");
  return normalized;
}

function buildMermaidInit() {
  return {
    htmlLabels: true,
    flowchart: {
      defaultRenderer: "elk",
      useMaxWidth: true,
      nodeSpacing: 12,
      rankSpacing: 28,
      diagramPadding: 4,
      curve: "step",
    },
    elk: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": 28,
      "elk.spacing.nodeNode": 12,
    },
  };
}

function sanitizeId(value) {
  return value.replaceAll(/[^a-zA-Z0-9_]/g, "_");
}

async function writeOutput(outputPath, contents) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, contents, "utf8");
}

async function getExportGraphFrontendBundle() {
  if (!exportGraphFrontendBundlePromise) {
    exportGraphFrontendBundlePromise = (async () => {
      let esbuild;
      try {
        esbuild = await import("esbuild");
      } catch (error) {
        throw new Error(
          "Missing dev dependency 'esbuild'. Run npm install before using --format html."
        );
      }

      const result = await esbuild.build({
        entryPoints: [EXPORT_GRAPH_FRONTEND_ENTRY],
        outfile: "export-graph-app.js",
        bundle: true,
        write: false,
        platform: "browser",
        format: "iife",
        target: ["es2020"],
        jsx: "automatic",
        jsxImportSource: "preact",
        sourcemap: "external",
        sourcesContent: true,
      });
      const outputFiles = result.outputFiles ?? [];
      const jsFile = outputFiles.find((file) => file.path.endsWith(".js"));
      const mapFile = outputFiles.find((file) => file.path.endsWith(".js.map"));
      if (!jsFile) {
        throw new Error("esbuild did not produce a frontend bundle.");
      }
      return {
        js: jsFile.text,
        map: mapFile?.text ?? null,
      };
    })();
  }

  return exportGraphFrontendBundlePromise;
}

function getHtmlAssetPaths(outputPath) {
  if (!outputPath) {
    return null;
  }

  const directory = path.dirname(outputPath);
  const baseName = path.basename(outputPath, path.extname(outputPath));
  const scriptFileName = `${baseName}.app.js`;
  return {
    scriptAbsolutePath: path.join(directory, scriptFileName),
    scriptRelativePath: `./${scriptFileName}`,
    mapAbsolutePath: path.join(directory, `${scriptFileName}.map`),
  };
}

function getTreeGridDataOutputPath(outputPath) {
  if (!outputPath) {
    return null;
  }

  if (/\.html?$/i.test(outputPath)) {
    return outputPath.replace(/\.html?$/i, ".grid.json");
  }

  return `${outputPath}.grid.json`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const entries = filterEntries(
    options.input
      ? await loadExportMap(options.input)
      : await buildExportMap(options.tsconfig),
    options
  );
  const treeGridData =
    options.format === "html" && options.tree
      ? buildTreeGridData(buildGraphContext(entries, options))
      : null;
  const gridExport =
    treeGridData && options.format === "html" && options.tree
      ? buildReadableGridExport(treeGridData)
      : null;
  const treeGridDataOutputPath =
    options.format === "html" && options.tree && options.output
      ? getTreeGridDataOutputPath(options.output)
      : null;

  const htmlAssetPaths =
    options.format === "html" && options.output
      ? getHtmlAssetPaths(options.output)
      : null;

  const output =
    options.format === "json"
      ? buildJson(entries)
      : options.format === "mermaid"
        ? buildMermaid(entries, options)
          : options.format === "dot"
            ? buildDot(entries, options)
          : await buildHtml(
              entries,
              options,
              treeGridData,
              htmlAssetPaths?.scriptRelativePath ?? null
            );

  if (options.output) {
    if (options.format === "html" && htmlAssetPaths) {
      const frontendBundle = await getExportGraphFrontendBundle();
      let scriptContents = frontendBundle.js;
      if (frontendBundle.map) {
        scriptContents = `${scriptContents}\n//# sourceMappingURL=${path.basename(
          htmlAssetPaths.mapAbsolutePath
        )}\n`;
        await writeOutput(htmlAssetPaths.mapAbsolutePath, frontendBundle.map);
      }
      await writeOutput(htmlAssetPaths.scriptAbsolutePath, scriptContents);
    }
    await writeOutput(options.output, output);
    if (gridExport && treeGridDataOutputPath) {
      await writeOutput(treeGridDataOutputPath, `${JSON.stringify(gridExport, null, 2)}\n`);
    }
    process.stdout.write(`${options.output}\n`);
    return;
  }

  process.stdout.write(output);

  if (!output.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

await main();
