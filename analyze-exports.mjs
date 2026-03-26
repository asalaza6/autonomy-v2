import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { Project } from "ts-morph";

const DEFAULT_TSCONFIG = "tsconfig.json";

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
    const exportedDeclarations = sourceFile.getExportedDeclarations();

    exportedDeclarations.forEach((declarations, name) => {
      const key = `${sourceFile.getFilePath()}::${name}`;

      if (!result.has(key)) {
        result.set(key, {
          name,
          exportedFrom: sourceFile.getFilePath(),
          importedBy: new Set(),
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

function buildTreeGraphPayload(context) {
  const graph = buildFileDependencyGraph(context);
  const incomingCounts = new Map();

  for (const fileId of graph.fileById.keys()) {
    incomingCounts.set(fileId, 0);
  }

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
    })),
    edges: graph.edges,
    roots: Array.from(incomingCounts.entries())
      .filter(([, incoming]) => incoming === 0)
      .map(([fileId]) => fileId)
      .sort(),
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

function buildHtml(entries, options, treePayload = null, treePayloadSource = null) {
  const context = buildGraphContext(entries, options);
  const useTree = Boolean(options.tree);
  const mermaid = useTree ? buildMermaidTree(context) : buildMermaid(entries, options);
  const importerCount = new Set(entries.flatMap((entry) => entry.importedBy)).size;
  const edgeCount = entries.reduce((count, entry) => count + entry.importedBy.length, 0);
  const resolvedTreePayload = useTree ? treePayload ?? buildTreeGraphPayload(context) : null;
  const initialRootId =
    resolvedTreePayload && resolvedTreePayload.roots.length > 0 ? resolvedTreePayload.roots[0] : "all";
  const mermaidDefinition = JSON.stringify(mermaid);
  const treePayloadJson = resolvedTreePayload
    ? JSON.stringify(resolvedTreePayload, null, 2)
    : "null";
  const treePayloadSourceJson =
    useTree && treePayloadSource ? JSON.stringify(treePayloadSource) : "null";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Export Import Graph</title>
    <style>
      *, *::before, *::after {
        box-sizing: border-box;
      }

      :root {
        color-scheme: light;
        font-family: "SF Mono", "Menlo", monospace;
        background: #f8fafc;
        color: #0f172a;
      }

      body {
        margin: 0;
        padding: clamp(12px, 2vw, 24px);
        font-family: "Inter", "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(59, 130, 246, 0.08), transparent 30%),
          linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%);
        overflow-x: hidden;
      }

      main {
        width: min(1500px, 100%);
        margin: 0 auto;
      }

      .meta {
        margin-bottom: 16px;
        padding: 12px 14px;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.8);
      }

      .graph-shell {
        padding: 16px;
        border: 1px solid #cbd5e1;
        border-radius: 16px;
        background: white;
        box-shadow: 0 16px 48px rgba(15, 23, 42, 0.08);
        width: 100%;
        overflow: hidden;
      }

      .graph-stage {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 16px;
        align-items: start;
      }

      .graph-shell.tree-mode .graph-stage {
        grid-template-columns: minmax(0, 1fr) 360px;
      }

      .graph-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: flex-start;
        margin-bottom: 12px;
      }

      .graph-toolbar button {
        font: inherit;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        background: #fff;
        color: #0f172a;
        padding: 6px 12px;
        cursor: pointer;
      }

      .graph-toolbar button:hover {
        background: #f8fafc;
      }

      .graph-toolbar span {
        margin-left: auto;
        color: #475569;
        font-size: 12px;
        align-self: center;
      }

      .graph-frame {
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
        overflow-y: auto;
        white-space: nowrap;
        scrollbar-width: thin;
        min-height: 520px;
        max-height: calc(100vh - 240px);
        border: 1px dashed #cbd5e1;
        border-radius: 12px;
        overscroll-behavior-x: contain;
      }

      .analytics-panel {
        border: 1px solid #cbd5e1;
        border-radius: 14px;
        background: #f8fafc;
        padding: 12px;
        max-height: calc(100vh - 240px);
        overflow: auto;
      }

      .analytics-panel h2 {
        margin: 0 0 10px 0;
        font-size: 13px;
        line-height: 1.2;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        color: #334155;
      }

      .analytics-summary {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-bottom: 12px;
      }

      .analytics-chip {
        border: 1px solid #cbd5e1;
        background: white;
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 12px;
        color: #475569;
      }

      .analytics-grid {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr) 72px 72px 56px;
        gap: 4px 6px;
        align-items: center;
      }

      .analytics-head {
        font-size: 11px;
        font-weight: 700;
        color: #64748b;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding-bottom: 6px;
        border-bottom: 1px solid #cbd5e1;
        margin-bottom: 2px;
      }

      .analytics-sort {
        appearance: none;
        border: 0;
        background: transparent;
        padding: 0 0 8px 0;
        text-align: left;
        cursor: pointer;
        position: relative;
      }

      .analytics-sort .analytics-tooltip {
        position: absolute;
        left: 0;
        top: calc(100% + 8px);
        z-index: 20;
        display: none;
        min-width: 180px;
        max-width: 260px;
        padding: 10px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 16px 32px rgba(15, 23, 42, 0.16);
        text-transform: none;
        letter-spacing: normal;
        font-weight: 500;
        white-space: normal;
      }

      .analytics-sort .analytics-tooltip strong {
        display: block;
        margin-bottom: 4px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #334155;
      }

      .analytics-sort:hover,
      .analytics-sort:focus-visible {
        color: #334155;
      }

      .analytics-sort:hover .analytics-tooltip,
      .analytics-sort:focus-visible .analytics-tooltip {
        display: block;
      }

      .analytics-tooltip ul {
        margin: 8px 0 0 0;
        padding: 0 0 0 16px;
      }

      .analytics-tooltip li {
        margin: 0 0 2px 0;
      }

      .analytics-row {
        display: contents;
      }

      .analytics-cell {
        font-size: 11px;
        line-height: 1.15;
        min-width: 0;
      }

      .analytics-depth {
        color: #0f172a;
        font-variant-numeric: tabular-nums;
      }

      .analytics-number {
        color: #0f172a;
        font-variant-numeric: tabular-nums;
        text-align: left;
        padding-left: 2px;
        position: relative;
      }

      .analytics-count {
        display: inline-block;
        min-width: 1ch;
      }

      .analytics-number .analytics-tooltip {
        position: absolute;
        left: 0;
        top: calc(100% + 8px);
        z-index: 20;
        display: none;
        min-width: 180px;
        max-width: 260px;
        padding: 10px 12px;
        border: 1px solid #cbd5e1;
        border-radius: 12px;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 16px 32px rgba(15, 23, 42, 0.16);
        text-transform: none;
        letter-spacing: normal;
        font-weight: 500;
        white-space: normal;
      }

      .analytics-number:hover .analytics-tooltip,
      .analytics-number:focus-within .analytics-tooltip {
        display: block;
      }

      .analytics-file {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #0f172a;
        padding-right: 8px;
      }

      .mermaid-container {
        width: 100%;
        max-width: 100%;
        overflow: visible;
        padding: 4px 0 4px 2px;
        min-width: 100%;
      }

      .mermaid-content {
        transform-origin: top left;
        display: inline-block;
        width: auto;
        min-width: 100%;
        transition: transform 120ms ease;
        overflow: visible;
      }

      .mermaid {
        display: block;
        width: auto;
        max-width: 100% !important;
        overflow: visible;
      }

      .mermaid svg {
        display: block;
        width: auto !important;
        max-width: 100% !important;
        height: auto;
      }

      .root-controls {
        width: 100%;
        overflow-x: auto;
        overflow-y: hidden;
        margin-bottom: 12px;
        padding-bottom: 4px;
      }

      .root-strip {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        white-space: nowrap;
      }

      .root-button {
        border: 1px solid #94a3b8;
        border-radius: 10px;
        padding: 6px 12px;
        background: #fff;
        cursor: pointer;
      }

      .root-button.active {
        background: #e2e8f0;
        border-color: #334155;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      @media (max-width: 720px) {
        body {
          padding: 12px;
        }

        .graph-shell {
          padding: 12px;
          border-radius: 14px;
        }

        .graph-stage {
          grid-template-columns: 1fr;
        }

        .graph-frame {
          min-height: 440px;
          max-height: calc(100vh - 220px);
        }

        .analytics-panel {
          max-height: 360px;
        }

        .graph-toolbar {
          gap: 6px;
        }

        .graph-toolbar button {
          padding: 6px 10px;
        }

        .graph-toolbar span {
          width: 100%;
          margin-left: 0;
          text-align: right;
        }

        .root-controls {
          margin-bottom: 8px;
        }

        .root-strip {
          white-space: normal;
        }
      }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    <script>
      mermaid.initialize({
        startOnLoad: false,
        theme: "neutral",
        maxEdges: 5000,
        maxTextSize: 1000000,
        ...${JSON.stringify(buildMermaidInit())},
      });

      document.addEventListener("DOMContentLoaded", () => {
        if (!window.mermaid) {
          const mermaidDiagram = document.getElementById("mermaidDiagram");
          mermaidDiagram.textContent =
            "Mermaid failed to load. Check network access or open this file in a browser with internet access.";
          return;
        }

        const graphFrame = document.getElementById("graphFrame");
        const mermaidContent = document.getElementById("mermaidContent");
        const mermaidDiagram = document.getElementById("mermaidDiagram");
        const zoomLevel = document.getElementById("zoomLevel");
        const zoomIn = document.getElementById("zoomIn");
        const zoomOut = document.getElementById("zoomOut");
        const zoomReset = document.getElementById("zoomReset");
        const zoomFit = document.getElementById("zoomFit");
        const rootControls = document.getElementById("rootControls");
        const rootButtons = document.getElementById("rootButtons");
        const analyticsPanel = document.getElementById("analyticsPanel");
        const minScale = 0.08;
        const maxScale = Number.POSITIVE_INFINITY;
        const stepScale = 0.1;
        const isTreeMode = ${useTree ? "true" : "false"};
        const treePayloadSource = ${treePayloadSourceJson};
        const embeddedTreePayload = ${treePayloadJson};
        const rootCache = new Map();
        let treePayload = null;
        let fileById = new Map();
        let activeRoot = "${initialRootId}";
        let currentScale = 1;
        let isAutoFit = false;
        let analyticsSort = { key: "depth", direction: "asc" };
        const mermaidDefinition = ${mermaidDefinition};

        function clampScale(value) {
          return Math.min(maxScale, Math.max(minScale, value));
        }

        function getDiagramWidth() {
          const svg = mermaidDiagram.querySelector("svg");
          if (!svg) {
            return 0;
          }
          const renderedWidth = svg.getBoundingClientRect().width || svg.clientWidth || 0;
          if (renderedWidth > 0) {
            return renderedWidth;
          }
          if (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) {
            return svg.viewBox.baseVal.width;
          }
          return 0;
        }

        function getDiagramHeight() {
          const svg = mermaidDiagram.querySelector("svg");
          if (!svg) {
            return 0;
          }
          if (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.height) {
            return svg.viewBox.baseVal.height;
          }
          return svg.getBoundingClientRect().height || svg.clientHeight || 0;
        }

        function renderZoom(level, labelValue = null) {
          const scale = clampScale(level);
          currentScale = scale;
          mermaidContent.style.transform = "scale(" + scale + ")";
          const height = getDiagramHeight();
          if (height > 0) {
            mermaidContent.style.minHeight = Math.ceil(height * scale) + "px";
          }
          zoomLevel.textContent = labelValue === null
            ? Math.round(scale * 100) + "%"
            : labelValue;
        }

        function centerGraphView() {
          if (!graphFrame) {
            return;
          }

          requestAnimationFrame(() => {
            const maxScrollLeft = Math.max(0, graphFrame.scrollWidth - graphFrame.clientWidth);
            const maxScrollTop = Math.max(0, graphFrame.scrollHeight - graphFrame.clientHeight);

            graphFrame.scrollLeft = maxScrollLeft / 2;
            graphFrame.scrollTop = 0;
          });
        }

        function getRenderedNode(nodeId) {
          if (!nodeId || !mermaidDiagram) {
            return null;
          }

          const selectors = [
            "#" + nodeId,
            '[data-id="' + nodeId + '"]',
            '[id="' + nodeId + '"]',
          ];

          for (const selector of selectors) {
            const node = mermaidDiagram.querySelector(selector);
            if (node) {
              return node;
            }
          }

          return null;
        }

        function centerRootNode(rootId) {
          if (!graphFrame) {
            return;
          }

          if (!rootId || rootId === "all") {
            centerGraphView();
            return;
          }

          requestAnimationFrame(() => {
            const node = getRenderedNode(rootId);
            if (!node) {
              centerGraphView();
              return;
            }

            const frameRect = graphFrame.getBoundingClientRect();
            const nodeRect = node.getBoundingClientRect();
            const frameCenterX = frameRect.left + frameRect.width / 2;
            const nodeCenterX = nodeRect.left + nodeRect.width / 2;
            const scale = currentScale || 1;
            const scrollDeltaX = (nodeCenterX - frameCenterX) / scale;

            graphFrame.scrollLeft = Math.max(0, graphFrame.scrollLeft + scrollDeltaX);
            graphFrame.scrollTop = 0;
          });
        }

        function fitToWidth() {
          const diagramWidth = getDiagramWidth();
          if (!diagramWidth || !graphFrame) {
            return;
          }
          const frameWidth = graphFrame.clientWidth - 24;
          const nextScale = Math.min(1, frameWidth / diagramWidth);
          renderZoom(nextScale, "Fit");
          centerRootNode(activeRoot);
          isAutoFit = true;
        }

        async function loadTreePayload() {
          if (treePayloadSource) {
            try {
              const response = await fetch(treePayloadSource, { cache: "no-store" });
              if (!response.ok) {
                throw new Error("HTTP " + response.status);
              }
              return await response.json();
            } catch (error) {
              console.warn("Falling back to embedded tree payload.", error);
            }
          }

          return embeddedTreePayload;
        }

        function escapeMermaidLabel(value) {
          return String(value || "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;");
        }

        function sanitizeId(value) {
          return String(value || "").replaceAll(/[^a-zA-Z0-9_]/g, "_");
        }

        function relativeDirLabel(filePath) {
          const normalizedPath = String(filePath || "").replaceAll(String.fromCharCode(92), "/");
          const segments = normalizedPath.split("/");
          return segments.slice(0, -1).join("/") || ".";
        }

        function groupFilesByDirectory(filePaths) {
          const groups = new Map();
          filePaths.forEach((filePath) => {
            const directory = relativeDirLabel(filePath);
            const existing = groups.get(directory) ?? [];
            existing.push(filePath);
            groups.set(directory, existing);
          });
          return new Map(
            Array.from(groups.entries())
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([directory, files]) => [directory, files.sort()])
          );
        }

        function getFilePath(fileId) {
          if (!treePayload) {
            return fileId;
          }
          const entry = fileById.get(fileId);
          return entry ? entry.path : fileId;
        }

        function getFileName(filePath) {
          const normalizedPath = String(filePath || "").replaceAll(String.fromCharCode(92), "/");
          const segments = normalizedPath.split("/");
          return segments[segments.length - 1] || normalizedPath;
        }

        function compareAnalyticsRows(left, right) {
          const key = analyticsSort.key;
          const direction = analyticsSort.direction === "desc" ? -1 : 1;
          let comparison = 0;

          if (key === "file") {
            comparison =
              left.label.localeCompare(right.label) ||
              left.path.localeCompare(right.path) ||
              left.id.localeCompare(right.id);
          } else {
            comparison = (left[key] ?? 0) - (right[key] ?? 0);
            if (comparison === 0 && key !== "depth") {
              comparison = left.depth - right.depth;
            }
            if (comparison === 0) {
              comparison = left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
            }
          }

          return comparison * direction;
        }

        function buildTreeViewState(rootFileId) {
          if (!treePayload) {
            return null;
          }

          const levelByFile = new Map();
          const visibleFiles = new Set();
          const allFileIds = new Set(treePayload.files.map((entry) => entry.id));

          if (rootFileId && rootFileId !== "all" && allFileIds.has(rootFileId)) {
            const queue = [rootFileId];
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

          const visiblePaths = Array.from(visibleFiles)
            .map(getFilePath)
            .filter(Boolean)
            .sort();

          const fileLookup = new Map(treePayload.files.map((entry) => [entry.path, entry]));
          const levels = new Map();
          for (const [fileId, level] of levelByFile.entries()) {
            if (!levels.has(level)) {
              levels.set(level, []);
            }
            const filePath = getFilePath(fileId);
            if (!filePath) {
              continue;
            }
            levels.get(level).push(filePath);
          }

          const fileRows = Array.from(visibleFiles)
            .map((fileId) => {
              const filePath = getFilePath(fileId);
              if (!filePath) {
                return null;
              }
              return {
                id: fileId,
                path: filePath,
                label: getFileName(filePath),
                depth: levelByFile.get(fileId) ?? 0,
              };
            })
            .filter(Boolean);

          const fileRowById = new Map(fileRows.map((row) => [row.id, row]));
          filteredEdges.forEach(({ source, target }) => {
            const sourceRow = fileRowById.get(source);
            const targetRow = fileRowById.get(target);
            if (!sourceRow || !targetRow) {
              return;
            }

            if (targetRow.depth > sourceRow.depth) {
              sourceRow.negativeImports = (sourceRow.negativeImports ?? 0) + 1;
              targetRow.negativeExports = (targetRow.negativeExports ?? 0) + 1;
              sourceRow.negativeImportFiles = sourceRow.negativeImportFiles ?? [];
              targetRow.negativeExportFiles = targetRow.negativeExportFiles ?? [];
              sourceRow.negativeImportFiles.push(targetRow.path);
              targetRow.negativeExportFiles.push(sourceRow.path);
            } else if (targetRow.depth < sourceRow.depth) {
              sourceRow.negativeExports = (sourceRow.negativeExports ?? 0) + 1;
              targetRow.negativeImports = (targetRow.negativeImports ?? 0) + 1;
              sourceRow.negativeExportFiles = sourceRow.negativeExportFiles ?? [];
              targetRow.negativeImportFiles = targetRow.negativeImportFiles ?? [];
              sourceRow.negativeExportFiles.push(targetRow.path);
              targetRow.negativeImportFiles.push(sourceRow.path);
            } else {
              sourceRow.balance = (sourceRow.balance ?? 0) + 1;
              targetRow.balance = (targetRow.balance ?? 0) + 1;
              sourceRow.balanceFiles = sourceRow.balanceFiles ?? [];
              targetRow.balanceFiles = targetRow.balanceFiles ?? [];
              sourceRow.balanceFiles.push(targetRow.path);
              targetRow.balanceFiles.push(sourceRow.path);
            }
          });

          fileRows.forEach((row) => {
            row.negativeImports = row.negativeImports ?? 0;
            row.negativeExports = row.negativeExports ?? 0;
            row.balance = row.balance ?? 0;
            row.negativeImportFiles = row.negativeImportFiles ?? [];
            row.negativeExportFiles = row.negativeExportFiles ?? [];
            row.balanceFiles = row.balanceFiles ?? [];
          });

          fileRows.sort(compareAnalyticsRows);

          const maxDepth = fileRows.reduce((max, entry) => Math.max(max, entry.depth), 0);

          return {
            levelByFile,
            visibleFiles,
            filteredEdges,
            visiblePaths,
            fileLookup,
            levels,
            fileRows,
            maxDepth,
          };
        }

        function buildTreeMermaid(rootFileId) {
          const state = buildTreeViewState(rootFileId);
          if (!state) {
            return "";
          }

          const { levelByFile, visibleFiles, filteredEdges, visiblePaths, fileLookup, levels } =
            state;

          const lines = [
            "%% " + visiblePaths.length + " files, " + treePayload.files.length + " total files, " + filteredEdges.length + " edges",
            "flowchart TD",
            "direction TB",
            "classDef fileNode fill:#e2e8f0,stroke:#334155,stroke-width:1px,color:#0f172a;",
            "classDef fileRoot fill:#f8fafc,stroke:#0f172a,stroke-width:1px,color:#0f172a,stroke-dasharray: 3 3;",
          ];

          const sortedLevels = Array.from(levels.keys()).sort((left, right) => left - right);
          sortedLevels.forEach((level) => {
            const levelId = "file_level_" + level;
            lines.push("subgraph " + levelId + "[\\\"Depth " + level + "\\\"]");
            lines.push("direction TB");

            const filesInLevel = levels.get(level) ?? [];
            filesInLevel.sort().forEach((filePath) => {
              const fileEntry = fileLookup.get(filePath);
              if (!fileEntry) {
                return;
              }
              const fileName = getFileName(filePath);
              lines.push(fileEntry.id + "[\\\"" + escapeMermaidLabel(fileName) + "\\\"]");
            });

            lines.push("end");
          });

          for (const fileId of visibleFiles) {
            if (levelByFile.get(fileId) === 0) {
              lines.push("class " + fileId + " fileRoot;");
            } else {
              lines.push("class " + fileId + " fileNode;");
            }
          }

          const sortedEdgeIds = new Set(
            filteredEdges.map(({ source, target }) => source + "=>" + target)
          );
          for (const edgeId of Array.from(sortedEdgeIds).sort()) {
            const [source, target] = edgeId.split("=>");
            if (source && target) {
              lines.push(source + " --> " + target);
            }
          }

          return lines.join(String.fromCharCode(10));
        }

        function renderTreeAnalytics(rootFileId) {
          if (!analyticsPanel || !treePayload) {
            return;
          }

          const state = buildTreeViewState(rootFileId);
          if (!state) {
            analyticsPanel.innerHTML = "";
            return;
          }

          const { fileRows, maxDepth, filteredEdges } = state;
          function formatCount(value) {
            return String(value ?? 0);
          }

          function formatTooltipList(files) {
            const uniqueFiles = [...new Set((files ?? []).filter(Boolean))].sort();
            if (uniqueFiles.length === 0) {
              return "<div>None</div>";
            }

            return "<ul>" + uniqueFiles.map((filePath) => "<li>" + escapeMermaidLabel(getFileName(filePath)) + "</li>").join("") + "</ul>";
          }

          function buildTooltip(files) {
            return '<span class="analytics-tooltip">' + formatTooltipList(files) + "</span>";
          }

          const rowsHtml = fileRows
            .map((row) => {
              return (
                '<div class="analytics-cell analytics-depth">' + row.depth + "</div>" +
                '<div class="analytics-cell analytics-file" title="' +
                escapeMermaidLabel(row.path) +
                '">' +
                escapeMermaidLabel(row.label) +
                "</div>" +
                '<div class="analytics-cell analytics-number">' +
                '<span class="analytics-count" title="' +
                escapeMermaidLabel(getFileName(row.path)) +
                '">' +
                formatCount(row.negativeImports) +
                "</span>" +
                buildTooltip(row.negativeImportFiles) +
                "</div>" +
                '<div class="analytics-cell analytics-number">' +
                '<span class="analytics-count" title="' +
                escapeMermaidLabel(getFileName(row.path)) +
                '">' +
                formatCount(row.negativeExports) +
                "</span>" +
                buildTooltip(row.negativeExportFiles) +
                "</div>" +
                '<div class="analytics-cell analytics-number">' +
                '<span class="analytics-count" title="' +
                escapeMermaidLabel(getFileName(row.path)) +
                '">' +
                formatCount(row.balance) +
                "</span>" +
                buildTooltip(row.balanceFiles) +
                "</div>"
              );
            })
            .join("");

          function headerLabel(key, label) {
            const isActive = analyticsSort.key === key;
            const arrow = isActive ? analyticsSort.direction === "asc" ? " ↑" : " ↓" : "";
            return label + arrow;
          }

          function headerButton(key, label, explanation) {
            const titleName = label;
            const tooltip =
              '<span class="analytics-tooltip"><strong>' +
              titleName +
              "</strong>" +
              escapeMermaidLabel(explanation) +
              "</span>";
            return (
              '<button type="button" class="analytics-head analytics-sort" data-sort="' +
              key +
              '" aria-label="' +
              escapeMermaidLabel(titleName) +
              ': ' +
              escapeMermaidLabel(explanation) +
              '">' +
              headerLabel(key, label) +
              tooltip +
              "</button>"
            );
          }

          analyticsPanel.innerHTML = [
            "<h2>Depth Analytics</h2>",
            '<div class="analytics-summary">',
            '<span class="analytics-chip">' + fileRows.length + " files</span>",
            '<span class="analytics-chip">' + filteredEdges.length + " edges</span>",
            '<span class="analytics-chip">Max depth ' + maxDepth + "</span>",
            "</div>",
            '<div class="analytics-grid" role="table" aria-label="Files ordered by depth">',
            headerButton("depth", "D", "Depth of the file in the current tree. Lower numbers are closer to the root."),
            headerButton("file", "File", "The file name for each visible node in the tree."),
            headerButton("negativeImports", "NI", "Negative imports. Counts imports that point to files below this file's depth."),
            headerButton("negativeExports", "NE", "Negative exports. Counts links from this file to files above its depth."),
            headerButton("balance", "B", "Balanced links. Counts relationships to files at the same depth."),
            rowsHtml,
            "</div>",
          ].join("");

          analyticsPanel.querySelectorAll("[data-sort]").forEach((button) => {
            button.addEventListener("click", () => {
              const nextKey = button.dataset.sort;
              if (!nextKey) {
                return;
              }

              if (analyticsSort.key === nextKey) {
                analyticsSort.direction = analyticsSort.direction === "asc" ? "desc" : "asc";
              } else {
                analyticsSort.key = nextKey;
                analyticsSort.direction = nextKey === "file" ? "asc" : "desc";
              }

              renderTreeAnalytics(rootFileId);
            });
          });
        }

        function hydrateRootButtons() {
          if (!isTreeMode || !rootControls || !rootButtons || !treePayload) {
            return;
          }
          const allButton = document.createElement("button");
          allButton.type = "button";
          allButton.className = "root-button";
          allButton.textContent = "All Files";
          allButton.dataset.root = "all";
          allButton.addEventListener("click", () => switchRoot("all"));
          rootButtons.appendChild(allButton);

          if (treePayload.roots.length === 0) {
            return;
          }
          treePayload.roots.forEach((rootId) => {
            const file = treePayload.files.find((entry) => entry.id === rootId);
            if (!file) {
              return;
            }
            const button = document.createElement("button");
            button.type = "button";
            button.className = "root-button";
            button.textContent = file.label;
            button.dataset.root = rootId;
            button.addEventListener("click", () => switchRoot(rootId));
            rootButtons.appendChild(button);
          });
        }

        function setActiveRoot(rootId) {
          if (!rootButtons) {
            return;
          }
          Array.from(rootButtons.querySelectorAll("button")).forEach((button) => {
            const isSelected = button.dataset.root === rootId;
            button.classList.toggle("active", isSelected);
          });
        }

        async function switchRoot(rootId) {
          activeRoot = rootId;
          const cached = rootCache.get(rootId);
          const diagramText = cached ?? buildTreeMermaid(rootId);
          rootCache.set(rootId, diagramText);
          setActiveRoot(rootId);
          isAutoFit = false;
          await renderMermaid(diagramText);
          renderTreeAnalytics(rootId);
        }

        async function renderMermaid(definition) {
          mermaidDiagram.textContent = definition;
          mermaidDiagram.style.display = "block";
          mermaidDiagram.style.width = "auto";
          mermaidContent.style.width = "auto";
          mermaidContent.style.minWidth = "100%";
          mermaidDiagram.removeAttribute("data-processed");
          try {
            await mermaid.run({ nodes: [mermaidDiagram] });
          } catch (error) {
            const message = error?.message || String(error);
            if (String(message).includes("Syntax error in text")) {
              console.error("Mermaid syntax error in text", {
                root: activeRoot,
                snippet: definition.slice(0, 400),
                message,
              });
            } else {
              console.error("Mermaid render error", {
                root: activeRoot,
                message,
              });
            }
            mermaidDiagram.innerHTML =
              '<pre style="padding:12px; color:#b91c1c; white-space:pre-wrap;">' +
              "Mermaid render error: " +
              escapeMermaidLabel(message) +
              "</pre>";
            return;
          }
          requestAnimationFrame(() => {
            renderZoom(currentScale);
            centerRootNode(activeRoot);
          });
        }

        zoomIn.addEventListener("click", () => {
          isAutoFit = false;
          renderZoom(currentScale + stepScale);
        });

        zoomOut.addEventListener("click", () => {
          isAutoFit = false;
          renderZoom(currentScale - stepScale);
        });

        zoomReset.addEventListener("click", () => {
          isAutoFit = false;
          renderZoom(1);
        });

        zoomFit.addEventListener("click", () => {
          fitToWidth();
        });

        graphFrame.addEventListener(
          "wheel",
          (event) => {
            if (!event.ctrlKey) {
              return;
            }

            event.preventDefault();
            isAutoFit = false;

            const pinchFactor = Math.exp(-event.deltaY * 0.0015);
            renderZoom(currentScale * pinchFactor);
          },
          { passive: false }
        );

        window.addEventListener("resize", () => {
          if (isAutoFit) {
            fitToWidth();
          }
        });

        if (isTreeMode) {
          loadTreePayload().then((payload) => {
            treePayload = payload;
            fileById = new Map(treePayload.files.map((entry) => [entry.id, entry]));
            activeRoot =
              treePayload.roots.length > 0 ? treePayload.roots[0] : "all";

            hydrateRootButtons();
            setActiveRoot(activeRoot);

            const initialDefinition =
              rootCache.get(activeRoot) ?? buildTreeMermaid(activeRoot);
            rootCache.set(activeRoot, initialDefinition);
            mermaidDiagram.textContent = initialDefinition;
            renderMermaid(initialDefinition).then(() => {
              fitToWidth();
            });
            renderTreeAnalytics(activeRoot);
          });
          return;
        }

        mermaidDiagram.textContent = mermaidDefinition;
        mermaid.run({
          nodes: [mermaidDiagram],
        }).then(() => {
          requestAnimationFrame(() => {
            renderZoom(currentScale);
          });
        });
      });
    </script>
  </head>
  <body>
    <main>
      <div class="meta">${entries.length} exports, ${importerCount} importers, ${edgeCount} edges</div>
      <div class="graph-shell${useTree ? " tree-mode" : ""}">
        <div class="graph-toolbar">
