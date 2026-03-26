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

function buildHtml(entries, options) {
  const context = buildGraphContext(entries, options);
  const useTree = Boolean(options.tree);
  const mermaid = useTree ? buildMermaidTree(context) : buildMermaid(entries, options);
  const importerCount = new Set(entries.flatMap((entry) => entry.importedBy)).size;
  const edgeCount = entries.reduce((count, entry) => count + entry.importedBy.length, 0);
  const treePayload = useTree ? buildTreeGraphPayload(context) : null;
  const initialRootId =
    treePayload && treePayload.roots.length > 0 ? treePayload.roots[0] : "all";
  const mermaidDefinition = JSON.stringify(mermaid);
  const treePayloadJson = treePayload
    ? JSON.stringify(treePayload, null, 2)
    : "null";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Export Import Graph</title>
    <style>
      :root {
        color-scheme: light;
        font-family: "SF Mono", "Menlo", monospace;
        background: #f8fafc;
        color: #0f172a;
      }

      body {
        margin: 0;
        padding: 24px;
        font-family: "Inter", "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
        background:
          radial-gradient(circle at top left, rgba(59, 130, 246, 0.08), transparent 30%),
          linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%);
      }

      main {
        width: min(1500px, calc(100vw - 32px));
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
        overflow: visible;
      }

      .graph-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
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
      }

      .graph-frame {
        overflow-x: auto;
        overflow-y: auto;
        white-space: nowrap;
        scrollbar-width: thin;
        min-height: 520px;
        max-height: calc(100vh - 240px);
        border: 1px dashed #cbd5e1;
        border-radius: 12px;
      }

      .mermaid-container {
        width: max-content;
        overflow: visible;
        padding: 8px 0 8px 4px;
        min-width: 100%;
      }

      .mermaid-content {
        transform-origin: top left;
        display: inline-block;
        width: max-content;
        min-width: max-content;
        transition: transform 120ms ease;
        overflow: visible;
      }

      .mermaid {
        display: inline-block;
        width: max-content;
        max-width: none !important;
        overflow: visible;
      }

      .mermaid svg {
        display: block;
        // width: auto !important;
        max-width: none !important;
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
        const minScale = 0.08;
        const maxScale = 3;
        const stepScale = 0.1;
        const isTreeMode = ${useTree ? "true" : "false"};
        const treePayload = ${treePayloadJson};
        const rootCache = new Map();
        let activeRoot = "${initialRootId}";
        let currentScale = 1;
        let isAutoFit = false;
        const mermaidDefinition = ${mermaidDefinition};
        const fileById = treePayload
          ? new Map(treePayload.files.map((entry) => [entry.id, entry]))
          : new Map();

        function clampScale(value) {
          return Math.min(maxScale, Math.max(minScale, value));
        }

        function getDiagramWidth() {
          const svg = mermaidDiagram.querySelector("svg");
          if (!svg) {
            return 0;
          }
          if (svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) {
            return svg.viewBox.baseVal.width;
          }
          return svg.getBoundingClientRect().width || svg.clientWidth || 0;
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

        function fitToWidth() {
          const diagramWidth = getDiagramWidth();
          if (!diagramWidth || !graphFrame) {
            return;
          }
          const frameWidth = graphFrame.clientWidth - 24;
          const nextScale = Math.min(1, frameWidth / diagramWidth);
          renderZoom(nextScale, "Fit");
          isAutoFit = true;
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

        function buildTreeMermaid(rootFileId) {
          if (!treePayload) {
            return "";
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
              const fileName = filePath.split("/").pop();
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

          return lines.join("\\n");
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
        }

        async function renderMermaid(definition) {
          mermaidDiagram.textContent = definition;
          mermaidDiagram.style.display = "inline-block";
          mermaidDiagram.style.width = "max-content";
          mermaidContent.style.width = "max-content";
          mermaidContent.style.minWidth = "max-content";
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
          const svg = mermaidDiagram.querySelector("svg");
          if (svg) {
            let svgWidth = 0;
            try {
              const bbox = svg.getBBox?.();
              svgWidth = bbox?.width || 0;
            } catch {
              svgWidth = 0;
            }
            if (!svgWidth) {
              svgWidth = getDiagramWidth();
            }
            if (svgWidth > 0) {
              mermaidContent.style.width = Math.ceil(svgWidth) + "px";
            }
          }
          requestAnimationFrame(() => {
            renderZoom(currentScale);
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

        window.addEventListener("resize", () => {
          if (isAutoFit) {
            fitToWidth();
          }
        });

        if (isTreeMode) {
          hydrateRootButtons();
          setActiveRoot("${initialRootId}");
          const initialDefinition = rootCache.get("${initialRootId}") ?? buildTreeMermaid("${initialRootId}");
          rootCache.set("${initialRootId}", initialDefinition);
          mermaidDiagram.textContent = initialDefinition;
          renderMermaid(initialDefinition);
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
      <div class="graph-shell">
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
        <div id="graphFrame" class="graph-frame">
          <div class="mermaid-container">
            <div id="mermaidContent" class="mermaid-content">
              <div id="mermaidDiagram" class="mermaid"></div>
            </div>
          </div>
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
    flowchart: {
      defaultRenderer: "elk",
      useMaxWidth: false,
      htmlLabels: true,
      nodeSpacing: 40,
      rankSpacing: 140,
      curve: "monotoneY",
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

  const output =
    options.format === "json"
      ? buildJson(entries)
      : options.format === "mermaid"
        ? buildMermaid(entries, options)
        : options.format === "dot"
          ? buildDot(entries, options)
          : buildHtml(entries, options);

  if (options.output) {
    await writeOutput(options.output, output);
    process.stdout.write(`${options.output}\n`);
    return;
  }

  process.stdout.write(output);

  if (!output.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

await main();
