import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Project } from "ts-morph";

const DEFAULT_TSCONFIG = "tsconfig.json";
const DEFAULT_MAX_LINES = 800;
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
    scoreOnly: false,
    tsconfig: DEFAULT_TSCONFIG,
    input: null,
    output: null,
    root: "all",
    threshold: null,
    relativeTo: process.cwd(),
    minImporters: 0,
    includeOrphans: true,
    focus: null,
    layout: "LR",
    top: 10,
    maxLines: DEFAULT_MAX_LINES,
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

    if (arg === "--score-only") {
      options.scoreOnly = true;
      continue;
    }

    if (arg === "--root") {
      options.root = requireValue(argv, ++index, arg);
      continue;
    }

    if (arg === "--threshold") {
      options.threshold = Number.parseFloat(requireValue(argv, ++index, arg));
      continue;
    }

    if (arg === "--top") {
      options.top = Number.parseInt(requireValue(argv, ++index, arg), 10);
      continue;
    }

    if (arg === "--max-lines") {
      options.maxLines = Number.parseInt(requireValue(argv, ++index, arg), 10);
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

  if (!Number.isInteger(options.maxLines) || options.maxLines <= 0) {
    throw new Error("--max-lines must be a positive integer");
  }

  if (
    options.threshold !== null &&
    (!Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > 100)
  ) {
    throw new Error("--threshold must be a number between 0 and 100");
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
  --score-only                      In health mode, print only score/pass-fail output
  --root <fileId|all>               Scope tree/health analysis to one root. Default: all
  --threshold <0-100>               Optional health score threshold for pass/fail messaging
  --top <n>                         Number of offenders/SCCs/directories to print. Default: 10
  --max-lines <n>                   Max lines per file for health scoring. Default: 800
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
  node analyze-exports.mjs --format health --health-output text --top 10 --threshold 80
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

function clampMetricScore(value) {
  return roundMetric(Math.max(0, Math.min(100, value)), 2);
}

function formatPercent(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

function calculateExtremeLineSeverity(lineCount, maxLines) {
  const multiple = ratio(lineCount, maxLines);
  if (multiple < 2) {
    return 0;
  }
  if (multiple < 5) {
    return ((multiple - 2) / 3) * 1.5;
  }
  if (multiple < 10) {
    return 1.5 + ((multiple - 5) / 5) * 1.5;
  }
  if (multiple < 50) {
    return 3 + ((multiple - 10) / 40) * 2;
  }
  return 5 + Math.min(5, Math.log2(multiple / 50));
}

function describeExtremeLineTier(multiple) {
  if (multiple >= 50) {
    return "extreme";
  }
  if (multiple >= 10) {
    return "severe";
  }
  if (multiple >= 5) {
    return "very large";
  }
  if (multiple >= 2) {
    return "large";
  }
  return "oversized";
}

function calculateExtremeFileSizePenalty(extremeSeverityTotal, measuredFileCount) {
  if (!measuredFileCount || extremeSeverityTotal <= 0) {
    return 0;
  }
  const averageSeverity = ratio(extremeSeverityTotal, measuredFileCount);
  return roundMetric(Math.min(25, extremeSeverityTotal * 1.5 + averageSeverity * 5), 2);
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

function isBinaryBuffer(buffer) {
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }

  return false;
}

function countLines(buffer) {
  if (buffer.length === 0) {
    return 0;
  }

  let lines = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    const nextByte = buffer[index + 1];

    if (byte === 10) {
      lines += 1;
      continue;
    }

    if (byte === 13 && nextByte !== 10) {
      lines += 1;
    }
  }

  const lastByte = buffer[buffer.length - 1];
  if (lastByte !== 10 && lastByte !== 13) {
    lines += 1;
  }

  return lines;
}

function measureFileLineCount(filePath) {
  try {
    const stats = fsSync.statSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile()) {
      return null;
    }

    const buffer = fsSync.readFileSync(filePath);
    if (isBinaryBuffer(buffer)) {
      return null;
    }

    return countLines(buffer);
  } catch {
    return null;
  }
}

function buildStructuralHealthReport(treePayload, options = {}) {
  if (!treePayload) {
    throw new Error("Tree payload is required for health analysis.");
  }

  const rootFileId = options.rootFileId ?? "all";
  const top = Number.isInteger(options.top) && options.top > 0 ? options.top : 10;
  const maxLines =
    Number.isInteger(options.maxLines) && options.maxLines > 0
      ? options.maxLines
      : DEFAULT_MAX_LINES;
  const threshold = Number.isFinite(options.threshold) ? options.threshold : null;
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
  const lineStatsByFile = new Map();
  visibleFileEntries.forEach((file) => {
    const lineCount = measureFileLineCount(file.path);
    if (lineCount === null) {
      return;
    }
    lineStatsByFile.set(file.id, {
      lineCount,
      lineOverage: Math.max(0, lineCount - maxLines),
    });
  });
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
    const lineStats = lineStatsByFile.get(file.id) ?? {
      lineCount: null,
      lineOverage: 0,
    };
    fileStats.set(file.id, {
      id: file.id,
      path: file.path,
      file: file.relative,
      directory: file.directory,
      depth,
      lineCount: lineStats.lineCount,
      lineOverage: lineStats.lineOverage,
      inDegree: 0,
      outDegree: 0,
      totalDegree: 0,
      wrongWayOutgoing: 0,
      wrongWayIncoming: 0,
      wrongWaySeverity: 0,
      skipOutgoing: 0,
      skipSeverity: 0,
      sameLevelEdges: 0,
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

    const foundationalHint = /(^|\/)(shared|types|constants|core|util|utils)(\/|\.|$)/i.test(
      entry.file
    );
    if (foundationalHint) {
      entry.foundationalPurityViolations = entry.wrongWayOutgoing;
    }

    entry.severity =
      entry.wrongWayOutgoing * 4 +
      entry.wrongWayIncoming * 2 +
      entry.sameLevelEdges * 0.5 +
      (entry.cycleSize > 1 ? entry.cycleSize * 1.5 : 0) +
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

  const measuredLineStats = Array.from(fileStats.values()).filter(
    (entry) => entry.lineCount !== null
  );
  const oversizedLineStats = measuredLineStats.filter((entry) => entry.lineOverage > 0);
  const maxLineCount = measuredLineStats.reduce(
    (max, entry) => Math.max(max, entry.lineCount ?? 0),
    0
  );
  const maxLineOverage = Math.max(0, maxLineCount - maxLines);
  const totalLineOverage = oversizedLineStats.reduce(
    (sum, entry) => sum + entry.lineOverage,
    0
  );
  const topLargeFiles = oversizedLineStats
    .slice()
    .sort(
      (left, right) =>
        right.lineCount - left.lineCount ||
        right.lineOverage - left.lineOverage ||
        left.file.localeCompare(right.file)
    )
    .slice(0, top)
    .map((entry) => ({
      path: entry.path,
      file: entry.file,
      directory: entry.directory,
      depth: entry.depth,
      lineCount: entry.lineCount,
      lineOverage: entry.lineOverage,
    }));
  const extremeLineStats = oversizedLineStats
    .map((entry) => {
      const lineMultiple = ratio(entry.lineCount, maxLines);
      const severity = calculateExtremeLineSeverity(entry.lineCount, maxLines);
      return {
        ...entry,
        lineMultiple,
        extremeSeverity: severity,
        extremeTier: describeExtremeLineTier(lineMultiple),
      };
    })
    .filter((entry) => entry.extremeSeverity > 0)
    .sort(
      (left, right) =>
        right.extremeSeverity - left.extremeSeverity ||
        right.lineCount - left.lineCount ||
        left.file.localeCompare(right.file)
    );
  const extremeSeverityTotal = extremeLineStats.reduce(
    (sum, entry) => sum + entry.extremeSeverity,
    0
  );
  const extremeFileSizePenaltyPoints = calculateExtremeFileSizePenalty(
    extremeSeverityTotal,
    measuredLineStats.length
  );

  const metrics = {
    fileSize: {
      maxLines,
      measuredFiles: measuredLineStats.length,
      unmeasuredFiles: visibleFileEntries.length - measuredLineStats.length,
      oversizedFileCount: oversizedLineStats.length,
      oversizedFileRatio: roundMetric(
        ratio(oversizedLineStats.length, measuredLineStats.length)
      ),
      maxLineCount,
      maxLineOverage,
      maxLineOverageRatio: roundMetric(ratio(maxLineOverage, maxLines)),
      totalLineOverage,
      averageLineOverage: roundMetric(ratio(totalLineOverage, measuredLineStats.length)),
      averageLineOverageRatio: roundMetric(
        ratio(totalLineOverage, measuredLineStats.length * maxLines)
      ),
      extremeFileCount: extremeLineStats.length,
      extremeFileRatio: roundMetric(ratio(extremeLineStats.length, measuredLineStats.length)),
      extremeSeverityTotal: roundMetric(extremeSeverityTotal),
      extremeSeverityAverage: roundMetric(ratio(extremeSeverityTotal, measuredLineStats.length)),
      extremeFileSizePenaltyPoints,
      worstLineMultiple: roundMetric(
        extremeLineStats.length > 0 ? extremeLineStats[0].lineMultiple : 0,
        2
      ),
      topExtremeFiles: extremeLineStats.slice(0, top).map((entry) => ({
        path: entry.path,
        file: entry.file,
        directory: entry.directory,
        depth: entry.depth,
        lineCount: entry.lineCount,
        lineOverage: entry.lineOverage,
        lineMultiple: roundMetric(entry.lineMultiple, 2),
        tier: entry.extremeTier,
        severity: roundMetric(entry.extremeSeverity, 2),
      })),
    },
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

  const fileSizeScore = clampMetricScore(
    metrics.fileSize.measuredFiles === 0
      ? 100
      : 100 -
          metrics.fileSize.oversizedFileRatio * 100 * 1.2 -
          Math.min(1, metrics.fileSize.averageLineOverageRatio) * 100 * 1.2 -
          Math.min(1, metrics.fileSize.maxLineOverageRatio) * 100 * 0.8
  );
  const layerFlowScore = clampMetricScore(
    100 -
      metrics.layerFlow.wrongWayRatio * 100 * 1.2 -
      metrics.layerFlow.sameLevelRatio * 100 * 0.25
  );
  const cycleBurdenScore = clampMetricScore(
    100 -
      metrics.cycleBurden.filesInCyclesRatio * 100 * 1.2 -
      metrics.cycleBurden.largestSccRatio * 100 * 0.8
  );
  const depthBalanceScore = clampMetricScore(
    100
  );
  const rootClarityScore = clampMetricScore(100);
  const directoryCoherenceScore = clampMetricScore(
    100 - metrics.directoryCoherence.crossDirectoryWrongWayRatio * 100 * 0.5
  );
  const scoreWeights =
    metrics.fileSize.measuredFiles > 0
      ? {
          fileSize: 0.35,
          layerFlow: 0.25,
          cycleBurden: 0.25,
          depthBalance: 0.05,
          rootClarity: 0,
          directoryCoherence: 0.1,
        }
      : {
          fileSize: 0,
          layerFlow: 0.35,
          cycleBurden: 0.25,
          depthBalance: 0.15,
          rootClarity: 0.1,
          directoryCoherence: 0.15,
        };

  const weightedScoreBeforeExtremeFileSize = clampMetricScore(
    fileSizeScore * scoreWeights.fileSize +
      layerFlowScore * scoreWeights.layerFlow +
      cycleBurdenScore * scoreWeights.cycleBurden +
      depthBalanceScore * scoreWeights.depthBalance +
      rootClarityScore * scoreWeights.rootClarity +
      directoryCoherenceScore * scoreWeights.directoryCoherence
  );
  const weightedScore = clampMetricScore(
    weightedScoreBeforeExtremeFileSize - metrics.fileSize.extremeFileSizePenaltyPoints
  );
  const thresholdPassed = threshold === null ? null : weightedScore >= threshold;
  const thresholdMessage =
    threshold === null
      ? null
      : thresholdPassed
      ? `SUCCESS: score ${weightedScore} meets threshold ${threshold}.`
      : `FAIL: score ${weightedScore} is below threshold ${threshold}.`;

  const componentDefinitions = [
    {
      key: "fileSize",
      label: "File size",
      weight: scoreWeights.fileSize,
      score: fileSizeScore,
      causes: [
        {
          key: "oversizedFiles",
          label: "files over line limit",
          rawLoss: metrics.fileSize.oversizedFileRatio * 100 * 1.2,
          signal: `${metrics.fileSize.oversizedFileCount} files over ${metrics.fileSize.maxLines} lines, ratio ${formatPercent(metrics.fileSize.oversizedFileRatio)}`,
        },
        {
          key: "averageLineOverage",
          label: "average line overage",
          rawLoss: Math.min(1, metrics.fileSize.averageLineOverageRatio) * 100 * 1.2,
          signal: `${metrics.fileSize.averageLineOverage} average excess lines per measured file`,
        },
        {
          key: "maxLineOverage",
          label: "largest file overage",
          rawLoss: Math.min(1, metrics.fileSize.maxLineOverageRatio) * 100 * 0.8,
          signal: `${metrics.fileSize.maxLineCount} max lines, ${metrics.fileSize.maxLineOverage} over limit`,
        },
        {
          key: "extremeFileSize",
          label: "extreme file size",
          rawLoss: metrics.fileSize.extremeSeverityTotal,
          signal:
            metrics.fileSize.topExtremeFiles.length > 0
              ? `${metrics.fileSize.extremeFileCount} files at least 2x over ${metrics.fileSize.maxLines} lines; worst ${metrics.fileSize.topExtremeFiles[0].file} is ${metrics.fileSize.topExtremeFiles[0].lineMultiple}x the limit`
              : "",
        },
      ],
    },
    {
      key: "layerFlow",
      label: "Layer flow",
      weight: scoreWeights.layerFlow,
      score: layerFlowScore,
      causes: [
        {
          key: "wrongWayImports",
          label: "wrong-way imports",
          rawLoss: metrics.layerFlow.wrongWayRatio * 100 * 1.2,
          signal: `${metrics.layerFlow.wrongWayEdges} edges, ratio ${formatPercent(metrics.layerFlow.wrongWayRatio)}`,
        },
        {
          key: "sameLevelImports",
          label: "same-level imports",
          rawLoss: metrics.layerFlow.sameLevelRatio * 100 * 0.25,
          signal: `${metrics.layerFlow.sameLevelEdges} edges, ratio ${formatPercent(metrics.layerFlow.sameLevelRatio)}`,
        },
      ],
    },
    {
      key: "cycleBurden",
      label: "Cycle burden",
      weight: scoreWeights.cycleBurden,
      score: cycleBurdenScore,
      causes: [
        {
          key: "filesInCycles",
          label: "files in cycles",
          rawLoss: metrics.cycleBurden.filesInCyclesRatio * 100 * 1.2,
          signal: `${metrics.cycleBurden.filesInCycles} files, ratio ${formatPercent(metrics.cycleBurden.filesInCyclesRatio)}`,
        },
        {
          key: "largestScc",
          label: "largest SCC size",
          rawLoss: metrics.cycleBurden.largestSccRatio * 100 * 0.8,
          signal: `largest SCC ${metrics.cycleBurden.largestSccSize}, ratio ${formatPercent(metrics.cycleBurden.largestSccRatio)}`,
        },
      ],
    },
    {
      key: "depthBalance",
      label: "Depth balance",
      weight: scoreWeights.depthBalance,
      score: depthBalanceScore,
      causes: [],
    },
    {
      key: "rootClarity",
      label: "Root clarity",
      weight: scoreWeights.rootClarity,
      score: rootClarityScore,
      causes: [],
    },
    {
      key: "directoryCoherence",
      label: "Directory coherence",
      weight: scoreWeights.directoryCoherence,
      score: directoryCoherenceScore,
      causes: [
        {
          key: "crossDirectoryWrongWay",
          label: "cross-directory wrong-way imports",
          rawLoss: metrics.directoryCoherence.crossDirectoryWrongWayRatio * 100 * 0.5,
          signal: `ratio ${formatPercent(metrics.directoryCoherence.crossDirectoryWrongWayRatio)}`,
        },
      ],
    },
  ];

  const scoreDragByComponent = [];
  const scoreDragByCause = [];
  componentDefinitions.forEach((component) => {
    const componentPointsLost = roundMetric((100 - component.score) * component.weight);
    const activeCauses = component.causes.filter((entry) => entry.rawLoss > 0);
    const rawLossTotal = activeCauses.reduce((sum, entry) => sum + entry.rawLoss, 0);
    scoreDragByComponent.push({
      key: component.key,
      label: component.label,
      score: component.score,
      weight: component.weight,
      pointsLost: componentPointsLost,
    });
    activeCauses.forEach((cause) => {
      const scaledPointsLost =
        rawLossTotal === 0 ? 0 : componentPointsLost * (cause.rawLoss / rawLossTotal);
      scoreDragByCause.push({
        key: `${component.key}.${cause.key}`,
        component: component.key,
        componentLabel: component.label,
        label: cause.label,
        pointsLost: roundMetric(scaledPointsLost),
        signal: cause.signal,
      });
    });
  });
  if (metrics.fileSize.extremeFileSizePenaltyPoints > 0) {
    const fileSizeComponent = scoreDragByComponent.find((entry) => entry.key === "fileSize");
    if (fileSizeComponent) {
      fileSizeComponent.pointsLost = roundMetric(
        fileSizeComponent.pointsLost + metrics.fileSize.extremeFileSizePenaltyPoints
      );
    }
    scoreDragByCause.push({
      key: "fileSize.extremeFileSizeBonus",
      component: "fileSize",
      componentLabel: "File size",
      label: "extreme file size bonus deduction",
      pointsLost: metrics.fileSize.extremeFileSizePenaltyPoints,
      signal:
        metrics.fileSize.topExtremeFiles.length > 0
          ? `${metrics.fileSize.extremeFileCount} extreme files; worst ${metrics.fileSize.topExtremeFiles[0].file} is ${metrics.fileSize.topExtremeFiles[0].lineMultiple}x the ${metrics.fileSize.maxLines}-line limit`
          : `${metrics.fileSize.extremeFileCount} extreme files`,
    });
  }
  scoreDragByComponent.sort((left, right) => right.pointsLost - left.pointsLost || left.label.localeCompare(right.label));
  scoreDragByCause.sort((left, right) => right.pointsLost - left.pointsLost || left.label.localeCompare(right.label));
  const totalPointsLost = roundMetric(100 - weightedScore);

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
  if (metrics.fileSize.measuredFiles > 0 && metrics.fileSize.oversizedFileCount === 0) {
    strengths.push(`All measured files are within ${metrics.fileSize.maxLines} lines.`);
  }

  const penalties = [];
  if (metrics.fileSize.oversizedFileCount > 0) {
    penalties.push(
      `${metrics.fileSize.oversizedFileCount} files exceed ${metrics.fileSize.maxLines} lines.`
    );
  }
  if (metrics.fileSize.extremeFileCount > 0 && metrics.fileSize.topExtremeFiles.length > 0) {
    penalties.push(
      `${metrics.fileSize.extremeFileCount} files are at least 2x over the line limit; worst is ${metrics.fileSize.topExtremeFiles[0].file} at ${metrics.fileSize.topExtremeFiles[0].lineMultiple}x.`
    );
  }
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
    score: {
      value: weightedScore,
      threshold,
      passed: thresholdPassed,
      message: thresholdMessage,
      drag: {
        totalPointsLost,
        byComponent: scoreDragByComponent,
        byCause: scoreDragByCause,
      },
      components: {
        fileSize: fileSizeScore,
        layerFlow: layerFlowScore,
        cycleBurden: cycleBurdenScore,
        depthBalance: depthBalanceScore,
        rootClarity: rootClarityScore,
        directoryCoherence: directoryCoherenceScore,
      },
      weights: scoreWeights,
    },
    metrics,
    findings: {
      strengths,
      penalties,
    },
    topOffenders,
    topLargeFiles,
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
  lines.push(`Score: ${report.score.value}/100`);
  if (report.score.message) {
    lines.push(report.score.message);
  }
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
  lines.push("Score Drag");
  lines.push(`- Total points lost vs 100: ${report.score.drag.totalPointsLost}`);
  if (report.score.drag.byCause.length === 0) {
    lines.push("- No active deductions.");
  } else {
    report.score.drag.byCause.forEach((entry) => {
      lines.push(
        `- ${entry.label}: -${entry.pointsLost} points (${entry.componentLabel}; ${entry.signal})`
      );
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

  if (report.topLargeFiles.length > 0) {
    lines.push("");
    lines.push("Top Large Files");
    report.topLargeFiles.forEach((entry) => {
      lines.push(
        `- ${entry.file} (D${entry.depth}): ${entry.lineCount} lines, ${entry.lineOverage} over ${report.metrics.fileSize.maxLines}`
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
  if (report.metrics.fileSize.measuredFiles > 0) {
    lines.push(
      `- File size: ${report.metrics.fileSize.oversizedFileCount} over ${report.metrics.fileSize.maxLines} lines, max ${report.metrics.fileSize.maxLineCount} lines`
    );
  }
  lines.push(
    `- Layer flow: ${report.metrics.layerFlow.wrongWayEdges} wrong-way, ${report.metrics.layerFlow.skipEdges} downward skips, ${report.metrics.layerFlow.sameLevelEdges} same-level`
  );
  lines.push(
    `- Cycle burden: ${report.metrics.cycleBurden.filesInCycles} files in cycles, largest SCC ${report.metrics.cycleBurden.largestSccSize}`
  );
  lines.push(
    `- Root clarity: ${report.metrics.rootClarity.rootCount} roots`
  );

  return `${lines.join("\n")}\n`;
}

function formatHealthScoreOnlyText(report) {
  const rootLabel = report.scope.root?.relative ?? "all";
  const lines = [`Structureness Health (${rootLabel})`, `Score: ${report.score.value}/100`];
  if (report.score.message) {
    lines.push(report.score.message);
  } else {
    lines.push(`PASS: ${report.score.passed === true ? "true" : "n/a"}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildHealthScoreOnlyJson(report) {
  return {
    score: report.score.value,
    threshold: report.score.threshold,
    passed: report.score.passed,
    message: report.score.message,
  };
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
      { key: "negativeImports", label: "DI", name: "Deep imports" },
      { key: "negativeExports", label: "SI", name: "Shallow importers" },
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
            threshold: options.threshold,
            top: options.top,
            maxLines: options.maxLines,
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
              ? options.scoreOnly
                ? options.healthOutput === "json"
                  ? `${JSON.stringify(buildHealthScoreOnlyJson(healthReport), null, 2)}\n`
                  : formatHealthScoreOnlyText(healthReport)
                : options.healthOutput === "json"
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
  buildHealthScoreOnlyJson,
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
  formatHealthScoreOnlyText,
  loadExportMap,
  main,
};
