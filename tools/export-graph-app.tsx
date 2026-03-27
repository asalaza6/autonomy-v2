/** @jsxImportSource preact */
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

type SortKey = "depth" | "file" | "negativeImports" | "negativeExports" | "balance";
type SortState = {
  key: SortKey;
  direction: "asc" | "desc";
};

type TreeFile = {
  id: string;
  path: string;
  label: string;
  relative: string;
  directory: string;
  imports: string[];
};

type TreeEdge = {
  source: string;
  target: string;
};

type TreeGridData = {
  files: TreeFile[];
  edges: TreeEdge[];
  roots: string[];
};

type GraphPayload = {
  useTree: boolean;
  mermaidDefinition: string;
  mermaidInit: Record<string, unknown>;
  stats: {
    exports: number;
    importers: number;
    edges: number;
  };
  treeGridData: TreeGridData | null;
};

type TreeRow = {
  id: string;
  path: string;
  label: string;
  depth: number;
  imports: string[];
  importPaths: string[];
  exportPaths: string[];
  negativeImports: number;
  negativeExports: number;
  balance: number;
  negativeImportFiles: string[];
  negativeExportFiles: string[];
  balanceFiles: string[];
};

type TreeViewState = {
  selectedRootId: string;
  levelByFile: Map<string, number>;
  visibleFiles: Set<string>;
  filteredEdges: TreeEdge[];
  visiblePaths: string[];
  fileLookup: Map<string, TreeFile>;
  levels: Map<number, string[]>;
  fileRows: TreeRow[];
  maxDepth: number;
};

type TreeDepthState = {
  selectedRootId: string;
  fileById: Map<string, TreeFile>;
  visibleFiles: Set<string>;
  filteredEdges: TreeEdge[];
  levelByFile: Map<string, number>;
};

declare global {
  interface Window {
    __EXPORT_GRAPH_DATA__?: GraphPayload;
    __EXPORT_GRAPH_DEBUG__?: {
      activeRoot: string;
      sort: SortState;
      treeState: TreeViewState | null;
      buildTreeDepthState: typeof buildTreeDepthState;
    };
    mermaid?: {
      initialize: (config: Record<string, unknown>) => void;
      run: (options: { nodes: Element[] }) => Promise<void>;
    };
  }
}