${useTree ? `
          <div id="rootControls" class="root-controls">
            <div id="rootButtons" class="root-strip">
            </div>
          </div>` : ""}
          <button id="zoomFit" type="button">Fit width</button>
          <button id="zoomOut" type="button">−</button>
          <button id="zoomIn" type="button">＋</button>
          <button id="zoomReset" type="button">100%</button>
          <span id="zoomLevel">100%</span>
          <span class="sr-only" aria-live="polite" id="zoomStatus"></span>
        </div>
        <div class="graph-stage">
          <div id="graphFrame" class="graph-frame">
            <div class="mermaid-container">
              <div id="mermaidContent" class="mermaid-content">
                <div id="mermaidDiagram" class="mermaid"></div>
              </div>
            </div>
          </div>
${useTree ? `
          <aside id="analyticsPanel" class="analytics-panel" aria-label="Depth analytics"></aside>` : ""}
        </div>
      </div>
    </main>
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

function getTreePayloadOutputPath(outputPath) {
  if (!outputPath) {
    return null;
  }

  if (/\.html?$/i.test(outputPath)) {
    return outputPath.replace(/\.html?$/i, ".tree.json");
  }

  return `${outputPath}.tree.json`;
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
  const treePayload =
    options.format === "html" && options.tree
      ? buildTreeGraphPayload(buildGraphContext(entries, options))
      : null;
  const treePayloadOutputPath =
    options.format === "html" && options.tree && options.output
      ? getTreePayloadOutputPath(options.output)
      : null;

  const output =
    options.format === "json"
      ? buildJson(entries)
      : options.format === "mermaid"
        ? buildMermaid(entries, options)
        : options.format === "dot"
          ? buildDot(entries, options)
          : buildHtml(
              entries,
              options,
              treePayload,
              treePayloadOutputPath ? path.basename(treePayloadOutputPath) : null
            );

  if (options.output) {
    await writeOutput(options.output, output);
    if (treePayload && treePayloadOutputPath) {
      await writeOutput(treePayloadOutputPath, `${JSON.stringify(treePayload, null, 2)}\n`);
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
