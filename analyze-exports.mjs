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
    healthOutput: "text",
    tsconfig: DEFAULT_TSCONFIG,
    input: null,
    output: null,
    root: "all",
    relativeTo: process.cwd(),
    minImporters: 0,
    includeOrphans: true,
    focus: null,
    layout: "LR",
    top: 10,
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

    if (arg === "--health-output") {
      options.healthOutput = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--root") {
      options.root = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--top") {
      options.top = Number.parseInt(requireValue(argv, ++index, arg), 10);
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

  if (!Number.isInteger(options.top) || options.top <= 0) {
    throw new Error("--top must be a positive integer");
  }

  if (!["json", "mermaid", "dot", "html", "health"].includes(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`);
  }

  if (!["text", "json"].includes(options.healthOutput)) {
    throw new Error(`Unsupported health output format: ${options.healthOutput}`);
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
  --format <json|mermaid|dot|html|health>  Output format. Default: json
  --input <file>                    Read an existing JSON export map instead of ts-morph
  --output <file>                   Write output to a file instead of stdout
  --health-output <text|json>       Health report encoding. Default: text
  --root <fileId|all>               Scope tree/health analysis to one root. Default: all
  --top <n>                         Number of offenders/SCCs/directories to print. Default: 10
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
  node analyze-exports.mjs --format health --health-output text --top 10
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
    return buildMermaidTree(context, options.root === "all" ? null : options.root);
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

function buildVisibleTreeGraph(files, edges, rootIds, rootFileId = null) {
  const fileById = new Map(files.map((entry) => [entry.id, entry]));
  const allFileIds = new Set(fileById.keys());
  const selectedRootId =
    rootFileId === "all"
      ? "all"
      : rootFileId && allFileIds.has(rootFileId)
        ? rootFileId
        : rootIds[0] ?? "all";
  const visibleFiles = new Set();

  if (selectedRootId !== "all") {
    const queue = [selectedRootId];
    while (queue.length > 0) {
      const sourceId = queue.shift();

      if (!sourceId || visibleFiles.has(sourceId)) {
        continue;
      }

      visibleFiles.add(sourceId);

      edges.forEach(({ source, target }) => {
        if (source === sourceId && allFileIds.has(target) && !visibleFiles.has(target)) {
          queue.push(target);
        }
      });
    }
  } else {
    for (const fileId of allFileIds) {
      visibleFiles.add(fileId);
    }
  }

  const filteredEdges = edges.filter(
    ({ source, target }) => visibleFiles.has(source) && visibleFiles.has(target)
  );

  return {
    selectedRootId,
    fileById,
    visibleFiles,
    filteredEdges,
  };
}

function buildCondensedGraph(visibleFiles, filteredEdges) {
  const outgoingByFile = new Map();
  visibleFiles.forEach((fileId) => {
    outgoingByFile.set(fileId, []);
  });

  filteredEdges.forEach(({ source, target }) => {
    const outgoing = outgoingByFile.get(source);
    if (!outgoing) {
      return;
    }
    outgoing.push(target);
  });

  outgoingByFile.forEach((targets) => {
    targets.sort();
  });

  const indexByFile = new Map();
  const lowLinkByFile = new Map();
  const componentByFile = new Map();
  const stack = [];
  const stackMembers = new Set();
  const componentMembers = [];
  let currentIndex = 0;

  function strongConnect(fileId) {
    indexByFile.set(fileId, currentIndex);
    lowLinkByFile.set(fileId, currentIndex);
    currentIndex += 1;
    stack.push(fileId);
    stackMembers.add(fileId);

    (outgoingByFile.get(fileId) ?? []).forEach((targetId) => {
      if (!indexByFile.has(targetId)) {
        strongConnect(targetId);
        lowLinkByFile.set(
          fileId,
          Math.min(lowLinkByFile.get(fileId) ?? 0, lowLinkByFile.get(targetId) ?? 0)
        );
        return;
      }

      if (stackMembers.has(targetId)) {
        lowLinkByFile.set(
          fileId,
          Math.min(lowLinkByFile.get(fileId) ?? 0, indexByFile.get(targetId) ?? 0)
        );
      }
    });

    if (lowLinkByFile.get(fileId) !== indexByFile.get(fileId)) {
      return;
    }

    const componentId = componentMembers.length;
    const members = [];

    while (stack.length > 0) {
      const member = stack.pop();
      if (!member) {
        break;
      }
      stackMembers.delete(member);
      componentByFile.set(member, componentId);
      members.push(member);
      if (member === fileId) {
        break;
      }
    }

    componentMembers.push(members.sort());
  }

  Array.from(visibleFiles)
    .sort()
    .forEach((fileId) => {
      if (!indexByFile.has(fileId)) {
        strongConnect(fileId);
      }
    });

  const outgoingByComponent = new Map();
  const incomingCounts = new Map();
  componentMembers.forEach((_, componentId) => {
    outgoingByComponent.set(componentId, new Set());
    incomingCounts.set(componentId, 0);
  });

  filteredEdges.forEach(({ source, target }) => {
    const sourceComponent = componentByFile.get(source);
    const targetComponent = componentByFile.get(target);
    if (
      sourceComponent === undefined ||
      targetComponent === undefined ||
      sourceComponent === targetComponent
    ) {
      return;
    }

    const targets = outgoingByComponent.get(sourceComponent);
    if (!targets || targets.has(targetComponent)) {
      return;
    }

    targets.add(targetComponent);
    incomingCounts.set(targetComponent, (incomingCounts.get(targetComponent) ?? 0) + 1);
  });

  const levelByComponent = new Map();
  let frontier = Array.from(incomingCounts.entries())
    .filter(([, incoming]) => incoming === 0)
    .map(([componentId]) => componentId)
    .sort((left, right) => left - right);

  frontier.forEach((componentId) => {
    levelByComponent.set(componentId, 0);
  });

  const remainingIncoming = new Map(incomingCounts);

  while (frontier.length > 0) {
    const nextFrontier = [];

    frontier.forEach((sourceComponent) => {
      const sourceLevel = levelByComponent.get(sourceComponent);
      if (sourceLevel === undefined) {
        return;
      }

      Array.from(outgoingByComponent.get(sourceComponent) ?? [])
        .sort((left, right) => left - right)
        .forEach((targetComponent) => {
          const nextLevel = sourceLevel + 1;
          const existing = levelByComponent.get(targetComponent);
          if (existing === undefined || nextLevel > existing) {
            levelByComponent.set(targetComponent, nextLevel);
          }

          const updated = Math.max(0, (remainingIncoming.get(targetComponent) ?? 0) - 1);
          remainingIncoming.set(targetComponent, updated);
          if (updated === 0) {
            nextFrontier.push(targetComponent);
          }
        });
    });

    frontier = [...new Set(nextFrontier)].sort((left, right) => left - right);
  }

  const levelByFile = new Map();
  componentByFile.forEach((componentId, fileId) => {
    const level = levelByComponent.get(componentId);
    if (level === undefined) {
      throw new Error(`Missing component level for ${fileId}.`);
    }
    levelByFile.set(fileId, level);
  });

  const internalEdgeCounts = new Map();
  const entryEdgeCounts = new Map();
  const exitEdgeCounts = new Map();
  componentMembers.forEach((_, componentId) => {
    internalEdgeCounts.set(componentId, 0);
    entryEdgeCounts.set(componentId, 0);
    exitEdgeCounts.set(componentId, 0);
  });

  filteredEdges.forEach(({ source, target }) => {
    const sourceComponent = componentByFile.get(source);
    const targetComponent = componentByFile.get(target);
    if (sourceComponent === undefined || targetComponent === undefined) {
      return;
    }

    if (sourceComponent === targetComponent) {
      internalEdgeCounts.set(
        sourceComponent,
        (internalEdgeCounts.get(sourceComponent) ?? 0) + 1
      );
      return;
    }

    exitEdgeCounts.set(
      sourceComponent,
      (exitEdgeCounts.get(sourceComponent) ?? 0) + 1
    );
    entryEdgeCounts.set(
      targetComponent,
      (entryEdgeCounts.get(targetComponent) ?? 0) + 1
    );
  });

  const components = componentMembers.map((members, componentId) => {
    const size = members.length;
    const internalEdges = internalEdgeCounts.get(componentId) ?? 0;
    const possibleInternalEdges = size > 1 ? size * (size - 1) : 1;
    return {
      id: componentId,
      members,
      size,
      internalEdges,
      internalDensity: possibleInternalEdges > 0 ? internalEdges / possibleInternalEdges : 0,
      entryEdges: entryEdgeCounts.get(componentId) ?? 0,
      exitEdges: exitEdgeCounts.get(componentId) ?? 0,
      depth: levelByComponent.get(componentId) ?? 0,
    };
  });

  return {
    components,
    componentByFile,
    outgoingByComponent,
    levelByComponent,
    levelByFile,
  };
}

function buildCondensedDepthLevels(visibleFiles, filteredEdges) {
  return buildCondensedGraph(visibleFiles, filteredEdges).levelByFile;
}

function buildVisibleImportEdges(treePayload, visibleFiles) {
  const pathToFileId = new Map(treePayload.files.map((entry) => [entry.path, entry.id]));
  const edgeSet = new Set();

  treePayload.files.forEach((file) => {
    if (!visibleFiles.has(file.id)) {
      return;
    }

    Array.from(new Set(file.imports ?? [])).forEach((importedPath) => {
      const targetId = pathToFileId.get(importedPath);
      if (!targetId || !visibleFiles.has(targetId) || targetId === file.id) {
        return;
      }
      edgeSet.add(`${file.id}=>${targetId}`);
    });
  });

  return Array.from(edgeSet)
    .sort()
    .map((edgeId) => {
      const [source, target] = edgeId.split("=>");
      return { source, target };
    });
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function ratio(count, total) {
  if (!total) {
    return 0;
  }
  return count / total;
}

function roundMetric(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function formatPercent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function compareHealthOffenders(left, right) {
  return (
    right.severity - left.severity ||
    right.metrics.wrongWayOutgoing - left.metrics.wrongWayOutgoing ||
    right.metrics.totalDegree - left.metrics.totalDegree ||
    left.path.localeCompare(right.path)
  );
}

function compareHealthDirectories(left, right) {
  return (
    right.depthSpread - left.depthSpread ||
    right.crossDirectoryWrongWayRatio - left.crossDirectoryWrongWayRatio ||
    right.fileCount - left.fileCount ||
    left.directory.localeCompare(right.directory)
  );
}

function compareHealthSccs(left, right) {
  return (
    right.size - left.size ||
    right.internalDensity - left.internalDensity ||
    left.members[0].localeCompare(right.members[0])
  );
}

function buildStructuralHealthReport(treePayload, options = {}) {
  if (!treePayload) {
    throw new Error("Tree payload is required for health analysis.");
  }

  const rootFileId = options.rootFileId ?? "all";
  const top = Number.isInteger(options.top) && options.top > 0 ? options.top : 10;
  const { fileById, filteredEdges, selectedRootId, visibleFiles } = buildVisibleTreeGraph(
    treePayload.files,
    treePayload.edges,
    treePayload.roots,
    rootFileId
  );
  const condensed = buildCondensedGraph(visibleFiles, filteredEdges);
  const visibleImportEdges = buildVisibleImportEdges(treePayload, visibleFiles);
  const visibleFileEntries = Array.from(visibleFiles)
    .map((fileId) => fileById.get(fileId))
    .filter(Boolean);
  const fileStats = new Map();
  const directoryStats = new Map();
  const componentSizeByFile = new Map();
  condensed.components.forEach((component) => {
    component.members.forEach((fileId) => {
      componentSizeByFile.set(fileId, component.size);
    });
  });

  visibleFileEntries.forEach((file) => {
    const depth = condensed.levelByFile.get(file.id) ?? 0;
    fileStats.set(file.id, {
      id: file.id,
      path: file.path,
      file: file.relative,
      directory: file.directory,
      depth,
      inDegree: 0,
      outDegree: 0,
      totalDegree: 0,
      wrongWayOutgoing: 0,
      wrongWayIncoming: 0,
      wrongWaySeverity: 0,
      skipOutgoing: 0,
      skipSeverity: 0,
      sameLevelEdges: 0,
      neighborDepths: new Set(),
      neighborDirectories: new Set(),
      cycleSize: componentSizeByFile.get(file.id) ?? 1,
      foundationalPurityViolations: 0,
    });
  });

  const repoMetrics = {
    wrongWayEdges: 0,
    wrongWaySeverity: 0,
    skipEdges: 0,
    skipSeverity: 0,
    sameLevelEdges: 0,
    idealEdges: 0,
  };

  visibleImportEdges.forEach(({ source, target }) => {
    const sourceStats = fileStats.get(source);
    const targetStats = fileStats.get(target);
    if (!sourceStats || !targetStats) {
      return;
    }

    sourceStats.outDegree += 1;
    targetStats.inDegree += 1;
    sourceStats.neighborDepths.add(targetStats.depth);
    targetStats.neighborDepths.add(sourceStats.depth);
    sourceStats.neighborDirectories.add(targetStats.directory);
    targetStats.neighborDirectories.add(sourceStats.directory);

    const delta = targetStats.depth - sourceStats.depth;
    if (delta < 0) {
      const severity = Math.abs(delta);
      repoMetrics.wrongWayEdges += 1;
      repoMetrics.wrongWaySeverity += severity;
      sourceStats.wrongWayOutgoing += 1;
      sourceStats.wrongWaySeverity += severity;
      targetStats.wrongWayIncoming += 1;
    } else if (delta === 0) {
      repoMetrics.sameLevelEdges += 1;
      sourceStats.sameLevelEdges += 1;
    } else if (delta === 1) {
      repoMetrics.idealEdges += 1;
    } else {
      const severity = delta - 1;
      repoMetrics.skipEdges += 1;
      repoMetrics.skipSeverity += severity;
      sourceStats.skipOutgoing += 1;
      sourceStats.skipSeverity += severity;
    }
  });

  fileStats.forEach((entry) => {
    entry.totalDegree = entry.inDegree + entry.outDegree;
    const depthNeighbors = Array.from(entry.neighborDepths);
    const neighborDepthSpan =
      depthNeighbors.length > 0
        ? Math.max(...depthNeighbors) - Math.min(...depthNeighbors)
        : 0;
    const bridgeSuspicion =
      entry.totalDegree >= 4 && neighborDepthSpan >= 2 && entry.neighborDirectories.size >= 3;
    entry.bridgeSuspicion = bridgeSuspicion;
    entry.bridgeSpan = neighborDepthSpan;
    entry.neighborDirectoryCount = entry.neighborDirectories.size;

    const foundationalHint = /(^|\/)(shared|types|constants|core|util|utils)(\/|\.|$)/i.test(
      entry.file
    );
    if (foundationalHint) {
      entry.foundationalPurityViolations = entry.wrongWayOutgoing;
    }

    entry.severity =
      entry.wrongWayOutgoing * 4 +
      entry.wrongWayIncoming * 2 +
      entry.skipSeverity * 2 +
      entry.sameLevelEdges * 0.5 +
      Math.max(0, entry.totalDegree - 3) * 0.5 +
      (entry.cycleSize > 1 ? entry.cycleSize * 1.5 : 0) +
      (entry.bridgeSuspicion ? 4 + entry.bridgeSpan + entry.neighborDirectoryCount * 0.5 : 0) +
      entry.foundationalPurityViolations * 2;

    const directoryEntry =
      directoryStats.get(entry.directory) ??
      {
        directory: entry.directory,
        fileCount: 0,
        depths: [],
        crossDirectoryEdges: 0,
        crossDirectoryWrongWayEdges: 0,
        sameLevelEdges: 0,
      };
    directoryEntry.fileCount += 1;
    directoryEntry.depths.push(entry.depth);
    directoryStats.set(entry.directory, directoryEntry);
  });

  visibleImportEdges.forEach(({ source, target }) => {
    const sourceStats = fileStats.get(source);
    const targetStats = fileStats.get(target);
    if (!sourceStats || !targetStats || sourceStats.directory === targetStats.directory) {
      return;
    }

    const directoryEntry = directoryStats.get(sourceStats.directory);
    if (!directoryEntry) {
      return;
    }

    directoryEntry.crossDirectoryEdges += 1;
    const delta = targetStats.depth - sourceStats.depth;
    if (delta < 0) {
      directoryEntry.crossDirectoryWrongWayEdges += 1;
    } else if (delta === 0) {
      directoryEntry.sameLevelEdges += 1;
    }
  });

  const depthCounts = new Map();
  visibleFileEntries.forEach((file) => {
    const depth = condensed.levelByFile.get(file.id) ?? 0;
    depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);
  });
  const depthHistogram = Array.from(depthCounts.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([depth, files]) => ({ depth, files }));
  const maxDepth = depthHistogram.reduce((max, entry) => Math.max(max, entry.depth), 0);
  const widestDepth = depthHistogram.reduce(
    (best, entry) => (entry.files > best.files ? entry : best),
    { depth: 0, files: 0 }
  );
  const averageDepthWidth = mean(depthHistogram.map((entry) => entry.files));
  const overloadedDepths = depthHistogram
    .filter((entry) => entry.files >= averageDepthWidth * 1.5 && entry.files >= averageDepthWidth + 1)
    .map((entry) => entry.depth);
  const dominantDepthShare = ratio(widestDepth.files, visibleFileEntries.length);
  const flatnessRatio = ratio(depthHistogram.length, visibleFileEntries.length);

  const cyclicComponents = condensed.components.filter((component) => component.size > 1);
  const filesInCycles = cyclicComponents.reduce((sum, component) => sum + component.size, 0);
  const largestSccSize = cyclicComponents.reduce(
    (max, component) => Math.max(max, component.size),
    0
  );

  const visibleRootIds =
    selectedRootId === "all"
      ? treePayload.roots.filter((rootId) => visibleFiles.has(rootId))
      : treePayload.roots.filter((rootId) => visibleFiles.has(rootId) && rootId === selectedRootId);
  const outgoingByComponent = condensed.outgoingByComponent;
  const rootFanout = visibleRootIds.map((rootId) => {
    const rootComponentId = condensed.componentByFile.get(rootId);
    const rootFile = fileById.get(rootId);
    return {
      id: rootId,
      file: rootFile?.relative ?? rootId,
      immediateFanout:
        rootComponentId === undefined ? 0 : (outgoingByComponent.get(rootComponentId)?.size ?? 0),
    };
  });
  const totalRootFanout = rootFanout.reduce((sum, entry) => sum + entry.immediateFanout, 0);
  const topRootFanout = rootFanout.reduce(
    (max, entry) => Math.max(max, entry.immediateFanout),
    0
  );

  const topHubs = Array.from(fileStats.values())
    .slice()
    .sort((left, right) => right.totalDegree - left.totalDegree || left.path.localeCompare(right.path))
    .slice(0, top)
    .map((entry) => ({
      path: entry.path,
      file: entry.file,
      totalDegree: entry.totalDegree,
      inDegree: entry.inDegree,
      outDegree: entry.outDegree,
    }));

  const directorySummaries = Array.from(directoryStats.values())
    .map((entry) => {
      const minDepth = Math.min(...entry.depths);
      const maxDirectoryDepth = Math.max(...entry.depths);
      return {
        directory: entry.directory,
        fileCount: entry.fileCount,
        minDepth,
        medianDepth: median(entry.depths),
        maxDepth: maxDirectoryDepth,
        depthSpread: maxDirectoryDepth - minDepth,
        crossDirectoryEdges: entry.crossDirectoryEdges,
        crossDirectoryWrongWayEdges: entry.crossDirectoryWrongWayEdges,
        crossDirectoryWrongWayRatio: ratio(
          entry.crossDirectoryWrongWayEdges,
          entry.crossDirectoryEdges
        ),
      };
    })
    .sort(compareHealthDirectories);

  const directorySmearCount = directorySummaries.filter((entry) => entry.depthSpread >= 3).length;
  const averageDirectoryDepthSpread = mean(
    directorySummaries.map((entry) => entry.depthSpread)
  );

  const topOffenders = Array.from(fileStats.values())
    .filter((entry) => entry.severity > 0)
    .map((entry) => {
      const reasons = [];
      if (entry.cycleSize > 1) {
        reasons.push(`cycle cluster of ${entry.cycleSize} files`);
      }
      if (entry.wrongWayOutgoing > 0) {
        reasons.push(`${entry.wrongWayOutgoing} wrong-way imports`);
      }
      if (entry.skipOutgoing > 0) {
        reasons.push(`${entry.skipOutgoing} layer-skipping imports`);
      }
      if (entry.bridgeSuspicion) {
        reasons.push(`bridges ${entry.neighborDirectoryCount} directories across ${entry.bridgeSpan} depth bands`);
      }
      if (entry.foundationalPurityViolations > 0) {
        reasons.push("foundational purity violation");
      }
      if (entry.sameLevelEdges > 2) {
        reasons.push(`${entry.sameLevelEdges} same-level imports`);
      }

      return {
        path: entry.path,
        file: entry.file,
        directory: entry.directory,
        depth: entry.depth,
        severity: roundMetric(entry.severity, 2),
        reasons,
        metrics: {
          wrongWayOutgoing: entry.wrongWayOutgoing,
          wrongWayIncoming: entry.wrongWayIncoming,
          skipOutgoing: entry.skipOutgoing,
          sameLevelEdges: entry.sameLevelEdges,
          totalDegree: entry.totalDegree,
          cycleSize: entry.cycleSize,
          bridgeSuspicion: entry.bridgeSuspicion,
          neighborDirectoryCount: entry.neighborDirectoryCount,
          bridgeSpan: entry.bridgeSpan,
        },
      };
    })
    .sort(compareHealthOffenders)
    .slice(0, top);

  const topSccs = cyclicComponents
    .map((component) => ({
      id: component.id,
      size: component.size,
      depth: component.depth,
      internalEdges: component.internalEdges,
      internalDensity: roundMetric(component.internalDensity),
      entryEdges: component.entryEdges,
      exitEdges: component.exitEdges,
      members: component.members
        .map((fileId) => fileById.get(fileId)?.relative ?? fileId)
        .sort(),
    }))
    .sort(compareHealthSccs)
    .slice(0, top);

  const metrics = {
    layerFlow: {
      totalEdges: visibleImportEdges.length,
      wrongWayEdges: repoMetrics.wrongWayEdges,
      wrongWayRatio: roundMetric(ratio(repoMetrics.wrongWayEdges, visibleImportEdges.length)),
      wrongWaySeverityTotal: repoMetrics.wrongWaySeverity,
      wrongWaySeverityAverage: roundMetric(
        ratio(repoMetrics.wrongWaySeverity, repoMetrics.wrongWayEdges)
      ),
      skipEdges: repoMetrics.skipEdges,
      skipRatio: roundMetric(ratio(repoMetrics.skipEdges, visibleImportEdges.length)),
      skipSeverityTotal: repoMetrics.skipSeverity,
      skipSeverityAverage: roundMetric(ratio(repoMetrics.skipSeverity, repoMetrics.skipEdges)),
      sameLevelEdges: repoMetrics.sameLevelEdges,
      sameLevelRatio: roundMetric(ratio(repoMetrics.sameLevelEdges, visibleImportEdges.length)),
      idealEdges: repoMetrics.idealEdges,
      idealRatio: roundMetric(ratio(repoMetrics.idealEdges, visibleImportEdges.length)),
    },
    cycleBurden: {
      componentCount: condensed.components.length,
      cyclicComponentCount: cyclicComponents.length,
      filesInCycles,
      filesInCyclesRatio: roundMetric(ratio(filesInCycles, visibleFileEntries.length)),
      largestSccSize,
      largestSccRatio: roundMetric(ratio(largestSccSize, visibleFileEntries.length)),
    },
    depthBalance: {
      maxDepth,
      activeDepthCount: depthHistogram.length,
      widestDepth,
      averageDepthWidth: roundMetric(averageDepthWidth),
      dominantDepthShare: roundMetric(dominantDepthShare),
      flatnessRatio: roundMetric(flatnessRatio),
      overloadedDepths,
    },
    rootClarity: {
      rootCount: visibleRootIds.length,
      rootFanout,
      topRootFanout,
      topRootFanoutRatio: roundMetric(ratio(topRootFanout, totalRootFanout)),
      totalRootFanout,
    },
    hubPressure: {
      maxInDegree: topHubs[0]?.inDegree ?? 0,
      maxOutDegree: topHubs[0]?.outDegree ?? 0,
      maxTotalDegree: topHubs[0]?.totalDegree ?? 0,
      bridgeSuspectCount: Array.from(fileStats.values()).filter((entry) => entry.bridgeSuspicion).length,
    },
    directoryCoherence: {
      directoryCount: directorySummaries.length,
      averageDepthSpread: roundMetric(averageDirectoryDepthSpread),
      smearedDirectoryCount: directorySmearCount,
      crossDirectoryWrongWayRatio: roundMetric(
        ratio(
          directorySummaries.reduce((sum, entry) => sum + entry.crossDirectoryWrongWayEdges, 0),
          directorySummaries.reduce((sum, entry) => sum + entry.crossDirectoryEdges, 0)
        )
      ),
    },
    sameLevelCoherence: {
      sameLevelEdges: repoMetrics.sameLevelEdges,
      sameLevelRatio: roundMetric(ratio(repoMetrics.sameLevelEdges, visibleImportEdges.length)),
    },
  };

  const strengths = [];
  if (metrics.cycleBurden.filesInCyclesRatio === 0) {
    strengths.push("No cyclic file clusters detected in the analyzed scope.");
  } else if (metrics.cycleBurden.filesInCyclesRatio <= 0.1) {
    strengths.push("Cycle burden is contained to a small portion of the graph.");
  }
  if (metrics.layerFlow.wrongWayRatio <= 0.05) {
    strengths.push("Layer direction is mostly consistent across imports.");
  }
  if (metrics.depthBalance.activeDepthCount >= 4 && metrics.depthBalance.dominantDepthShare <= 0.35) {
    strengths.push("Depth bands are spread out enough to keep the map readable.");
  }
  if (metrics.directoryCoherence.smearedDirectoryCount === 0) {
    strengths.push("Directories stay within tight depth bands.");
  }

  const penalties = [];
  if (metrics.cycleBurden.filesInCyclesRatio > 0.15) {
    penalties.push(
      `${formatPercent(metrics.cycleBurden.filesInCyclesRatio)} of files sit inside SCCs.`
    );
  }
  if (metrics.layerFlow.wrongWayEdges > 0) {
    penalties.push(
      `${metrics.layerFlow.wrongWayEdges} imports climb back toward shallower layers.`
    );
  }
  if (metrics.layerFlow.skipRatio > 0.15) {
    penalties.push(
      `${formatPercent(metrics.layerFlow.skipRatio)} of imports skip one or more depth bands.`
    );
  }
  if (metrics.depthBalance.dominantDepthShare > 0.4) {
    penalties.push(
      `Depth ${metrics.depthBalance.widestDepth.depth} holds ${formatPercent(
        metrics.depthBalance.dominantDepthShare
      )} of analyzed files.`
    );
  }
  if (metrics.directoryCoherence.smearedDirectoryCount > 0) {
    penalties.push(
      `${metrics.directoryCoherence.smearedDirectoryCount} directories smear across 3+ depth bands.`
    );
  }
  if (
    Array.from(fileStats.values()).some((entry) => entry.foundationalPurityViolations > 0)
  ) {
    penalties.push("Foundational-looking modules depend on shallower orchestration layers.");
  }

  return {
    scope: {
      rootId: selectedRootId === "all" ? null : selectedRootId,
      root:
        selectedRootId === "all"
          ? null
          : (() => {
              const rootFile = fileById.get(selectedRootId);
              return rootFile
                ? {
                    id: rootFile.id,
                    path: rootFile.path,
                    relative: rootFile.relative,
                    name: rootFile.label,
                  }
                : null;
            })(),
      fileCount: visibleFileEntries.length,
      edgeCount: filteredEdges.length,
      importEdgeCount: visibleImportEdges.length,
    },
    metrics,
    findings: {
      strengths,
      penalties,
    },
    topOffenders,
    topDirectories: directorySummaries.slice(0, top),
    topSccs,
    histograms: {
      depth: depthHistogram,
    },
  };
}

function formatHealthReportText(report) {
  const lines = [];
  const rootLabel = report.scope.root?.relative ?? "all";

  lines.push(`Structureness Health (${rootLabel})`);
  lines.push(
    `${report.scope.fileCount} files, ${report.scope.edgeCount} graph edges, ${report.scope.importEdgeCount} import edges`
  );
  lines.push(
    `${report.metrics.cycleBurden.cyclicComponentCount} SCCs, max depth ${report.metrics.depthBalance.maxDepth}, ${report.metrics.rootClarity.rootCount} roots`
  );

  lines.push("");
  lines.push("Strengths");
  if (report.findings.strengths.length === 0) {
    lines.push("- None yet.");
  } else {
    report.findings.strengths.forEach((entry) => {
      lines.push(`- ${entry}`);
    });
  }

  lines.push("");
  lines.push("Penalties");
  if (report.findings.penalties.length === 0) {
    lines.push("- None.");
  } else {
    report.findings.penalties.forEach((entry) => {
      lines.push(`- ${entry}`);
    });
  }

  lines.push("");
  lines.push("Top Offenders");
  if (report.topOffenders.length === 0) {
    lines.push("- None.");
  } else {
    report.topOffenders.forEach((entry) => {
      lines.push(
        `- ${entry.file} (D${entry.depth}, severity ${entry.severity}): ${entry.reasons.join("; ")}`
      );
    });
  }

  lines.push("");
  lines.push("Top SCCs");
  if (report.topSccs.length === 0) {
    lines.push("- None.");
  } else {
    report.topSccs.forEach((entry) => {
      lines.push(
        `- size ${entry.size}, depth ${entry.depth}, density ${entry.internalDensity}: ${entry.members.join(", ")}`
      );
    });
  }

  lines.push("");
  lines.push("Depth Histogram");
  report.histograms.depth.forEach((entry) => {
    lines.push(`- D${entry.depth}: ${entry.files}`);
  });

  lines.push("");
  lines.push("Directory Depth Summary");
  if (report.topDirectories.length === 0) {
    lines.push("- None.");
  } else {
    report.topDirectories.forEach((entry) => {
      lines.push(
        `- ${entry.directory}: ${entry.fileCount} files, depth ${entry.minDepth}-${entry.maxDepth}, median ${entry.medianDepth}, spread ${entry.depthSpread}, cross-dir wrong-way ${formatPercent(entry.crossDirectoryWrongWayRatio)}`
      );
    });
  }

  lines.push("");
  lines.push("Metric Summary");
  lines.push(
    `- Layer flow: ${report.metrics.layerFlow.wrongWayEdges} wrong-way, ${report.metrics.layerFlow.skipEdges} skips, ${report.metrics.layerFlow.sameLevelEdges} same-level`
  );
  lines.push(
    `- Cycle burden: ${report.metrics.cycleBurden.filesInCycles} files in cycles, largest SCC ${report.metrics.cycleBurden.largestSccSize}`
  );
  lines.push(
    `- Root clarity: top root fanout ratio ${formatPercent(report.metrics.rootClarity.topRootFanoutRatio)}`
  );
  lines.push(
    `- Hub pressure: ${report.metrics.hubPressure.bridgeSuspectCount} bridge suspects`
  );

  return `${lines.join("\n")}\n`;
}

function buildMermaidTree(context, selectedFileId = null) {
  const mermaidInit = buildMermaidInit();
  const { fileNodeIds, fileById, edges } =
    buildFileDependencyGraph(context);
  const incomingCounts = new Map();
  for (const fileId of fileById.keys()) {
    incomingCounts.set(fileId, 0);
  }
  edges.forEach(({ target }) => {
    incomingCounts.set(target, (incomingCounts.get(target) ?? 0) + 1);
  });
  const roots = Array.from(incomingCounts.entries())
    .filter(([, incoming]) => incoming === 0)
    .map(([fileId]) => fileId)
    .sort();
  const { filteredEdges, levelByFile, visibleFiles } = (() => {
    const visibleGraph = buildVisibleTreeGraph(
      Array.from(fileNodeIds.entries()).map(([filePath, fileId]) => ({
        id: fileId,
        path: filePath,
      })),
      edges,
      roots,
      selectedFileId
    );

    return {
      filteredEdges: visibleGraph.filteredEdges,
      levelByFile: buildCondensedDepthLevels(visibleGraph.visibleFiles, visibleGraph.filteredEdges),
      visibleFiles: visibleGraph.visibleFiles,
    };
  })();

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
    if ((levelByFile.get(fileId) ?? 0) === 0) {
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

  const { fileById, filteredEdges, selectedRootId, visibleFiles } = buildVisibleTreeGraph(
    treePayload.files,
    treePayload.edges,
    treePayload.roots,
    rootFileId
  );
  const levelByFile = buildCondensedDepthLevels(visibleFiles, filteredEdges);

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
  const graphContext = buildGraphContext(entries, options);
  const treeGridData =
    options.format === "health" || (options.format === "html" && options.tree)
      ? buildTreeGridData(graphContext)
      : null;
  const gridExport =
    treeGridData && options.format === "html" && options.tree
      ? buildReadableGridExport(treeGridData)
      : null;
  const healthReport =
    treeGridData && options.format === "health"
      ? buildStructuralHealthReport(treeGridData, {
          rootFileId: options.root,
          top: options.top,
        })
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
            : options.format === "health"
              ? options.healthOutput === "json"
                ? `${JSON.stringify(healthReport, null, 2)}\n`
                : formatHealthReportText(healthReport)
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

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  await main();
}

export {
  buildCondensedGraph,
  buildCondensedDepthLevels,
  buildExportMap,
  buildGraphContext,
  buildStructuralHealthReport,
  buildTreeGridData,
  buildVisibleImportEdges,
  buildVisibleTreeGraph,
  filterEntries,
  formatHealthReportText,
  loadExportMap,
  main,
};