const styles = `
  *, *::before, *::after { box-sizing: border-box; }

  :root {
    color-scheme: light;
    --bg: #f8fafc;
    --panel: rgba(255, 255, 255, 0.82);
    --panel-solid: #ffffff;
    --panel-muted: #f8fafc;
    --line: #cbd5e1;
    --line-strong: #94a3b8;
    --text: #0f172a;
    --muted: #475569;
    --accent: #2563eb;
    --shadow: 0 16px 48px rgba(15, 23, 42, 0.08);
    --radius-lg: 18px;
    --radius-md: 14px;
    --radius-sm: 10px;
    --mono: "SF Mono", "Menlo", monospace;
    --sans: "Inter", "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-family: var(--sans);
    background: var(--bg);
    color: var(--text);
  }

  body {
    margin: 0;
    min-height: 100vh;
    font-family: var(--sans);
    background:
      radial-gradient(circle at top left, rgba(59, 130, 246, 0.08), transparent 30%),
      linear-gradient(180deg, #eff6ff 0%, #f8fafc 100%);
  }

  button, input, select, textarea { font: inherit; }

  .page {
    width: min(1560px, 100%);
    margin: 0 auto;
    padding: clamp(12px, 1.8vw, 28px);
  }

  .meta {
    margin-bottom: 16px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel);
    backdrop-filter: blur(10px);
  }

  .graph-shell {
    padding: 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel-solid);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .graph-stage {
    display: grid;
    gap: 16px;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  .graph-shell.tree-mode .graph-stage {
    grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  }

  .graph-toolbar {
    display: grid;
    gap: 12px;
    align-items: start;
    margin-bottom: 12px;
  }

  .toolbar-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .graph-toolbar button {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
    color: var(--text);
    padding: 6px 12px;
    cursor: pointer;
  }

  .graph-toolbar button:hover {
    background: var(--panel-muted);
  }

  .toolbar-spacer {
    margin-left: auto;
  }

  .toolbar-status {
    color: var(--muted);
    font-size: 12px;
    font-family: var(--mono);
  }

  .root-controls {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 4px;
  }

  .root-strip {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    white-space: nowrap;
  }

  .root-button {
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 6px 12px;
    background: #fff;
    cursor: pointer;
  }

  .root-button.active {
    background: #e2e8f0;
    border-color: #334155;
  }

  .graph-frame {
    width: 100%;
    min-height: 520px;
    max-height: calc(100vh - 240px);
    overflow: auto;
    white-space: nowrap;
    border: 1px dashed var(--line);
    border-radius: var(--radius-md);
    scrollbar-width: thin;
    overscroll-behavior: contain;
  }

  .mermaid-container {
    width: 100%;
    min-width: 100%;
    max-width: 100%;
    overflow: visible;
    padding: 4px 0 4px 2px;
  }

  .mermaid-content {
    display: inline-block;
    width: auto;
    min-width: 100%;
    transform-origin: top left;
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

  .analytics-panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel-muted);
    padding: 12px;
    max-height: calc(100vh - 240px);
    overflow: auto;
  }

  .analytics-panel h2 {
    margin: 0 0 10px;
    font-size: 13px;
    line-height: 1.2;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: #334155;
  }

  .analytics-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }

  .analytics-chip {
    border: 1px solid var(--line);
    border-radius: 999px;
    background: #fff;
    padding: 4px 8px;
    font-size: 12px;
    color: var(--muted);
  }

  .analytics-grid {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) 72px 72px 56px;
    gap: 4px 6px;
    align-items: center;
  }

  .analytics-head {
    appearance: none;
    border: 0;
    background: transparent;
    padding: 0 0 8px;
    text-align: left;
    cursor: pointer;
    position: relative;
    font-size: 11px;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--line);
    margin-bottom: 2px;
  }

  .analytics-row { display: contents; }

  .analytics-cell {
    min-width: 0;
    font-size: 11px;
    line-height: 1.15;
  }

  .analytics-depth, .analytics-number {
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }

  .analytics-number {
    padding-left: 2px;
    position: relative;
  }

  .analytics-file {
    position: relative;
    overflow: visible;
    color: var(--text);
    padding-right: 8px;
  }

  .analytics-file-label {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .analytics-count {
    display: inline-block;
    min-width: 1ch;
  }

  .analytics-tooltip {
    position: absolute;
    left: 0;
    top: calc(100% + 8px);
    z-index: 20;
    display: none;
    min-width: 180px;
    max-width: 320px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: #fff;
    color: var(--text);
    box-shadow: 0 16px 32px rgba(15, 23, 42, 0.16);
    text-transform: none;
    letter-spacing: normal;
    font-weight: 500;
    white-space: normal;
  }

  .analytics-file .analytics-tooltip {
    min-width: 320px;
    max-width: 520px;
  }

  .analytics-sort:hover .analytics-tooltip,
  .analytics-sort:focus-visible .analytics-tooltip,
  .analytics-number:hover .analytics-tooltip,
  .analytics-number:focus-within .analytics-tooltip,
  .analytics-file:hover .analytics-tooltip,
  .analytics-file:focus-within .analytics-tooltip {
    display: block;
  }

  .analytics-tooltip strong,
  .analytics-tooltip-label {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #334155;
  }

  .analytics-tooltip ul {
    margin: 8px 0 0;
    padding: 0 0 0 16px;
  }

  .analytics-tooltip li {
    margin: 0 0 2px;
  }

  .analytics-tooltip-path {
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
  }

  .analytics-tooltip-depth {
    color: #64748b;
    font-variant-numeric: tabular-nums;
  }

  .error {
    padding: 12px;
    color: #b91c1c;
    white-space: pre-wrap;
    font-family: var(--mono);
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

  @media (max-width: 980px) {
    .graph-shell.tree-mode .graph-stage {
      grid-template-columns: 1fr;
    }

    .analytics-panel {
      max-height: 420px;
    }
  }

  @media (max-width: 720px) {
    .page {
      padding: 12px;
    }

    .graph-shell {
      padding: 12px;
      border-radius: 14px;
    }

    .graph-frame {
      min-height: 440px;
      max-height: calc(100vh - 220px);
    }

    .toolbar-row {
      align-items: stretch;
    }

    .toolbar-spacer {
      display: none;
    }

    .toolbar-status {
      width: 100%;
      text-align: right;
    }

    .root-strip {
      flex-wrap: nowrap;
    }
  }
`;

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeMermaidLabel(value: string): string {
  return escapeHtml(value);
}

function sanitizeId(value: string): string {
  return String(value ?? "").replaceAll(/[^a-zA-Z0-9_]/g, "_");
}

function relativeDirLabel(filePath: string): string {
  const normalizedPath = String(filePath ?? "").replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments.slice(0, -1).join("/") || ".";
}

function getFileName(filePath: string): string {
  const normalizedPath = String(filePath ?? "").replaceAll("\\", "/");
  const segments = normalizedPath.split("/");
  return segments[segments.length - 1] || normalizedPath;
}

function loadMermaid(init: Record<string, unknown>) {
  return new Promise<NonNullable<Window["mermaid"]>>((resolve, reject) => {
    if (window.mermaid) {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: "neutral",
        maxEdges: 5000,
        maxTextSize: 1000000,
        ...init,
      });
      resolve(window.mermaid);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-mermaid-loader="true"]');
    if (existing) {
      existing.addEventListener("load", () => {
        if (!window.mermaid) {
          reject(new Error("Mermaid loaded without a global runtime."));
          return;
        }
        window.mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          maxEdges: 5000,
          maxTextSize: 1000000,
          ...init,
        });
        resolve(window.mermaid);
      }, { once: true });
      existing.addEventListener("error", () => reject(new Error("Failed to load Mermaid.")), {
        once: true,
      });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    script.async = true;
    script.dataset.mermaidLoader = "true";
    script.addEventListener("load", () => {
      if (!window.mermaid) {
        reject(new Error("Mermaid loaded without a global runtime."));
        return;
      }
      window.mermaid.initialize({
        startOnLoad: false,
        theme: "neutral",
        maxEdges: 5000,
        maxTextSize: 1000000,
        ...init,
      });
      resolve(window.mermaid);
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("Failed to load Mermaid.")), {
      once: true,
    });
    document.head.appendChild(script);
  });
}

function compareAnalyticsRows(left: TreeRow, right: TreeRow, sort: SortState): number {
  const direction = sort.direction === "desc" ? -1 : 1;
  let comparison = 0;

  if (sort.key === "file") {
    comparison =
      left.label.localeCompare(right.label) ||
      left.path.localeCompare(right.path) ||
      left.id.localeCompare(right.id);
  } else {
    comparison = (left[sort.key] ?? 0) - (right[sort.key] ?? 0);
    if (comparison === 0 && sort.key !== "depth") {
      comparison = left.depth - right.depth;
    }
    if (comparison === 0) {
      comparison = left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
    }
  }

  return comparison * direction;
}

function buildVisibleTreeGraph(treeGridData: TreeGridData, rootFileId = "all") {
  const fileById = new Map(treeGridData.files.map((entry) => [entry.id, entry]));
  const allFileIds = new Set(fileById.keys());
  const selectedRootId =
    rootFileId === "all"
      ? "all"
      : rootFileId && allFileIds.has(rootFileId)
        ? rootFileId
        : treeGridData.roots[0] ?? "all";
  const visibleFiles = new Set<string>();

  if (selectedRootId !== "all") {
    const queue = [selectedRootId];
    while (queue.length > 0) {
      const source = queue.shift();
      if (!source || visibleFiles.has(source)) {
        continue;
      }

      visibleFiles.add(source);
      treeGridData.edges.forEach(({ source: edgeSource, target }) => {
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

  const filteredEdges = treeGridData.edges.filter(
    ({ source, target }) => visibleFiles.has(source) && visibleFiles.has(target)
  );

  return {
    selectedRootId,
    fileById,
    visibleFiles,
    filteredEdges,
  };
}

function buildCondensedDepthLevels(visibleFiles: Set<string>, filteredEdges: TreeEdge[]) {
  const outgoingByFile = new Map<string, string[]>();
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

  const indexByFile = new Map<string, number>();
  const lowLinkByFile = new Map<string, number>();
  const componentByFile = new Map<string, number>();
  const stack: string[] = [];
  const stackMembers = new Set<string>();
  const components: string[][] = [];
  let currentIndex = 0;

  function strongConnect(fileId: string) {
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

    const componentId = components.length;
    const members: string[] = [];

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

    components.push(members.sort());
  }

  Array.from(visibleFiles)
    .sort()
    .forEach((fileId) => {
      if (!indexByFile.has(fileId)) {
        strongConnect(fileId);
      }
    });

  const outgoingByComponent = new Map<number, Set<number>>();
  const incomingCounts = new Map<number, number>();
  components.forEach((_, componentId) => {
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

  const levelByComponent = new Map<number, number>();
  let frontier = Array.from(incomingCounts.entries())
    .filter(([, incoming]) => incoming === 0)
    .map(([componentId]) => componentId)
    .sort((left, right) => left - right);

  frontier.forEach((componentId) => {
    levelByComponent.set(componentId, 0);
  });

  const remainingIncoming = new Map(incomingCounts);

  while (frontier.length > 0) {
    const nextFrontier: number[] = [];
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

  const levelByFile = new Map<string, number>();
  componentByFile.forEach((componentId, fileId) => {
    const level = levelByComponent.get(componentId);
    if (level === undefined) {
      throw new Error(`Missing component level for ${fileId}.`);
    }
    levelByFile.set(fileId, level);
  });

  return levelByFile;
}

function buildTreeDepthState(treeGridData: TreeGridData, rootFileId = "all"): TreeDepthState {
  const { selectedRootId, fileById, filteredEdges, visibleFiles } = buildVisibleTreeGraph(
    treeGridData,
    rootFileId
  );
  const levelByFile = buildCondensedDepthLevels(visibleFiles, filteredEdges);

  return {
    selectedRootId,
    fileById,
    visibleFiles,
    filteredEdges,
    levelByFile,
  };
}

function buildTreeViewState(treeGridData: TreeGridData, rootFileId: string, sort: SortState): TreeViewState {
  const { selectedRootId, fileById, filteredEdges, levelByFile, visibleFiles } = buildTreeDepthState(
    treeGridData,
    rootFileId
  );

  const visiblePaths = Array.from(visibleFiles)
    .map((fileId) => fileById.get(fileId)?.path ?? null)
    .filter((value): value is string => Boolean(value))
    .sort();

  const fileLookup = new Map(treeGridData.files.map((entry) => [entry.path, entry]));
  const levels = new Map<number, string[]>();
  for (const [fileId, level] of levelByFile.entries()) {
    const file = fileById.get(fileId);
    if (!file) {
      continue;
    }
    const entries = levels.get(level) ?? [];
    entries.push(file.path);
    levels.set(level, entries);
  }

  const fileRows = Array.from(visibleFiles)
    .map((fileId) => {
      const file = fileById.get(fileId);
      if (!file) {
        return null;
      }

      return {
        id: file.id,
        path: file.path,
        label: file.label,
        depth: levelByFile.get(file.id) ?? 0,
        imports: Array.from(new Set(file.imports ?? [])).sort(),
        importPaths: [],
        exportPaths: [],
        negativeImports: 0,
        negativeExports: 0,
        balance: 0,
        negativeImportFiles: [],
        negativeExportFiles: [],
        balanceFiles: [],
      } satisfies TreeRow;
    })
    .filter((entry): entry is TreeRow => Boolean(entry));

  const fileRowsByPath = new Map(fileRows.map((row) => [row.path, row]));
  fileRows.forEach((sourceRow) => {
    sourceRow.imports.forEach((importedPath) => {
      const targetRow = fileRowsByPath.get(importedPath);
      if (!targetRow) {
        return;
      }

      sourceRow.importPaths.push(targetRow.path);
      targetRow.exportPaths.push(sourceRow.path);

      const currentDepth = sourceRow.depth;
      const importDepth = targetRow.depth;
      const exportDepth = sourceRow.depth;
      const exportedCurrentDepth = targetRow.depth;

      if (importDepth < currentDepth) {
        sourceRow.negativeImports += 1;
        sourceRow.negativeImportFiles.push(targetRow.path);
      }
      if (exportDepth > exportedCurrentDepth) {
        targetRow.negativeExports += 1;
        targetRow.negativeExportFiles.push(sourceRow.path);
      }
      if (exportDepth === exportedCurrentDepth) {
        sourceRow.balance += 1;
        sourceRow.balanceFiles.push(targetRow.path);
      }
    });
  });

  fileRows.forEach((row) => {
    row.importPaths = Array.from(new Set(row.importPaths)).sort();
    row.exportPaths = Array.from(new Set(row.exportPaths)).sort();
    row.negativeImportFiles = Array.from(new Set(row.negativeImportFiles)).sort();
    row.negativeExportFiles = Array.from(new Set(row.negativeExportFiles)).sort();
    row.balanceFiles = Array.from(new Set(row.balanceFiles)).sort();
  });

  fileRows.sort((left, right) => compareAnalyticsRows(left, right, sort));

  return {
    selectedRootId,
    levelByFile,
    visibleFiles,
    filteredEdges,
    visiblePaths,
    fileLookup,
    levels,
    fileRows,
    maxDepth: fileRows.reduce((max, entry) => Math.max(max, entry.depth), 0),
  };
}

function buildTreeMermaid(treeGridData: TreeGridData, state: TreeViewState): string {
  const lines = [
    `%% ${state.visiblePaths.length} files, ${treeGridData.files.length} total files, ${state.filteredEdges.length} edges`,
    "flowchart TD",
    "direction TB",
    "classDef fileNode fill:#e2e8f0,stroke:#334155,stroke-width:1px,color:#0f172a;",
    "classDef fileRoot fill:#f8fafc,stroke:#0f172a,stroke-width:1px,color:#0f172a,stroke-dasharray: 3 3;",
  ];

  Array.from(state.levels.keys())
    .sort((left, right) => left - right)
    .forEach((level) => {
      lines.push(`subgraph file_level_${level}["Depth ${level}"]`);
      lines.push("direction TB");

      const filesInLevel = state.levels.get(level) ?? [];
      filesInLevel.sort().forEach((filePath) => {
        const file = state.fileLookup.get(filePath);
        if (!file) {
          return;
        }
        lines.push(`${sanitizeId(file.id)}["${escapeMermaidLabel(getFileName(filePath))}"]`);
      });

      lines.push("end");
    });

  Array.from(state.visibleFiles).forEach((fileId) => {
    if ((state.levelByFile.get(fileId) ?? 0) === 0) {
      lines.push(`class ${sanitizeId(fileId)} fileRoot;`);
      return;
    }
    lines.push(`class ${sanitizeId(fileId)} fileNode;`);
  });

  Array.from(
    new Set(state.filteredEdges.map(({ source, target }) => `${sanitizeId(source)}=>${sanitizeId(target)}`))
  )
    .sort()
    .forEach((edgeId) => {
      const [source, target] = edgeId.split("=>");
      if (source && target) {
        lines.push(`${source} --> ${target}`);
      }
    });

  return lines.join("\n");
}

function tooltipList(files: string[]) {
  const uniqueFiles = [...new Set(files.filter(Boolean))].sort();
  if (uniqueFiles.length === 0) {
    return <div>None</div>;
  }

  return (
    <ul>
      {uniqueFiles.map((filePath) => (
        <li key={filePath}>{getFileName(filePath)}</li>
      ))}
    </ul>
  );
}

function popoverList(files: string[], rowsByPath: Map<string, TreeRow>) {
  const entries = files
    .map((filePath) => {
      const entry = rowsByPath.get(filePath);
      if (!entry) {
        return null;
      }
      return { path: filePath, depth: entry.depth };
    })
    .filter((entry): entry is { path: string; depth: number } => Boolean(entry))
    .sort((left, right) => left.depth - right.depth || left.path.localeCompare(right.path));

  if (entries.length === 0) {
    return <div>None</div>;
  }

  return (
    <ul>
      {entries.map((entry) => (
        <li key={entry.path}>
          <span class="analytics-tooltip-path">{entry.path}</span>{" "}
          <span class="analytics-tooltip-depth">(D{entry.depth})</span>
        </li>
      ))}
    </ul>
  );
}

function App({ payload }: { payload: GraphPayload }) {
  const graphFrameRef = useRef<HTMLDivElement>(null);
  const mermaidContentRef = useRef<HTMLDivElement>(null);
  const mermaidDiagramRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(1);
  const autoFitRef = useRef(false);

  const [mermaidApi, setMermaidApi] = useState<Window["mermaid"] | null>(null);
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const [currentScale, setCurrentScale] = useState(1);
  const [activeRoot, setActiveRoot] = useState(
    payload.useTree && payload.treeGridData?.roots.length ? payload.treeGridData.roots[0] : "all"
  );
  const [sort, setSort] = useState<SortState>({ key: "depth", direction: "asc" });

  useEffect(() => {
    loadMermaid(payload.mermaidInit)
      .then((api) => {
        setMermaidApi(api);
      })
      .catch((error) => {
        setMermaidError(
          error instanceof Error
            ? error.message
            : "Mermaid failed to load. Check network access or open this file in a browser with internet access."
        );
      });
  }, [payload.mermaidInit]);

  const treeState =
    payload.useTree && payload.treeGridData
      ? buildTreeViewState(payload.treeGridData, activeRoot, sort)
      : null;
  const diagramDefinition =
    payload.useTree && payload.treeGridData && treeState
      ? buildTreeMermaid(payload.treeGridData, treeState)
      : payload.mermaidDefinition;

  function clampScale(value: number): number {
    return Math.max(0.08, value);
  }

  function getDiagramWidth(): number {
    const svg = mermaidDiagramRef.current?.querySelector("svg");
    if (!svg) {
      return 0;
    }
    const renderedWidth = svg.getBoundingClientRect().width || (svg as SVGSVGElement).clientWidth || 0;
    if (renderedWidth > 0) {
      return renderedWidth;
    }
    if ((svg as SVGSVGElement).viewBox?.baseVal?.width) {
      return (svg as SVGSVGElement).viewBox.baseVal.width;
    }
    return 0;
  }

  function getDiagramHeight(): number {
    const svg = mermaidDiagramRef.current?.querySelector("svg");
    if (!svg) {
      return 0;
    }
    if ((svg as SVGSVGElement).viewBox?.baseVal?.height) {
      return (svg as SVGSVGElement).viewBox.baseVal.height;
    }
    return svg.getBoundingClientRect().height || (svg as SVGSVGElement).clientHeight || 0;
  }

  function renderZoom(level: number, labelValue: string | null = null) {
    const scale = clampScale(level);
    scaleRef.current = scale;
    setCurrentScale(scale);

    if (mermaidContentRef.current) {
      mermaidContentRef.current.style.transform = `scale(${scale})`;
      const height = getDiagramHeight();
      if (height > 0) {
        mermaidContentRef.current.style.minHeight = `${Math.ceil(height * scale)}px`;
      }
    }

    if (labelValue !== null) {
      const zoomLevel = document.getElementById("zoomLevel");
      if (zoomLevel) {
        zoomLevel.textContent = labelValue;
      }
    }
  }

  function centerGraphView() {
    const graphFrame = graphFrameRef.current;
    if (!graphFrame) {
      return;
    }
    requestAnimationFrame(() => {
      const maxScrollLeft = Math.max(0, graphFrame.scrollWidth - graphFrame.clientWidth);
      graphFrame.scrollLeft = maxScrollLeft / 2;
      graphFrame.scrollTop = 0;
    });
  }

  function getRenderedNode(nodeId: string): Element | null {
    const root = mermaidDiagramRef.current;
    if (!root || !nodeId) {
      return null;
    }

    const selectors = [`#${nodeId}`, `[data-id="${nodeId}"]`, `[id="${nodeId}"]`];
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      if (node) {
        return node;
      }
    }
    return null;
  }

  function centerRootNode(rootId: string) {
    const graphFrame = graphFrameRef.current;
    if (!graphFrame) {
      return;
    }

    if (!rootId || rootId === "all") {
      centerGraphView();
      return;
    }

    requestAnimationFrame(() => {
      const node = getRenderedNode(sanitizeId(rootId));
      if (!node) {
        centerGraphView();
        return;
      }

      const frameRect = graphFrame.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const frameCenterX = frameRect.left + frameRect.width / 2;
      const nodeCenterX = nodeRect.left + nodeRect.width / 2;
      const scrollDeltaX = (nodeCenterX - frameCenterX) / (scaleRef.current || 1);

      graphFrame.scrollLeft = Math.max(0, graphFrame.scrollLeft + scrollDeltaX);
      graphFrame.scrollTop = 0;
    });
  }

  function fitToWidth() {
    const graphFrame = graphFrameRef.current;
    const zoomLevel = document.getElementById("zoomLevel");
    const diagramWidth = getDiagramWidth();
    if (!graphFrame || !diagramWidth) {
      return;
    }

    const frameWidth = graphFrame.clientWidth - 24;
    const nextScale = Math.min(1, frameWidth / diagramWidth);
    autoFitRef.current = true;
    renderZoom(nextScale);
    if (zoomLevel) {
      zoomLevel.textContent = "Fit";
    }
    centerRootNode(activeRoot);
  }

  useEffect(() => {
    if (!mermaidApi || !mermaidDiagramRef.current) {
      return;
    }

    const diagram = mermaidDiagramRef.current;
    diagram.textContent = diagramDefinition;
    diagram.style.display = "block";
    diagram.style.width = "auto";
    diagram.removeAttribute("data-processed");
    setMermaidError(null);

    mermaidApi
      .run({ nodes: [diagram] })
      .then(() => {
        requestAnimationFrame(() => {
          renderZoom(scaleRef.current);
          if (autoFitRef.current) {
            fitToWidth();
          } else {
            centerRootNode(activeRoot);
          }
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setMermaidError(`Mermaid render error: ${message}`);
      });
  }, [activeRoot, diagramDefinition, mermaidApi]);

  useEffect(() => {
    const graphFrame = graphFrameRef.current;
    if (!graphFrame) {
      return;
    }

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) {
        return;
      }

      event.preventDefault();
      autoFitRef.current = false;
      const pinchFactor = Math.exp(-event.deltaY * 0.0015);
      renderZoom(scaleRef.current * pinchFactor);
    };

    graphFrame.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      graphFrame.removeEventListener("wheel", onWheel);
    };
  }, []);

  useEffect(() => {
    const onResize = () => {
      if (autoFitRef.current) {
        fitToWidth();
      }
    };

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [activeRoot]);

  useEffect(() => {
    if (payload.useTree) {
      autoFitRef.current = true;
    }
  }, [payload.useTree]);

  const zoomLabel = `${Math.round(currentScale * 100)}%`;
  const rowsByPath = new Map((treeState?.fileRows ?? []).map((row) => [row.path, row]));

  useEffect(() => {
    window.__EXPORT_GRAPH_DEBUG__ = {
      activeRoot,
      sort,
      treeState,
      buildTreeDepthState,
    };

    return () => {
      delete window.__EXPORT_GRAPH_DEBUG__;
    };
  }, [activeRoot, sort, treeState]);

  return (
    <>
      <style>{styles}</style>
      <main class="page">
        <div class="meta">
          {payload.stats.exports} exports, {payload.stats.importers} importers, {payload.stats.edges} edges
        </div>
        <section class={`graph-shell${payload.useTree ? " tree-mode" : ""}`}>
          <div class="graph-toolbar">
            {payload.useTree && payload.treeGridData ? (
              <div class="root-controls">
                <div class="root-strip">
                  <button
                    type="button"
                    class={`root-button${activeRoot === "all" ? " active" : ""}`}
                    onClick={() => {
                      autoFitRef.current = false;
                      setActiveRoot("all");
                    }}
                  >
                    All Files
                  </button>
                  {payload.treeGridData.roots.map((rootId) => {
                    const file = payload.treeGridData?.files.find((entry) => entry.id === rootId);
                    if (!file) {
                      return null;
                    }
                    return (
                      <button
                        key={rootId}
                        type="button"
                        class={`root-button${activeRoot === rootId ? " active" : ""}`}
                        onClick={() => {
                          autoFitRef.current = false;
                          setActiveRoot(rootId);
                        }}
                      >
                        {file.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div class="toolbar-row">
              <button
                id="zoomFit"
                type="button"
                onClick={() => {
                  fitToWidth();
                }}
              >
                Fit width
              </button>
              <button
                id="zoomOut"
                type="button"
                onClick={() => {
                  autoFitRef.current = false;
                  renderZoom(scaleRef.current - 0.1);
                }}
              >
                −
              </button>
              <button
                id="zoomIn"
                type="button"
                onClick={() => {
                  autoFitRef.current = false;
                  renderZoom(scaleRef.current + 0.1);
                }}
              >
                ＋
              </button>
              <button
                id="zoomReset"
                type="button"
                onClick={() => {
                  autoFitRef.current = false;
                  renderZoom(1);
                }}
              >
                100%
              </button>
              <span class="toolbar-spacer" />
              <span id="zoomLevel" class="toolbar-status">
                {zoomLabel}
              </span>
              <span class="sr-only" aria-live="polite" id="zoomStatus" />
            </div>
          </div>
          <div class="graph-stage">
            <div ref={graphFrameRef} class="graph-frame">
              <div class="mermaid-container">
                <div ref={mermaidContentRef} class="mermaid-content">
                  <div ref={mermaidDiagramRef} class="mermaid" />
                  {mermaidError ? <pre class="error">{mermaidError}</pre> : null}
                </div>
              </div>
            </div>
            {payload.useTree && treeState ? (
              <aside class="analytics-panel" aria-label="Depth analytics">
                <h2>Depth Analytics</h2>
                <div class="analytics-summary">
                  <span class="analytics-chip">{treeState.fileRows.length} files</span>
                  <span class="analytics-chip">{treeState.filteredEdges.length} edges</span>
                  <span class="analytics-chip">Max depth {treeState.maxDepth}</span>
                </div>
                <div class="analytics-grid" role="table" aria-label="Files ordered by depth">
                  {(
                    [
                      [
                        "depth",
                        "D",
                        "Depth of the file in the current tree. Lower numbers are closer to the root.",
                      ],
                      ["file", "File", "The file name for each visible node in the tree."],
                      [
                        "negativeImports",
                        "NI",
                        "Negative imports. Counts this file's imports to files at a higher depth number.",
                      ],
                      [
                        "negativeExports",
                        "NE",
                        "Negative exports. Counts lower-depth files that import this file from above.",
                      ],
                      ["balance", "B", "Balanced links. Counts imports from files at the same depth."],
                    ] as const
                  ).map(([key, label, explanation]) => {
                    const isActive = sort.key === key;
                    const suffix = isActive ? (sort.direction === "asc" ? " ↑" : " ↓") : "";
                    return (
                      <button
                        key={key}
                        type="button"
                        class="analytics-head analytics-sort"
                        aria-label={`${label}: ${explanation}`}
                        onClick={() => {
                          if (sort.key === key) {
                            setSort({
                              key,
                              direction: sort.direction === "asc" ? "desc" : "asc",
                            });
                            return;
                          }
                          setSort({
                            key,
                            direction: key === "file" ? "asc" : "desc",
                          });
                        }}
                      >
                        {label}
                        {suffix}
                        <span class="analytics-tooltip">
                          <strong>{label}</strong>
                          {explanation}
                        </span>
                      </button>
                    );
                  })}
                  {treeState.fileRows.map((row) => (
                    <div key={row.id} class="analytics-row">
                      <div class="analytics-cell analytics-depth">{row.depth}</div>
                      <div class="analytics-cell analytics-file" title={row.path}>
                        <span class="analytics-file-label">{row.label}</span>
                        <span class="analytics-tooltip">
                          <div class="analytics-tooltip-section">
                            <strong class="analytics-tooltip-label">Imports</strong>
                            {popoverList(row.importPaths, rowsByPath)}
                          </div>
                          <div class="analytics-tooltip-section">
                            <strong class="analytics-tooltip-label">Exports</strong>
                            {popoverList(row.exportPaths, rowsByPath)}
                          </div>
                        </span>
                      </div>
                      <div class="analytics-cell analytics-number">
                        <span class="analytics-count" title={getFileName(row.path)}>
                          {row.negativeImports}
                        </span>
                        <span class="analytics-tooltip">{tooltipList(row.negativeImportFiles)}</span>
                      </div>
                      <div class="analytics-cell analytics-number">
                        <span class="analytics-count" title={getFileName(row.path)}>
                          {row.negativeExports}
                        </span>
                        <span class="analytics-tooltip">{tooltipList(row.negativeExportFiles)}</span>
                      </div>
                      <div class="analytics-cell analytics-number">
                        <span class="analytics-count" title={getFileName(row.path)}>
                          {row.balance}
                        </span>
                        <span class="analytics-tooltip">{tooltipList(row.balanceFiles)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </aside>
            ) : null}
          </div>
        </section>
      </main>
    </>
  );
}

const payload = window.__EXPORT_GRAPH_DATA__;

if (!payload) {
  throw new Error("Missing export graph payload.");
}

const root = document.getElementById("app");
if (!root) {
  throw new Error("Missing app root.");
}

render(<App payload={payload} />, root);
