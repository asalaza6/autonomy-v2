#!/usr/bin/env node

const fs = require('fs');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadAutonomyEnv } = require('./autonomy-v2-env');
const { validateAutonomyConfig } = require('./autonomy-v2-config');
const {
  DEFAULT_SYNC_STATE,
  buildPrdSpecPayload,
  commitPrdSpecToIntegrationBranch,
  syncPrdSpecsFromIntegrationBranch,
} = require('./autonomy-v2-dev-sync');
const { resolveGithubAuthToken } = require('./autonomy-v2-github');
const { withStateLock } = require('./autonomy-v2-lock');

const PACKAGE_ROOT = path.join(__dirname, '..');
const TEMPLATE_ROOT = path.join(PACKAGE_ROOT, 'templates', 'prompts', 'autonomous', 'v2');
const DEFAULT_AUTONOMY_SEGMENTS = ['prompts', 'autonomous', 'v2'];
const DEFAULT_RUNTIME_SEGMENTS = ['.autonomy', 'runtime'];
const PRD_SPECS_SEGMENTS = [...DEFAULT_AUTONOMY_SEGMENTS, 'specs', 'prds'];
const PRD_ARCHIVE_SEGMENTS = [...PRD_SPECS_SEGMENTS, 'archived'];
const DEFAULT_AUTONOMY_ENV = [
  'AUTONOMY_INITIALIZED=1',
  'GITHUB_TOKEN=',
  '',
].join('\n');
const DEFAULT_GITIGNORE = [
  '# System-generated default ignore file for autonomy-v2.',
  '# Keep this file aligned with repository bootstrap defaults.',
  '',
  '# Node / tooling artifacts',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  '.DS_Store',
  '',
  '# Env files',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '',
  '# Keep autoproduced runtime marker',
  '!.env.autonomy',
  '',
  '# Autonomy runtime state',
  '.autonomy/runtime/state/queues/*.lock',
  '.autonomy/runtime',
  '',
].join('\n');
const GENERATED_TEMPLATE_FILES = {
  'state/tasks.json': () => `${JSON.stringify({ tasks: [] }, null, 2)}\n`,
  'state/prs.json': () => `${JSON.stringify({ pullRequests: [] }, null, 2)}\n`,
  'state/leases.json': () => `${JSON.stringify({ leases: [] }, null, 2)}\n`,
  'state/branch-locks.json': () => `${JSON.stringify({ locks: [] }, null, 2)}\n`,
  'state/prds.json': () => `${JSON.stringify({ prds: [] }, null, 2)}\n`,
  'state/spec-sync.json': () => `${JSON.stringify(DEFAULT_SYNC_STATE, null, 2)}\n`,
  'state/runtime.json': () => `${JSON.stringify({ workers: {} }, null, 2)}\n`,
  '.env.autonomy': () => DEFAULT_AUTONOMY_ENV,
  '.gitignore': () => DEFAULT_GITIGNORE,
  'scripts/autonomy-v2-default-runner.js': () => `${[
    '#!/usr/bin/env node',
    '',
    "const path = require('path');",
    "const { execFileSync } = require('child_process');",
    '',
    `const PACKAGE_RUNNER_PATH = ${JSON.stringify(path.join(PACKAGE_ROOT, 'src', 'autonomy-v2-default-runner.js'))};`,
    '',
    'let TARGET_PATH = null;',
    '',
    'try {',
    "  TARGET_PATH = require.resolve('@asalaza6/autonomy-v2/default-runner');",
    '} catch (error) {',
    '  TARGET_PATH = PACKAGE_RUNNER_PATH;',
    '}',
    '',
    'if (require.main === module) {',
    '  try {',
    '    execFileSync(process.execPath, [TARGET_PATH], {',
    "      stdio: 'inherit',",
    '      env: process.env,',
    '    });',
    '  } catch (error) {',
    "    process.exit(typeof error.status === 'number' ? error.status : 1);",
    '  }',
    '} else {',
    '  module.exports = require(TARGET_PATH);',
    '}',
  ].join('\n')}\n`,
};
const BASE_TEMPLATE_FILES = [
  '.env.autonomy',
  '.gitignore',
  'README.md',
  'config/agents.json',
  'config/sprint.json',
  'state/tasks.json',
  'state/prs.json',
  'state/leases.json',
  'state/branch-locks.json',
  'state/prds.json',
  'state/spec-sync.json',
  'state/runtime.json',
  'scripts/autonomy-v2-default-runner.js',
  'specs/README.md',
  'specs/prds/archived/README.md',
];

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseCli(argv);
  const rootDir = resolveRootDir(options.root);
  loadAutonomyEnv(rootDir);

  try {
    const runCommand = (handler) => {
      if (!isMutatingCommand(command)) {
        return handler();
      }
      return withStateLock(rootDir, handler);
    };

    switch (command) {
      case 'init':
        await runCommand(() => handleInit(rootDir, options));
        break;
      case 'status':
        handleStatus(rootDir, options);
        break;
      case 'task:add':
        await runCommand(() => handleTaskAdd(rootDir, options));
        break;
      case 'task:finish':
        await runCommand(() => handleTaskFinish(rootDir, options));
        break;
      case 'task:list':
        handleTaskList(rootDir, options);
        break;
      case 'prd:add':
        await runCommand(() => handlePrdAdd(rootDir, options));
        break;
      case 'prd:list':
        handlePrdList(rootDir, options);
        break;
      case 'prd:archive-completed':
        await runCommand(() => handleArchiveCompletedPrds(rootDir, options));
        break;
      case 'lease':
        await runCommand(() => handleLease(rootDir, options));
        break;
      case 'worktree:prepare':
        await runCommand(() => handlePrepareWorktree(rootDir, options));
        break;
      case 'scope:validate':
        handleScopeValidate(rootDir, options);
        break;
      case 'pr:record':
        await runCommand(() => handlePrRecord(rootDir, options));
        break;
      case 'review:record':
        await runCommand(() => handleReviewRecord(rootDir, options));
        break;
      case 'merge':
        await runCommand(() => handleMerge(rootDir, options));
        break;
      case 'runtime:status':
        handleRuntimeStatus(rootDir, options);
        break;
      case 'help':
      case '--help':
      case '-h':
      case '':
        printHelp();
        break;
      default:
        throw new Error(`Unknown command "${command}". Run "autonomy-v2 --help".`);
    }
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

function parseCli(argv) {
  const options = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (typeof next === 'undefined' || next.startsWith('--')) {
        addOption(options, key, true);
      } else {
        addOption(options, key, next);
        index += 1;
      }
      continue;
    }

    positionals.push(token);
  }

  return {
    command: positionals[0] || '',
    options,
  };
}

function isMutatingCommand(command) {
  return new Set([
    'init',
    'task:add',
    'task:finish',
    'prd:add',
    'prd:archive-completed',
    'lease',
    'worktree:prepare',
    'pr:record',
    'review:record',
    'merge',
  ]).has(command);
}

function addOption(options, key, value) {
  if (Object.prototype.hasOwnProperty.call(options, key)) {
    if (!Array.isArray(options[key])) {
      options[key] = [options[key]];
    }
    options[key].push(value);
    return;
  }

  options[key] = value;
}

function printHelp() {
  console.log(`
Autonomy v2 CLI

Usage:
  autonomy-v2 <command> [options]

Commands:
  init
  status [--sync]
  task:add --id <id> --title <title> --agent <agent-id> [--allowed-path <glob>] [--acceptance <text>]
  task:finish --task <task-id>
  task:list [--status <status>]
  prd:add --id <id> --title <title> [--specification <text>] [--requirement <text>] [--task-spec <json>]
  prd:list [--status <status>] [--sync]
  prd:archive-completed
  lease --agent <agent-id> [--task <task-id>] [--minutes 60]
  worktree:prepare --task <task-id> [--create]
  scope:validate --task <task-id> [--files <path1,path2>] [--worktree <path>]
  pr:record --task <task-id> --head-branch <branch> [--publish]
  review:record --pr <pr-id> --reviewer <agent-id> --decision <approve|changes-requested> [--publish]
  merge --pr <pr-id> --actor <agent-id> [--execute]
  runtime:status

Global options:
  --root <path>    Use a custom repo root
  --json           Print JSON output when supported
`);
}

function resolveRootDir(rootOption) {
  if (!rootOption) {
    return process.cwd();
  }

  return path.isAbsolute(rootOption)
    ? rootOption
    : path.resolve(process.cwd(), rootOption);
}

function getAutonomyPaths(rootDir) {
  const repoAutonomyDir = path.join(rootDir, ...DEFAULT_AUTONOMY_SEGMENTS);
  const runtimeAutonomyDir = path.join(rootDir, ...DEFAULT_RUNTIME_SEGMENTS);
  const configDir = path.join(repoAutonomyDir, 'config');
  const stateDir = path.join(runtimeAutonomyDir, 'state');
  return {
    repoAutonomyDir,
    runtimeAutonomyDir,
    configDir,
    stateDir,
    queuesDir: path.join(stateDir, 'queues'),
    agentsConfig: path.join(configDir, 'agents.json'),
    sprintConfig: path.join(configDir, 'sprint.json'),
    tasksState: path.join(stateDir, 'tasks.json'),
    prsState: path.join(stateDir, 'prs.json'),
    leasesState: path.join(stateDir, 'leases.json'),
    branchLocksState: path.join(stateDir, 'branch-locks.json'),
    prdsState: path.join(stateDir, 'prds.json'),
    specSyncState: path.join(stateDir, 'spec-sync.json'),
    runtimeState: path.join(stateDir, 'runtime.json'),
  };
}

function getPrdSpecsDir(rootDir) {
  return path.join(rootDir, ...PRD_SPECS_SEGMENTS);
}

function getArchivedPrdSpecsDir(rootDir) {
  return path.join(rootDir, ...PRD_ARCHIVE_SEGMENTS);
}

function getPrdSpecPath(rootDir, prdId) {
  return path.join(getPrdSpecsDir(rootDir), `${prdId}.json`);
}

function getArchivedPrdSpecPath(rootDir, prdId) {
  return path.join(getArchivedPrdSpecsDir(rootDir), `${prdId}.json`);
}

function listCurrentPrdSpecEntries(rootDir) {
  const specsDir = getPrdSpecsDir(rootDir);
  if (!fs.existsSync(specsDir)) {
    return [];
  }
  return fs.readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const filePath = path.join(specsDir, entry.name);
      try {
        const spec = readJson(filePath);
        return {
          id: String(spec.id || entry.name.replace(/\.json$/i, '')),
          fileName: entry.name,
          filePath,
        };
      } catch (_) {
        return {
          id: entry.name.replace(/\.json$/i, ''),
          fileName: entry.name,
          filePath,
        };
      }
    });
}

function findArchivablePrdIds(prdIds, { taskQueues, prs, prds }) {
  const prdIdSet = new Set(prdIds || []);
  const prdById = new Map(((prds && prds.prds) || []).map((prd) => [prd.id, prd]));
  const tasksByPrdId = new Map();
  listTasks(taskQueues).forEach((task) => {
    if (!task || !task.prdId || !prdIdSet.has(task.prdId)) {
      return;
    }
    const tasks = tasksByPrdId.get(task.prdId) || [];
    tasks.push(task);
    tasksByPrdId.set(task.prdId, tasks);
  });
  const prsByPrdId = new Map();
  ((prs && prs.pullRequests) || []).forEach((pr) => {
    if (!pr || !pr.prdId || !prdIdSet.has(pr.prdId)) {
      return;
    }
    const pullRequests = prsByPrdId.get(pr.prdId) || [];
    pullRequests.push(pr);
    prsByPrdId.set(pr.prdId, pullRequests);
  });

  return Array.from(prdIdSet).filter((prdId) => {
    const linkedTasks = tasksByPrdId.get(prdId) || [];
    if (linkedTasks.some((task) => !isTerminalTaskStatus(task.status))) {
      return false;
    }

    const linkedPullRequests = prsByPrdId.get(prdId) || [];
    if (linkedPullRequests.some((pr) => String(pr.status || '') !== 'merged')) {
      return false;
    }
    if (linkedPullRequests.length > 0) {
      return true;
    }

    const prd = prdById.get(prdId);
    return Boolean(prd && prd.status === 'completed');
  });
}

function archiveCompletedPrdSpecs(rootDir, state) {
  const currentSpecs = listCurrentPrdSpecEntries(rootDir);
  const archivableIds = new Set(findArchivablePrdIds(
    currentSpecs.map((entry) => entry.id),
    state
  ));

  if (archivableIds.size === 0) {
    return [];
  }

  ensureDir(getArchivedPrdSpecsDir(rootDir));
  const archived = [];
  currentSpecs.forEach((entry) => {
    if (!archivableIds.has(entry.id)) {
      return;
    }
    const destinationPath = path.join(getArchivedPrdSpecsDir(rootDir), entry.fileName);
    ensureDir(path.dirname(destinationPath));
    fs.renameSync(entry.filePath, destinationPath);
    archived.push({
      id: entry.id,
      from: path.relative(rootDir, entry.filePath),
      to: path.relative(rootDir, destinationPath),
    });
  });
  return archived;
}

function handleInit(rootDir, options) {
  const bootstrapRootFiles = new Set(['.env.autonomy', '.gitignore']);
  const created = [];
  const skipped = [];
  const removed = [];
  const paths = getAutonomyPaths(rootDir);

  ensureDir(paths.configDir);
  ensureDir(paths.repoAutonomyDir);
  ensureDir(paths.runtimeAutonomyDir);

  for (const relativeFile of BASE_TEMPLATE_FILES) {
    const targetPath = resolveTemplateTargetPath(rootDir, relativeFile);
    ensureDir(path.dirname(targetPath));
    const preserveIfExists = relativeFile === 'config/agents.json' || relativeFile === 'config/sprint.json';
    const isBootstrapRootFile = bootstrapRootFiles.has(relativeFile);
    const shouldSkipExisting = fs.existsSync(targetPath)
      && (preserveIfExists || (!isBootstrapRootFile && options.force !== true));
    if (shouldSkipExisting) {
      skipped.push(relativeFile);
      continue;
    }

    const templateContent = getTemplateContent(relativeFile);
    fs.writeFileSync(targetPath, templateContent, 'utf8');
    created.push(relativeFile);
  }

  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  validateImplementationChecks(config, paths.agentsConfig);
  const agentEntries = collectAgentScaffoldEntries(rootDir, config);

  for (const entry of agentEntries) {
    ensureDir(path.dirname(entry.targetPath));
    if (fs.existsSync(entry.targetPath) && options.force !== true) {
      skipped.push(entry.relativeFile);
      continue;
    }

    fs.writeFileSync(entry.targetPath, entry.content, 'utf8');
    created.push(entry.relativeFile);
  }

  if (options.force === true) {
    removed.push(...pruneStaleAgentScaffold(rootDir, agentEntries));
  }

  const payload = {
    rootDir,
    created,
    skipped,
    removed,
  };

  printOutput(options, payload, () => {
    console.log(`Initialized autonomy v2 scaffold at ${paths.repoAutonomyDir}`);
    console.log(`Runtime state path: ${paths.runtimeAutonomyDir}`);
    console.log(`Created: ${created.length}`);
    console.log(`Skipped: ${skipped.length}`);
    if (removed.length > 0) {
      console.log(`Removed: ${removed.length}`);
    }
  });
}

function validateImplementationChecks(config, sourcePath) {
  const invalidAgents = [];

  for (const agent of config.agents || []) {
    if (String(agent.role || '').trim() !== 'implementation') {
      continue;
    }

    if (!Array.isArray(agent.checks) || agent.checks.length === 0 || agent.checks.some((check) => String(check || '').trim().length === 0)) {
      invalidAgents.push(agent.id || '(unknown)');
    }
  }

  if (invalidAgents.length > 0) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: implementation agents must define a non-empty checks array. Invalid agents: ${invalidAgents.join(', ')}.`);
  }
}

function collectAgentScaffoldEntries(rootDir, config) {
  return (config.agents || []).flatMap((agent) => {
    const systemPromptPath = resolveScaffoldPath(rootDir, agent.systemPrompt);
    const handoffPath = path.join(path.dirname(systemPromptPath), 'handoff.md');
    const logPath = getAgentLogPath(rootDir, agent.id);
    const queuePath = resolveTaskQueuePath(rootDir, config, agent.id);

    return [
      {
        relativeFile: relativeScaffoldPath(rootDir, systemPromptPath) || systemPromptPath,
        targetPath: systemPromptPath,
        content: getAgentScaffoldContent(rootDir, agent, systemPromptPath, 'system.md', config),
      },
      {
        relativeFile: relativeScaffoldPath(rootDir, handoffPath) || handoffPath,
        targetPath: handoffPath,
        content: getAgentScaffoldContent(rootDir, agent, handoffPath, 'handoff.md', config),
      },
      {
        relativeFile: relativeScaffoldPath(rootDir, logPath) || logPath,
        targetPath: logPath,
        content: getAgentScaffoldContent(rootDir, agent, logPath, 'log.md', config),
      },
      {
        relativeFile: relativeScaffoldPath(rootDir, queuePath) || queuePath,
        targetPath: queuePath,
        content: buildQueueTemplate(agent.id, agent.role),
      },
    ];
  });
}

function pruneStaleAgentScaffold(rootDir, agentEntries) {
  const desiredPaths = new Set(agentEntries.map((entry) => path.resolve(entry.targetPath)));
  const paths = getAutonomyPaths(rootDir);
  const candidateDirs = [
    path.join(paths.repoAutonomyDir, 'agents'),
    path.join(paths.runtimeAutonomyDir, 'agents'),
    path.join(paths.runtimeAutonomyDir, 'state', 'queues'),
  ];
  const removed = [];

  candidateDirs.forEach((candidateDir) => {
    pruneStaleScaffoldDirectory(candidateDir, desiredPaths, removed, rootDir);
  });

  return removed;
}

function pruneStaleScaffoldDirectory(dirPath, desiredPaths, removed, rootDir) {
  if (!fs.existsSync(dirPath)) {
    return;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.forEach((entry) => {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      pruneStaleScaffoldDirectory(entryPath, desiredPaths, removed, rootDir);
      if (fs.existsSync(entryPath) && fs.readdirSync(entryPath).length === 0) {
        fs.rmdirSync(entryPath);
      }
      return;
    }

    if (desiredPaths.has(path.resolve(entryPath))) {
      return;
    }

    fs.unlinkSync(entryPath);
    removed.push(path.relative(rootDir, entryPath));
  });
}

function resolveScaffoldPath(rootDir, relativePath) {
  if (path.isAbsolute(relativePath)) {
    return path.normalize(relativePath);
  }

  return path.join(rootDir, relativePath);
}

function relativeScaffoldPath(rootDir, absolutePath) {
  const relativePath = path.relative(rootDir, absolutePath);
  if (relativePath.startsWith('..')) {
    return null;
  }
  return relativePath;
}

function getAgentScaffoldContent(rootDir, agent, targetPath, fileName, config) {
  const relativePath = relativeScaffoldPath(rootDir, targetPath);
  if (relativePath) {
    const diskPath = path.join(TEMPLATE_ROOT, relativePath);
    if (fs.existsSync(diskPath)) {
      return fs.readFileSync(diskPath, 'utf8');
    }
  }

  switch (fileName) {
    case 'system.md':
      return buildAgentSystemPrompt(agent, config);
    case 'handoff.md':
      return buildAgentHandoffTemplate(agent);
    case 'log.md':
      return buildAgentLogTemplate(agent);
    default:
      return '';
  }
}

function buildAgentSystemPrompt(agent, config) {
  const agentLabel = getAgentDisplayName(agent);
  const integrationBranch = config.integrationBranch || 'dev';
  const productionBranch = config.productionBranch || 'main';
  const projectName = config.projectName || 'this repository';
  const scopeLines = Array.isArray(agent.include) && agent.include.length > 0
    ? agent.include.map((pattern) => `- Stay inside \`${pattern}\` unless the task explicitly expands scope.`)
    : ['- Stay inside your assigned scope.'];
  const checkLines = Array.isArray(agent.checks) && agent.checks.length > 0
    ? agent.checks.map((check) => `- ${check}`)
    : ['- Run the checks configured for your lane before publishing.'];

  if (agent.role === 'pm') {
    return [
      `# ${agentLabel} System`,
      '',
      `You are the PM agent for ${projectName}.`,
      '',
      '## Role',
      '',
      '- Watch the PRD inbox for newly inserted product requests.',
      '- Decompose each PRD into scoped implementation tasks for the feature agents.',
      '- Route tasks into the correct per-agent queues with acceptance criteria and path bounds.',
      '',
      '## Hard Rules',
      '',
      '- Do not write feature code.',
      '- Do not review or merge pull requests.',
      '- Do not create repo-wide tasks when a narrower scoped task is possible.',
      `- Always target automation at \`${integrationBranch}\`, never \`${productionBranch}\` or \`master\`.`,
      '',
      '## Workflow',
      '',
      '1. Read the next queued PRD from the PRD inbox.',
      '2. Break it into atomic tasks for the configured implementation lanes as needed.',
      '3. Assign each task to one agent queue with explicit allowed paths.',
      '4. Record the decomposition result and mark the PRD as planned.',
      '',
    ].join('\n');
  }

  if (agent.role === 'review') {
    return [
      `# ${agentLabel} System`,
      '',
      `You are the review and integration agent for ${projectName}.`,
      '',
      '## Role',
      '',
      '- Review PRs created by implementation agents.',
      '- Focus on correctness, regressions, missing tests, scope violations, and unsafe merges.',
      '- Approve or request changes.',
      `- Merge approved PRs into \`${integrationBranch}\`.`,
      '',
      '## Hard Rules',
      '',
      '- Never review your own authored work.',
      '- Do not implement feature changes while reviewing.',
      '- Treat missing required checks as blocking.',
      `- Never target \`${productionBranch}\` or \`master\`.`,
      '',
      '## Review Priorities',
      '',
      '1. Behavioral regressions',
      '2. Scope violations',
      '3. Missing or weak verification',
      '4. Merge safety',
      '5. Maintainability issues that materially affect delivery',
      '',
    ].join('\n');
  }

  return [
    `# ${agentLabel} System`,
    '',
    `You are the ${agentLabel} implementation agent for ${projectName}.`,
    '',
    '## Role',
    '',
    '- Implement only tasks assigned to you.',
    `- Work only from task branches based on \`${integrationBranch}\`.`,
    `- Open or update pull requests targeting \`${integrationBranch}\`.`,
    '',
    '## Hard Rules',
    '',
    '- Edit only files allowed by your assigned task and configured scope.',
    ...scopeLines,
    `- Do not merge to \`${productionBranch}\` or \`master\`.`,
    `- Do not merge directly to \`${integrationBranch}\`; publish changes for review.`,
    '',
    '## Required Checks',
    '',
    ...checkLines,
    '',
    '## Required Workflow',
    '',
    '1. Read your leased task and acceptance criteria.',
    '2. Work inside the assigned worktree and branch.',
    '3. Run required checks before publishing.',
    '4. Keep the diff focused on your lane.',
    '5. Update the PR when review asks for changes.',
    '',
  ].join('\n');
}

function buildAgentHandoffTemplate(agent) {
  const agentLabel = getAgentDisplayName(agent);
  return [
    `# ${agentLabel} Handoff`,
    '',
    '## Current State',
    '',
    '_No active handoff yet._',
    '',
  ].join('\n');
}

function buildAgentLogTemplate(agent) {
  const agentLabel = getAgentDisplayName(agent);
  return `# ${agentLabel} Log\n`;
}

function getAgentDisplayName(agent) {
  const source = String(agent && (agent.personaName || agent.id) || 'agent').trim();
  if (!source) {
    return 'Agent';
  }
  if (/^pm([-_\s]?agent)?$/i.test(source) || /^pm-agent$/i.test(source)) {
    return 'PM Agent';
  }
  return source
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveTemplateTargetPath(rootDir, relativeFile) {
  if (relativeFile.startsWith('.')) {
    return path.join(rootDir, relativeFile);
  }
  if (relativeFile.startsWith('scripts/')) {
    return path.join(rootDir, relativeFile);
  }
  const paths = getAutonomyPaths(rootDir);
  const baseDir = isRuntimeTemplate(relativeFile)
    ? paths.runtimeAutonomyDir
    : paths.repoAutonomyDir;
  return path.join(baseDir, relativeFile);
}

function isRuntimeTemplate(relativeFile) {
  return relativeFile.startsWith('state/') || /(^|\/)log\.md$/.test(relativeFile);
}

function getTemplateContent(relativeFile) {
  if (Object.prototype.hasOwnProperty.call(GENERATED_TEMPLATE_FILES, relativeFile)) {
    return GENERATED_TEMPLATE_FILES[relativeFile]();
  }
  const diskPath = path.join(TEMPLATE_ROOT, relativeFile);
  if (fs.existsSync(diskPath)) {
    return fs.readFileSync(diskPath, 'utf8');
  }
  return '';
}

function buildQueueTemplate(agentId, role) {
  return `${JSON.stringify({
    agentId,
    role,
    tasks: [],
  }, null, 2)}\n`;
}

function handleStatus(rootDir, options) {
  ensureInitialized(rootDir);
  syncIntegrationSpecs(rootDir, options);
  const paths = getAutonomyPaths(rootDir);
  const runtime = fs.existsSync(paths.runtimeState)
    ? readJson(paths.runtimeState)
    : { workers: {} };
  const prds = fs.existsSync(paths.prdsState)
    ? readJson(paths.prdsState)
    : { prds: [] };
  const { config, sprint, taskQueues, prs, leases, branchLocks } = loadAllState(rootDir);
  const taskCounts = countBy(listTasks(taskQueues), 'status');
  const prCounts = countBy(prs.pullRequests, 'status');
  const queues = (config.agents || []).map((agent) => {
    const queue = getTaskQueue(taskQueues, config, agent.id);
    return {
      agentId: queue.agentId,
      role: queue.role,
      taskCount: queue.tasks.length,
      statuses: countBy(queue.tasks, 'status'),
    };
  });
  const agentStatuses = buildAgentStatusSummaries({
    config,
    taskQueues,
    prs,
    leases,
    branchLocks,
    runtime,
    prds,
  });
  const pullRequestStatuses = buildPullRequestStatusSummaries({
    taskQueues,
    prs,
    runtime,
    branchLocks,
  });
  const activeLeaseDetails = buildLeaseDetails(leases, taskQueues);

  const payload = {
    configPath: path.relative(rootDir, paths.agentsConfig),
    sprintPath: path.relative(rootDir, paths.sprintConfig),
    configSchemaVersion: typeof config.schemaVersion === 'undefined' ? null : config.schemaVersion,
    integrationBranch: config.integrationBranch,
    productionBranch: config.productionBranch,
    blockedBranches: config.blockedBranches || [],
    sprint,
    agents: config.agents || [],
    agentStatuses,
    queues,
    taskCounts,
    prCounts,
    pullRequestStatuses,
    leaseCount: leases.leases.length,
    activeLeaseDetails,
    branchLockCount: branchLocks.locks.length,
  };

  printOutput(options, payload, () => {
    console.log(`Config file: ${path.relative(rootDir, paths.agentsConfig)}`);
    console.log(`Sprint file: ${path.relative(rootDir, paths.sprintConfig)}`);
    if (typeof config.schemaVersion !== 'undefined') {
      console.log(`Config schema version: ${config.schemaVersion}`);
    }
    console.log(`Integration branch: ${config.integrationBranch}`);
    console.log(`Production branch: ${config.productionBranch}`);
    console.log(`Blocked branches: ${(config.blockedBranches || []).join(', ')}`);
    console.log(`Loaded agents: ${(config.agents || []).map((agent) => `${agent.id}:${agent.role}`).join(', ')}`);
    console.log('Agent status:');
    agentStatuses.forEach((agentStatus) => {
      console.log(formatAgentStatusLine(agentStatus, { includePid: true }));
    });
    console.log(`Tasks: ${formatCountSummary(taskCounts) || 'none'}`);
    queues.forEach((queue) => {
      console.log(`Queue ${queue.agentId}: ${formatCountSummary(queue.statuses) || 'empty'}`);
    });
    console.log(`PRs: ${formatCountSummary(prCounts) || 'none'}`);
    if (pullRequestStatuses.length > 0) {
      console.log('Active PRs:');
      pullRequestStatuses.forEach((prStatus) => {
        console.log(formatPullRequestStatusLine(prStatus));
      });
    }
    console.log(`Active leases: ${leases.leases.length}${activeLeaseDetails.length > 0 ? ` | ${activeLeaseDetails.join(', ')}` : ''}`);
    console.log(`Branch locks: ${branchLocks.locks.length}`);
  });
}

function handleTaskAdd(rootDir, options) {
  ensureInitialized(rootDir);
  const { config, sprint, taskQueues } = loadAllState(rootDir);
  const taskId = requireOption(options, 'id');
  const title = requireOption(options, 'title');
  const agentId = requireOption(options, 'agent');
  const agent = getAgent(config, agentId);

  if (agent.role !== 'implementation') {
    throw new Error(`Agent "${agentId}" is not an implementation agent.`);
  }
  if (listTasks(taskQueues).some((task) => task.id === taskId)) {
    throw new Error(`Task "${taskId}" already exists.`);
  }

  const allowedPaths = getListOption(options, 'allowed-path');
  const checks = getListOption(options, 'check');
  const acceptance = getListOption(options, 'acceptance');
  const now = new Date().toISOString();
  const task = {
    id: taskId,
    title,
    description: getStringOption(options, 'description', ''),
    agentId,
    prdId: getStringOption(options, 'prd-id', ''),
    laneKey: getStringOption(options, 'lane-key', ''),
    type: getStringOption(options, 'type', 'implementation'),
    sprintId: getStringOption(options, 'sprint-id', sprint.sprintId || 'shared'),
    baseBranch: getStringOption(options, 'base-branch', sprint.defaultTaskBaseBranch || config.integrationBranch),
    allowedPaths,
    checks: checks.length > 0 ? checks : agent.checks || [],
    acceptance,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  task.laneKey = task.laneKey || buildTaskLaneKey(task);
  if (!task.prdId) {
    delete task.prdId;
  }

  getTaskQueue(taskQueues, config, agentId).tasks.push(task);
  writeTaskQueues(rootDir, config, taskQueues);
  appendAgentLog(rootDir, config, agentId, 'task:add', {
    input: {
      id: taskId,
      title,
      allowedPaths,
      acceptance,
    },
    output: {
      status: task.status,
      baseBranch: task.baseBranch,
    },
  });

  printOutput(options, task, () => {
    console.log(`Added task ${task.id} for ${task.agentId}`);
  });
}

function handleTaskFinish(rootDir, options) {
  ensureInitialized(rootDir);
  const { config, taskQueues, leases } = loadAllState(rootDir);
  const task = getTask(taskQueues, requireOption(options, 'task'));
  const queue = getTaskQueue(taskQueues, config, task.agentId);
  const taskIndex = queue.tasks.findIndex((candidate) => candidate.id === task.id);
  if (taskIndex === -1) {
    throw new Error(`Task "${task.id}" is not present in queue "${task.agentId}".`);
  }

  queue.tasks.splice(taskIndex, 1);
  leases.leases = (leases.leases || []).filter((lease) => lease.taskId !== task.id);

  const paths = getAutonomyPaths(rootDir);
  writeJson(paths.leasesState, leases);
  writeTaskQueues(rootDir, config, taskQueues);
  appendAgentLog(rootDir, config, task.agentId, 'task:finish', {
    input: {
      taskId: task.id,
      laneKey: task.laneKey || buildTaskLaneKey(task),
      type: task.type,
    },
    output: {
      removed: true,
    },
  });

  printOutput(options, task, () => {
    console.log(`Finished task ${task.id} for ${task.agentId}`);
  });
}

function handleTaskList(rootDir, options) {
  ensureInitialized(rootDir);
  const { taskQueues } = loadAllState(rootDir);
  const statusFilter = options.status;
  const agentFilter = getStringOption(options, 'agent', '');
  const filtered = listTasks(taskQueues).filter((task) => {
    if (statusFilter && task.status !== statusFilter) {
      return false;
    }
    if (agentFilter && task.agentId !== agentFilter) {
      return false;
    }
    return true;
  });

  printOutput(options, filtered, () => {
    if (filtered.length === 0) {
      console.log('No tasks found.');
      return;
    }

    filtered.forEach((task) => {
      console.log(`${task.id} | ${task.status} | ${task.agentId} | ${task.title}`);
    });
  });
}

function handlePrdAdd(rootDir, options) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const config = readJson(paths.agentsConfig);
  const id = requireOption(options, 'id');
  const title = requireOption(options, 'title');

  const now = new Date().toISOString();
  const specification = getStringOption(options, 'specification', '');
  const requirements = getListOption(options, 'requirement');
  const rawTaskSpecs = Object.prototype.hasOwnProperty.call(options, 'task-spec')
    ? (Array.isArray(options['task-spec']) ? options['task-spec'] : [options['task-spec']])
    : [];
  const taskSpecs = rawTaskSpecs.map((entry, index) => {
    try {
      const parsed = JSON.parse(String(entry));
      if (!parsed.id || !parsed.title || !parsed.agentId) {
        throw new Error('task-spec must include id, title, and agentId');
      }
      return parsed;
    } catch (error) {
      throw new Error(`Invalid --task-spec at index ${index}: ${error.message}`);
    }
  });
  if (taskSpecs.length === 0 && !specification && requirements.length === 0) {
    throw new Error('Provide at least one --task-spec or a --specification/--requirement input for PM planning.');
  }

  const prdSpec = buildPrdSpecPayload({
    id,
    title,
    createdAt: now,
    tasks: taskSpecs,
    specification,
    requirements,
  });
  const pmAgent = getAgent(config, 'pm-agent');
  const commitResult = commitPrdSpecToIntegrationBranch(rootDir, config.integrationBranch, prdSpec, {
    commitMessage: `autonomy(prd): upsert ${id}`,
    gitIdentity: pmAgent.gitIdentity,
  });
  appendAgentLog(rootDir, config, pmAgent.id, 'prd:committed', {
    input: {
      prdId: id,
      taskCount: taskSpecs.length,
      integrationBranch: config.integrationBranch,
    },
    output: {
      committed: commitResult.committed,
      pushed: commitResult.pushed,
      commitSha: commitResult.commitSha,
      specPath: commitResult.specPath,
      pushMessage: commitResult.pushMessage || null,
    },
  });

  printOutput(options, {
    ...prdSpec,
    integrationBranch: config.integrationBranch,
    commit: commitResult,
  }, () => {
    console.log(`Committed PRD spec ${id} to ${config.integrationBranch}`);
    console.log(`Spec: ${commitResult.specPath}`);
    if (commitResult.commitSha) {
      console.log(`Commit: ${commitResult.commitSha}`);
    }
    if (commitResult.pushMessage) {
      console.log(commitResult.pushMessage);
    }
  });
}

function handlePrdList(rootDir, options) {
  ensureInitialized(rootDir);
  syncIntegrationSpecs(rootDir, options);
  const paths = getAutonomyPaths(rootDir);
  const prds = fs.existsSync(paths.prdsState)
    ? readJson(paths.prdsState)
    : { prds: [] };
  const statusFilter = getStringOption(options, 'status', '');
  const filtered = prds.prds.filter((prd) => !statusFilter || prd.status === statusFilter);

  printOutput(options, filtered, () => {
    if (filtered.length === 0) {
      console.log('No PRDs found.');
      return;
    }
    filtered.forEach((prd) => {
      console.log(`${prd.id} | ${prd.status} | tasks=${(prd.tasks || []).length} | ${prd.title}`);
    });
  });
}

function handleArchiveCompletedPrds(rootDir, options) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const state = loadAllState(rootDir);
  const prds = fs.existsSync(paths.prdsState)
    ? readJson(paths.prdsState)
    : { prds: [] };
  const archived = archiveCompletedPrdSpecs(rootDir, {
    taskQueues: state.taskQueues,
    prs: state.prs,
    prds,
  });

  printOutput(options, { archived }, () => {
    if (archived.length === 0) {
      console.log('No completed PRD specs were archived.');
      return;
    }
    console.log(`Archived ${archived.length} completed PRD spec${archived.length === 1 ? '' : 's'}:`);
    archived.forEach((entry) => {
      console.log(`- ${entry.id} | ${entry.from} -> ${entry.to}`);
    });
  });
}

function handleLease(rootDir, options) {
  ensureInitialized(rootDir);
  const { config, taskQueues, leases } = loadAllState(rootDir);
  const agentId = requireOption(options, 'agent');
  getAgent(config, agentId);

  const now = Date.now();
  pruneExpiredLeases(leases, taskQueues, now);
  const queue = getTaskQueue(taskQueues, config, agentId);
  const requestedTaskId = getStringOption(options, 'task', '');
  const queuedTask = requestedTaskId
    ? queue.tasks.find((task) => task.id === requestedTaskId)
    : queue.tasks.find((task) => task.status === 'queued');
  if (!queuedTask) {
    if (requestedTaskId) {
      throw new Error(`Task "${requestedTaskId}" is not available in queue "${agentId}".`);
    }
    throw new Error(`No queued task available for agent "${agentId}".`);
  }

  if (requestedTaskId) {
    const leasableStatuses = new Set(['queued', 'changes_requested', 'conflicted', 'leased']);
    if (!leasableStatuses.has(queuedTask.status)) {
      throw new Error(`Task "${queuedTask.id}" is not available for lease from status "${queuedTask.status}".`);
    }
  }

  if (leases.leases.some((lease) => lease.taskId === queuedTask.id)) {
    throw new Error(`Task "${queuedTask.id}" is already leased.`);
  }

  const minutes = Number(getStringOption(options, 'minutes', '60'));
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('--minutes must be a positive number.');
  }

  const leasedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + minutes * 60 * 1000).toISOString();
  const lease = {
    taskId: queuedTask.id,
    agentId,
    leasedAt,
    expiresAt,
  };
  leases.leases.push(lease);
  queuedTask.status = 'leased';
  queuedTask.updatedAt = leasedAt;

  const paths = getAutonomyPaths(rootDir);
  writeJson(paths.leasesState, leases);
  writeTaskQueues(rootDir, config, taskQueues);
  appendAgentLog(rootDir, config, agentId, 'lease', {
    input: {
      minutes,
      taskId: requestedTaskId || undefined,
    },
    output: {
      taskId: queuedTask.id,
      expiresAt,
    },
  });

  printOutput(options, { task: queuedTask, lease }, () => {
    console.log(`Leased task ${queuedTask.id} to ${agentId} until ${expiresAt}`);
  });
}

function handlePrepareWorktree(rootDir, options) {
  ensureInitialized(rootDir);
  const { config, taskQueues, branchLocks } = loadAllState(rootDir);
  const taskId = requireOption(options, 'task');
  const task = getTask(taskQueues, taskId);
  const agent = getAgent(config, task.agentId);
  if (agent.role !== 'implementation' && agent.role !== 'conflict-resolution') {
    throw new Error(`Agent "${agent.id}" does not use worktree preparation.`);
  }
  const branchName = buildTaskBranchName(config, task);
  const worktreePath = buildWorktreePath(rootDir, config, task);
  const create = options.create === true;
  let mode = create ? 'created' : 'planned';

  if (create) {
    const baseRef = resolveBaseRef(rootDir, task.baseBranch || config.integrationBranch);
    ensureDir(path.dirname(worktreePath));
    const worktreeExists = fs.existsSync(worktreePath);
    const branchExists = gitRefExists(rootDir, branchName);

    if (!worktreeExists && branchExists) {
      runGitWorktreeAdd(rootDir, [worktreePath, branchName], worktreePath);
      mode = 'reused-branch';
    } else if (!worktreeExists) {
      runGitWorktreeAdd(rootDir, ['-b', branchName, worktreePath, baseRef], worktreePath);
      mode = 'created';
    } else if (!isGitWorktree(worktreePath)) {
      throw new Error(`Worktree path "${worktreePath}" exists but is not a git worktree.`);
    } else {
      mode = 'reused-worktree';
    }
    configureWorktreeGitIdentity(worktreePath, agent);
  }

  upsertBranchLock(branchLocks, {
    taskId: task.id,
    laneKey: buildTaskLaneKey(task),
    agentId: task.agentId,
    branch: branchName,
    worktreePath,
    baseBranch: task.baseBranch || config.integrationBranch,
    mode,
    updatedAt: new Date().toISOString(),
  });
  writeJson(getAutonomyPaths(rootDir).branchLocksState, branchLocks);

  const payload = {
    taskId: task.id,
    branch: branchName,
    worktreePath,
    mode,
  };
  appendAgentLog(rootDir, config, task.agentId, 'worktree:prepare', {
    input: {
      taskId: task.id,
      create,
    },
    output: payload,
  });

  printOutput(options, payload, () => {
    console.log(`${create ? 'Created' : 'Planned'} worktree for ${task.id}`);
    console.log(`Branch: ${branchName}`);
    console.log(`Worktree: ${worktreePath}`);
  });
}

function handleScopeValidate(rootDir, options) {
  ensureInitialized(rootDir);
  const { config, taskQueues } = loadAllState(rootDir);
  const task = getTask(taskQueues, requireOption(options, 'task'));
  const agent = getAgent(config, task.agentId);
  const files = collectFilesForValidation(rootDir, options);
  if (files.length === 0) {
    throw new Error('No files provided for validation. Use --files or --worktree.');
  }

  const result = evaluateScope({
    files,
    agent,
    task,
  });

  if (!result.ok) {
    process.exitCode = 1;
  }

  printOutput(options, result, () => {
    console.log(result.ok ? 'Scope validation passed.' : 'Scope validation failed.');
    if (result.violations.length > 0) {
      result.violations.forEach((violation) => {
        console.log(`- ${violation.file}: ${violation.reason}`);
      });
    }
  });
}

async function handlePrRecord(rootDir, options) {
  ensureInitialized(rootDir);
  const state = loadAllState(rootDir);
  const task = resolvePrRecordTask(state, requireOption(options, 'task'));
  const agent = getAgent(state.config, task.agentId);
  if (agent.role !== 'implementation' && agent.role !== 'conflict-resolution') {
    throw new Error(`Agent "${agent.id}" cannot publish pull requests.`);
  }
  const headBranch = requireOption(options, 'head-branch');
  const baseBranch = getStringOption(options, 'base-branch', task.baseBranch || state.config.integrationBranch);
  if ((state.config.blockedBranches || []).includes(baseBranch) || baseBranch !== state.config.integrationBranch) {
    throw new Error(`PR base branch must be ${state.config.integrationBranch}; received ${baseBranch}.`);
  }

  const laneKey = task.laneKey || buildTaskLaneKey(task);
  const explicitCompletedTaskIds = uniqueStrings(getListOption(options, 'completed-task'));
  const completedLaneTasks = listCompletedLaneTasks(state.branchLocks, task.agentId, laneKey);
  const completedTaskIds = uniqueStrings([
    ...(explicitCompletedTaskIds.length > 0 ? explicitCompletedTaskIds : [task.id]),
    ...completedLaneTasks.map((candidate) => candidate.id),
  ]);
  const laneScopeViolations = uniqueScopeViolations(completedLaneTasks.flatMap((candidate) => {
    return collectTaskScopeViolations(candidate);
  }));
  const pendingLaneTasks = listLaneTasks(state.taskQueues, task.agentId, laneKey)
    .filter((candidate) => !completedTaskIds.includes(candidate.id));
  let record = findPullRequestByLane(state.prs, task);
  const now = new Date().toISOString();
  if (!record) {
    const defaultSource = buildLaneSourceSummary(task, completedLaneTasks, pendingLaneTasks);
    record = {
      id: buildStablePullRequestId(laneKey),
      taskId: task.id,
      laneKey,
      prdId: task.prdId || null,
      sprintId: task.sprintId || null,
      agentId: task.agentId,
      sourceTitle: getStringOption(options, 'title', defaultSource.title),
      sourceBody: getStringOption(options, 'body', defaultSource.body),
      taskIds: uniqueStrings([
        ...completedLaneTasks.map((candidate) => candidate.id),
        task.id,
        ...pendingLaneTasks.map((candidate) => candidate.id),
        ...completedTaskIds,
      ]),
      completedTaskIds: completedTaskIds.slice(),
      pendingTaskIds: pendingLaneTasks.map((candidate) => candidate.id),
      allowedPaths: uniqueStrings([
        ...completedLaneTasks.flatMap((candidate) => candidate.allowedPaths || []),
        ...(task.allowedPaths || []),
        ...pendingLaneTasks.flatMap((candidate) => candidate.allowedPaths || []),
      ]),
      checks: uniqueStrings([
        ...completedLaneTasks.flatMap((candidate) => candidate.checks || []),
        ...(task.checks || []),
        ...pendingLaneTasks.flatMap((candidate) => candidate.checks || []),
      ]),
      acceptance: uniqueStrings([
        ...completedLaneTasks.flatMap((candidate) => candidate.acceptance || []),
        ...(task.acceptance || []),
        ...pendingLaneTasks.flatMap((candidate) => candidate.acceptance || []),
      ]),
      scopeViolations: laneScopeViolations.slice(),
      headBranch,
      baseBranch,
      status: pendingLaneTasks.length === 0 ? 'open' : 'building',
      reviews: [],
      createdAt: now,
      updatedAt: now,
      remote: null,
    };
    state.prs.pullRequests.push(record);
  } else {
    record.sourceTitle = getStringOption(options, 'title', record.sourceTitle || task.title);
    record.sourceBody = getStringOption(options, 'body', record.sourceBody || task.description || '');
    record.taskId = task.id;
    record.laneKey = laneKey;
    record.prdId = task.prdId || record.prdId || null;
    record.sprintId = task.sprintId || record.sprintId || null;
    record.taskIds = uniqueStrings([
      ...completedLaneTasks.map((candidate) => candidate.id),
      ...(record.taskIds || []),
      task.id,
      ...pendingLaneTasks.map((candidate) => candidate.id),
      ...completedTaskIds,
    ]);
    record.completedTaskIds = uniqueStrings([
      ...(record.completedTaskIds || []),
      ...completedTaskIds,
    ]);
    record.pendingTaskIds = pendingLaneTasks.map((candidate) => candidate.id);
    record.allowedPaths = uniqueStrings([
      ...completedLaneTasks.flatMap((candidate) => candidate.allowedPaths || []),
      ...(record.allowedPaths || []),
      ...(task.allowedPaths || []),
      ...pendingLaneTasks.flatMap((candidate) => candidate.allowedPaths || []),
    ]);
    record.checks = uniqueStrings([
      ...completedLaneTasks.flatMap((candidate) => candidate.checks || []),
      ...(record.checks || []),
      ...(task.checks || []),
      ...pendingLaneTasks.flatMap((candidate) => candidate.checks || []),
    ]);
    record.acceptance = uniqueStrings([
      ...completedLaneTasks.flatMap((candidate) => candidate.acceptance || []),
      ...(record.acceptance || []),
      ...(task.acceptance || []),
      ...pendingLaneTasks.flatMap((candidate) => candidate.acceptance || []),
    ]);
    record.scopeViolations = uniqueScopeViolations([
      ...(record.scopeViolations || []),
      ...laneScopeViolations,
    ]);
    record.headBranch = headBranch;
    record.baseBranch = baseBranch;
    record.status = pendingLaneTasks.length === 0 ? 'open' : 'building';
    record.updatedAt = now;
    delete record.conflict;
  }

  record.title = buildPersonaPrTitle(agent, record.sourceTitle);
  record.body = buildPersonaPrBody(agent, task, state.sprint, record.sourceBody);

  if (options.publish === true && (!record.remote || !record.remote.number)) {
    const repo = resolveGithubRepo(rootDir);
    const token = resolveGithubAuthToken({ required: true });
    const published = await createOrFindPullRequest(repo, token, {
      title: record.title,
      body: record.body,
      head: headBranch,
      base: baseBranch,
      draft: options.draft === true,
    });
    record.remote = {
      number: published.number,
      url: published.html_url,
    };
    const labels = buildPullRequestLabels(agent, baseBranch);
    if (labels.length > 0) {
      await addIssueLabels(repo, token, published.number, labels);
      record.labels = labels;
    }
  } else if (record.remote && record.remote.number && !record.labels) {
    const labels = buildPullRequestLabels(agent, baseBranch);
    if (labels.length > 0) {
      record.labels = labels;
    }
  }

  let reviewerTask = null;
  if (pendingLaneTasks.length === 0) {
    reviewerTask = queueReviewerTask(state.taskQueues, state.config, record, task, now);
  }
  const paths = getAutonomyPaths(rootDir);
  writeJson(paths.prsState, state.prs);
  writeTaskQueues(rootDir, state.config, state.taskQueues);
  appendAgentLog(rootDir, state.config, task.agentId, 'pr:record', {
    input: {
      taskId: task.id,
      laneKey,
      headBranch,
      baseBranch,
      completedTaskIds,
    },
    output: {
      prId: record.id,
      status: record.status,
      remote: record.remote,
      pendingTaskIds: record.pendingTaskIds,
      scopeViolations: record.scopeViolations || [],
    },
  });
  if (reviewerTask) {
    appendAgentLog(rootDir, state.config, reviewerTask.agentId, 'review:queued', {
      input: {
        prId: record.id,
        sourceTaskId: task.id,
        sourceAgentId: task.agentId,
      },
      output: {
        reviewerTaskId: reviewerTask.id,
        reviewRound: reviewerTask.reviewRound,
        status: reviewerTask.status,
      },
    });
  }

  printOutput(options, record, () => {
    console.log(`Recorded PR ${record.id} for task ${task.id}`);
    if (record.remote) {
      console.log(`Remote PR #${record.remote.number}: ${record.remote.url}`);
    }
  });
}

async function handleReviewRecord(rootDir, options) {
  ensureInitialized(rootDir);
  const state = loadAllState(rootDir);
  const pr = getPr(state.prs, requireOption(options, 'pr'));
  const reviewerId = requireOption(options, 'reviewer');
  const reviewer = getAgent(state.config, reviewerId);
  if (reviewer.role !== 'review') {
    throw new Error(`Agent "${reviewerId}" is not a reviewer.`);
  }
  if (reviewerId === pr.agentId) {
    throw new Error('Reviewer cannot review their own PR.');
  }

  const decision = normalizeReviewDecision(requireOption(options, 'decision'));
  const rawSummary = getStringOption(options, 'summary', '');
  const review = {
    reviewerId,
    decision,
    summary: rawSummary,
    publishedSummary: buildSignedReviewSummary(reviewer, rawSummary),
    reviewedAt: new Date().toISOString(),
  };
  pr.reviews.push(review);
  pr.updatedAt = review.reviewedAt;
  pr.status = decision === 'approved' ? 'approved' : 'changes_requested';

  const task = findTask(state.taskQueues, pr.taskId);
  let followupTask = null;
  if (task) {
    task.status = decision === 'approved' ? 'approved' : 'changes_requested';
    task.updatedAt = review.reviewedAt;
    if (decision === 'changes_requested') {
      task.title = `Address review for ${pr.title}`;
      task.description = rawSummary || `Address reviewer feedback for ${pr.title}`;
      task.acceptance = [task.description];
      task.type = task.type || 'review_followup';
      task.prId = pr.id;
      pr.pendingTaskIds = uniqueStrings([...(pr.pendingTaskIds || []), task.id]);
    }
  } else if (decision === 'changes_requested') {
    followupTask = enqueueLaneFollowupTask(state.taskQueues, state.config, pr, {
      id: buildLaneFollowupTaskId(pr),
      title: `Address review for ${pr.title}`,
      description: rawSummary || `Address reviewer feedback for ${pr.title}`,
      type: 'review_followup',
      createdAt: review.reviewedAt,
      updatedAt: review.reviewedAt,
    });
  }
  if (followupTask) {
    pr.taskIds = uniqueStrings([...(pr.taskIds || []), followupTask.id]);
    pr.pendingTaskIds = uniqueStrings([...(pr.pendingTaskIds || []), followupTask.id]);
  }
  const reviewerTask = ensureReviewerTask(state.taskQueues, state.config, pr, {
    id: pr.taskId,
    title: pr.sourceTitle,
    acceptance: pr.acceptance || [],
    agentId: pr.agentId,
  }, review.reviewedAt);
  reviewerTask.status = decision === 'approved' ? 'approved' : 'changes_requested';
  reviewerTask.reviewedAt = review.reviewedAt;
  reviewerTask.lastDecision = decision;
  const reviewedCommitCount = Number(pr.commitCount || (pr.remote && pr.remote.commitCount) || 0);
  if (Number.isFinite(reviewedCommitCount) && reviewedCommitCount > 0) {
    reviewerTask.reviewedCommitCount = reviewedCommitCount;
  } else {
    delete reviewerTask.reviewedCommitCount;
  }
  delete reviewerTask.lastError;
  delete reviewerTask.lastMergeFailureMessage;
  reviewerTask.updatedAt = review.reviewedAt;

  if (options.publish === true) {
    if (!pr.remote || !pr.remote.number) {
      throw new Error('Cannot publish review without a remote PR number.');
    }
    const repo = resolveGithubRepo(rootDir);
    const token = resolveGithubAuthToken({ required: true });
    try {
      await publishReview(repo, token, pr.remote.number, review);
    } catch (error) {
      if (!isSelfPullRequestReviewError(error)) {
        throw error;
      }
      await addIssueComment(repo, token, pr.remote.number, review.publishedSummary || review.summary || '');
      review.remotePublishFallback = 'issue_comment';
    }
  }

  const paths = getAutonomyPaths(rootDir);
  writeJson(paths.prsState, state.prs);
  writeTaskQueues(rootDir, state.config, state.taskQueues);
  appendAgentLog(rootDir, state.config, reviewerId, 'review:record', {
    input: {
      prId: pr.id,
      decision,
      summary: review.summary,
    },
    output: {
      reviewerTaskId: reviewerTask.id,
      status: reviewerTask.status,
    },
  });
  appendAgentLog(rootDir, state.config, pr.agentId, 'review:feedback', {
    input: {
      prId: pr.id,
      reviewerId,
    },
    output: {
      decision,
      taskStatus: task ? task.status : decision === 'approved' ? 'approved' : 'queued_followup',
    },
  });

  printOutput(options, { pr, review }, () => {
    console.log(`Recorded ${decision} review on ${pr.id}`);
  });
}

async function handleMerge(rootDir, options) {
  ensureInitialized(rootDir);
  const state = loadAllState(rootDir);
  const pr = getPr(state.prs, requireOption(options, 'pr'));
  const actorId = requireOption(options, 'actor');
  const actor = getAgent(state.config, actorId);
  const pendingLaneTasks = listLaneTasks(state.taskQueues, pr.agentId, pr.laneKey || pr.taskId);

  const evaluation = evaluateMerge({
    config: state.config,
    pr,
    actor,
  });
  if (!evaluation.ok || pendingLaneTasks.length > 0 || (pr.pendingTaskIds || []).length > 0) {
    process.exitCode = 1;
    printOutput(options, evaluation, () => {
      console.log('Merge blocked.');
      evaluation.reasons.forEach((reason) => console.log(`- ${reason}`));
      if (pendingLaneTasks.length > 0 || (pr.pendingTaskIds || []).length > 0) {
        console.log(`- pending lane tasks must be completed before merge`);
      }
    });
    return;
  }

  if (options.execute === true) {
    if (pr.remote && pr.remote.number) {
      const repo = resolveGithubRepo(rootDir);
      const token = resolveGithubAuthToken({ required: true });
      const mergeResponse = await mergePullRequest(repo, token, pr.remote.number, {
        merge_method: state.config.mergeStrategy || 'merge',
        commit_title: buildMergeCommitTitle(actor, pr),
      });
      pr.remote.mergeSha = mergeResponse.sha;
    } else {
      const mergeResponse = performLocalMerge(rootDir, state.config, pr, actor);
      if (!mergeResponse.ok) {
        const conflictedAt = new Date().toISOString();
        pr.status = 'conflicted';
        pr.updatedAt = conflictedAt;
        pr.conflict = {
          conflictedAt,
          message: mergeResponse.message,
        };
        pr.conflicts = Array.isArray(pr.conflicts) ? pr.conflicts : [];
        pr.conflicts.push({
          conflictedAt,
          message: mergeResponse.message,
        });
        const task = findTask(state.taskQueues, pr.taskId);
        if (task) {
          task.status = 'conflicted';
          task.updatedAt = conflictedAt;
        } else {
          enqueueLaneFollowupTask(state.taskQueues, state.config, pr, {
            id: buildLaneConflictTaskId(pr),
            title: `Resolve merge conflict for ${pr.title}`,
            description: mergeResponse.message,
            type: 'conflict_resolution',
            createdAt: conflictedAt,
            updatedAt: conflictedAt,
          });
        }
        const reviewerTask = getReviewerTask(state.taskQueues, state.config, pr);
        if (reviewerTask) {
          reviewerTask.status = 'blocked_conflict';
          reviewerTask.updatedAt = conflictedAt;
        }

        const paths = getAutonomyPaths(rootDir);
        writeJson(paths.prsState, state.prs);
        writeTaskQueues(rootDir, state.config, state.taskQueues);
        appendAgentLog(rootDir, state.config, actor.id, 'merge:conflict', {
          input: {
            prId: pr.id,
            baseBranch: pr.baseBranch,
          },
          output: {
            status: pr.status,
            message: mergeResponse.message,
          },
        });
        appendAgentLog(rootDir, state.config, pr.agentId, 'merge:conflict-assigned', {
          input: {
            prId: pr.id,
            reviewerId: actor.id,
          },
          output: {
            status: task ? task.status : 'queued_conflict_resolution',
            message: mergeResponse.message,
          },
        });
        throw new Error(`Merge conflict while merging ${pr.id}: ${mergeResponse.message}`);
      }

      pr.local = {
        mergeSha: mergeResponse.sha,
      };
    }
  }

  if (options.execute === true) {
    const mergedAt = new Date().toISOString();
    pr.status = 'merged';
    pr.mergedAt = mergedAt;
    pr.updatedAt = mergedAt;
    const task = findTask(state.taskQueues, pr.taskId);
    if (task) {
      task.status = 'merged';
      task.updatedAt = mergedAt;
    }
    const reviewerTask = getReviewerTask(state.taskQueues, state.config, pr);
    if (reviewerTask) {
      reviewerTask.status = 'merged';
      reviewerTask.mergedAt = mergedAt;
      delete reviewerTask.lastError;
      delete reviewerTask.lastMergeFailureMessage;
      reviewerTask.updatedAt = mergedAt;
    }

    const paths = getAutonomyPaths(rootDir);
    const prds = fs.existsSync(paths.prdsState)
      ? readJson(paths.prdsState)
      : { prds: [] };
    writeJson(paths.prsState, state.prs);
    writeTaskQueues(rootDir, state.config, state.taskQueues);
    const archivedSpecs = archiveCompletedPrdSpecs(rootDir, {
      taskQueues: state.taskQueues,
      prs: state.prs,
      prds,
    });
    appendAgentLog(rootDir, state.config, actor.id, 'merge:success', {
      input: {
        prId: pr.id,
        baseBranch: pr.baseBranch,
      },
      output: {
        status: pr.status,
        mergedAt,
        archivedSpecs: archivedSpecs.map((entry) => entry.id),
      },
    });
    appendAgentLog(rootDir, state.config, pr.agentId, 'merge:success', {
      input: {
        prId: pr.id,
        reviewerId: actor.id,
      },
      output: {
        status: task ? task.status : 'merged',
        mergedAt,
        archivedSpecs: archivedSpecs.map((entry) => entry.id),
      },
    });
  }

  printOutput(options, evaluation, () => {
    console.log(options.execute === true ? `Merged ${pr.id} into ${pr.baseBranch}` : `Merge check passed for ${pr.id}`);
  });
}

function handleRuntimeStatus(rootDir, options) {
  ensureInitialized(rootDir);
  const paths = getAutonomyPaths(rootDir);
  const runtime = fs.existsSync(paths.runtimeState)
    ? readJson(paths.runtimeState)
    : { workers: {} };
  const prds = fs.existsSync(paths.prdsState)
    ? readJson(paths.prdsState)
    : { prds: [] };
  const { config, taskQueues, prs, leases, branchLocks } = loadAllState(rootDir);
  const agentStatuses = buildAgentStatusSummaries({
    config,
    taskQueues,
    prs,
    leases,
    branchLocks,
    runtime,
    prds,
  });
  const pullRequestStatuses = buildPullRequestStatusSummaries({
    taskQueues,
    prs,
    runtime,
    branchLocks,
  });

  const payload = {
    workers: runtime.workers || {},
    agentStatuses,
    pullRequestStatuses,
    prdCounts: countBy(prds.prds || [], 'status'),
  };

  printOutput(options, payload, () => {
    console.log(`Workers: ${Object.keys(payload.workers).length}`);
    agentStatuses.forEach((agentStatus) => {
      console.log(formatAgentStatusLine(agentStatus, { includePid: true }));
    });
    if (pullRequestStatuses.length > 0) {
      console.log('Active PRs:');
      pullRequestStatuses.forEach((prStatus) => {
        console.log(formatPullRequestStatusLine(prStatus));
      });
    }
    console.log(`PRDs: ${formatCountSummary(payload.prdCounts) || 'none'}`);
  });
}

function ensureInitialized(rootDir) {
  const paths = getAutonomyPaths(rootDir);
  if (!fs.existsSync(paths.agentsConfig)) {
    throw new Error(`Autonomy v2 is not initialized under ${paths.repoAutonomyDir}. Run "autonomy-v2 init".`);
  }
}

function loadAllState(rootDir) {
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  return {
    config,
    sprint: readJson(paths.sprintConfig),
    taskQueues: readTaskQueues(rootDir, config),
    prs: readJson(paths.prsState),
    leases: readJson(paths.leasesState),
    branchLocks: readJson(paths.branchLocksState),
  };
}

function syncIntegrationSpecs(rootDir, options = {}) {
  if (options.sync !== true) {
    return null;
  }
  const paths = getAutonomyPaths(rootDir);
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  return syncPrdSpecsFromIntegrationBranch(rootDir, config.integrationBranch);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getAgentLogPath(rootDir, agentId) {
  return path.join(rootDir, ...DEFAULT_RUNTIME_SEGMENTS, 'agents', agentId, 'log.md');
}

function appendAgentLog(rootDir, config, agentId, event, payload = {}) {
  getAgent(config, agentId);
  const logPath = getAgentLogPath(rootDir, agentId);
  ensureDir(path.dirname(logPath));
  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, `# ${agentId} Log\n`, 'utf8');
  }

  const lines = [
    '',
    `## ${new Date().toISOString()} ${event}`,
  ];

  if (payload.summary) {
    lines.push(payload.summary);
  }

  appendLogSection(lines, 'Input', payload.input);
  appendLogSection(lines, 'Output', payload.output);
  fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
}

function appendLogSection(lines, heading, value) {
  if (typeof value === 'undefined') {
    return;
  }

  lines.push(`### ${heading}`);
  if (typeof value === 'string') {
    lines.push('```text');
    lines.push(value);
    lines.push('```');
    return;
  }

  lines.push('```json');
  lines.push(JSON.stringify(value, null, 2));
  lines.push('```');
}

function getAgentPersona(agent) {
  return agent.personaName || agent.id;
}

function buildPersonaTag(agent) {
  return `[${getAgentPersona(agent)}]`;
}

function ensurePrefixed(value, prefix) {
  const trimmed = String(value || '').trim();
  if (!trimmed) {
    return prefix;
  }
  return trimmed.startsWith(`${prefix} `) ? trimmed : `${prefix} ${trimmed}`;
}

function buildPersonaPrTitle(agent, title) {
  return ensurePrefixed(title, buildPersonaTag(agent));
}

function buildPersonaPrBody(agent, task, sprint, body) {
  const trimmedBody = String(body || '').trim();
  const metadata = [
    '<!-- autonomy-persona -->',
    `Agent: ${getAgentPersona(agent)}`,
    `Task: ${task.id}`,
    `Scope: ${(task.allowedPaths || []).join(', ') || 'repo-scoped'}`,
    `Run: ${task.sprintId || sprint.sprintId || 'shared'}`,
  ].join('\n');

  if (!trimmedBody) {
    return metadata;
  }

  return `${trimmedBody}\n\n${metadata}`;
}

function buildSignedReviewSummary(agent, summary) {
  const trimmed = String(summary || '').trim();
  const signature = `${agent.commentSignature || getAgentPersona(agent)}:`;
  if (!trimmed) {
    return signature;
  }
  return trimmed.startsWith(signature) ? trimmed : `${signature}\n\n${trimmed}`;
}

function buildMergeCommitTitle(actor, pr) {
  return `${buildPersonaTag(actor)} merge ${pr.title}`;
}

function buildPullRequestLabels(agent, baseBranch) {
  const labels = new Set();
  labels.add(`agent:${slugify(getAgentPersona(agent)).replace(/-agent$/, '')}`);
  labels.add(`target:${slugify(baseBranch)}`);
  for (const label of agent.prLabels || []) {
    if (label) {
      labels.add(label);
    }
  }
  return Array.from(labels);
}

function configureWorktreeGitIdentity(worktreePath, agent) {
  if (!agent.gitIdentity) {
    return;
  }

  runGit(worktreePath, ['config', 'extensions.worktreeConfig', 'true']);
  if (agent.gitIdentity.name) {
    runGit(worktreePath, ['config', '--worktree', 'user.name', agent.gitIdentity.name]);
  }
  if (agent.gitIdentity.email) {
    runGit(worktreePath, ['config', '--worktree', 'user.email', agent.gitIdentity.email]);
  }
}

function getAgent(config, agentId) {
  const agent = (config.agents || []).find((candidate) => candidate.id === agentId);
  if (!agent) {
    throw new Error(`Unknown agent "${agentId}".`);
  }
  return agent;
}

function getPr(prState, prId) {
  const pr = prState.pullRequests.find((candidate) => candidate.id === prId);
  if (!pr) {
    throw new Error(`Unknown PR "${prId}".`);
  }
  return pr;
}

function getStringOption(options, key, fallbackValue = '') {
  if (!Object.prototype.hasOwnProperty.call(options, key)) {
    return fallbackValue;
  }
  const value = options[key];
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (value[index] !== true) {
        return String(value[index]);
      }
    }
    return fallbackValue;
  }
  if (value === true) {
    return fallbackValue;
  }
  return String(value);
}

function requireOption(options, key) {
  const value = getStringOption(options, key, '');
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function getListOption(options, key) {
  if (!Object.prototype.hasOwnProperty.call(options, key)) {
    return [];
  }

  const raw = Array.isArray(options[key]) ? options[key] : [options[key]];
  return raw
    .filter((value) => value !== true)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function printOutput(options, payload, printer) {
  if (options.json === true) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printer();
}

function countBy(items, key) {
  return items.reduce((accumulator, item) => {
    const value = item[key] || 'unknown';
    accumulator[value] = (accumulator[value] || 0) + 1;
    return accumulator;
  }, {});
}

function formatCountSummary(counts) {
  return Object.entries(counts)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function normalizeLaneKey(record) {
  if (!record) {
    return '';
  }
  if (record.laneKey) {
    return String(record.laneKey);
  }
  if (record.prdId && record.agentId) {
    return `${record.prdId}:${record.agentId}`;
  }
  return '';
}

function buildAgentStatusSummaries({ config, taskQueues, prs, leases, branchLocks, runtime, prds }) {
  const prById = new Map((prs.pullRequests || []).map((pr) => [pr.id, pr]));
  const branchLockByLane = new Map(
    (branchLocks.locks || [])
      .map((lock) => [normalizeLaneKey(lock), lock])
      .filter(([laneKey]) => laneKey)
  );

  return (config.agents || []).map((agent) => {
    const queue = getTaskQueue(taskQueues, config, agent.id);
    const worker = ((runtime && runtime.workers) || {})[agent.id] || {
      agentId: agent.id,
      status: 'idle',
      pid: null,
    };
    if (agent.role === 'pm') {
      return buildPmAgentStatus(agent, worker, prds);
    }
    if (agent.role === 'review') {
      return buildReviewAgentStatus(agent, queue, worker, prById);
    }
    return buildImplementationAgentStatus(agent, queue, worker, prById, branchLockByLane);
  });
}

function buildPmAgentStatus(agent, worker, prds) {
  const pendingPrds = (prds.prds || []).filter((prd) => ['planned', 'queued', 'planning'].includes(prd.status));
  let detail = 'no PRDs awaiting planning';
  if (pendingPrds.length > 0) {
    const label = `${pendingPrds.length} PRD${pendingPrds.length === 1 ? '' : 's'} awaiting planning`;
    detail = worker.status === 'running'
      ? `planning backlog (${label})`
      : label;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }
  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
  };
}

function buildImplementationAgentStatus(agent, queue, worker, prById, branchLockByLane) {
  const activeTask = selectImplementationTaskForStatus(queue.tasks || []);
  const extraCount = countAdditionalPendingTasks(queue.tasks || [], activeTask && activeTask.id);
  const branch = activeTask ? resolveTaskBranch(activeTask, prById, branchLockByLane) : null;

  let detail = 'no queued tasks';
  if (activeTask) {
    const prefix = worker.status === 'running'
      ? ((activeTask.status === 'leased' || (activeTask.execution && activeTask.execution.status === 'waiting_for_external_agent'))
        ? 'working on'
        : 'starting')
      : (activeTask.type === 'review_followup' ? 'queued review follow-up' : 'next task');
    detail = `${prefix} ${describeImplementationTask(activeTask)}`;
  }
  if (extraCount > 0) {
    detail = `${detail} | ${extraCount} more queued`;
  }
  if (branch) {
    detail = `${detail} | branch=${branch}`;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }

  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
    activeTaskId: activeTask ? activeTask.id : null,
    branch,
  };
}

function buildReviewAgentStatus(agent, queue, worker, prById) {
  const tasks = queue.tasks || [];
  const assignedTask = tasks.find((task) => task.status === 'assigned') || null;
  const queuedTask = tasks.find((task) => task.status === 'queued') || null;
  const blockedTask = tasks.find((task) => task.status === 'changes_requested') || null;
  const extraCount = countAdditionalPendingTasks(
    tasks.filter((task) => ['assigned', 'queued', 'changes_requested'].includes(task.status)),
    (assignedTask || queuedTask || blockedTask || {}).id
  );

  let detail = 'no review tasks';
  if (worker.status === 'running' && (assignedTask || queuedTask)) {
    detail = `${assignedTask ? 'reviewing' : 'starting review of'} ${describeReviewTask(assignedTask || queuedTask, prById)}`;
  } else if (queuedTask) {
    detail = `next review ${describeReviewTask(queuedTask, prById)}`;
  } else if (blockedTask) {
    const pr = blockedTask.prId ? prById.get(blockedTask.prId) : null;
    detail = `waiting for ${blockedTask.sourceAgentId || 'implementation agent'} to address ${describeReviewTarget(pr, blockedTask.prId)}`;
  }
  if (extraCount > 0) {
    detail = `${detail} | ${extraCount} more pending`;
  }
  if (worker.status !== 'running' && worker.lastError) {
    detail = `${detail} | last error: ${summarizeStatusText(worker.lastError)}`;
  }

  return {
    agentId: agent.id,
    role: agent.role,
    workerStatus: worker.status || 'idle',
    pid: worker.pid || null,
    detail,
    activeTaskId: assignedTask ? assignedTask.id : queuedTask ? queuedTask.id : null,
  };
}

function buildPullRequestStatusSummaries({ taskQueues, prs, runtime, branchLocks }) {
  const workerByAgentId = new Map(Object.entries(((runtime && runtime.workers) || {})));
  const branchLockByLane = new Map(
    ((branchLocks && branchLocks.locks) || [])
      .map((lock) => [normalizeLaneKey(lock), lock])
      .filter(([laneKey]) => laneKey)
  );
  const tasksByPrId = new Map();
  listTasks(taskQueues).forEach((task) => {
    if (!task || !task.prId) {
      return;
    }
    const linked = tasksByPrId.get(task.prId) || [];
    linked.push(task);
    tasksByPrId.set(task.prId, linked);
  });

  return ((prs && prs.pullRequests) || [])
    .filter((pr) => isActivePullRequest(pr))
    .sort(comparePullRequestStatuses)
    .map((pr) => {
      const linkedTasks = tasksByPrId.get(pr.id) || [];
      const reviewTask = linkedTasks.find((task) => task.type === 'review') || null;
      const implementationTask = selectImplementationTaskForStatus(
        linkedTasks.filter((task) => task.type !== 'review')
      );
      return {
        prId: pr.id,
        number: pr.remote && pr.remote.number ? Number(pr.remote.number) : null,
        title: pr.title || pr.id,
        status: String(pr.status || 'open'),
        branch: pr.headBranch || resolveTaskBranch(implementationTask, new Map(), branchLockByLane) || null,
        action: describePullRequestAction(pr, reviewTask, implementationTask, workerByAgentId),
        url: pr.remote && pr.remote.url ? pr.remote.url : null,
        updatedAt: pr.updatedAt || '',
      };
    });
}

function isActivePullRequest(pr) {
  if (!pr) {
    return false;
  }
  if (String(pr.status || '') === 'merged') {
    return false;
  }
  if (pr.remote && pr.remote.mergedAt) {
    return false;
  }
  return true;
}

function comparePullRequestStatuses(left, right) {
  const leftTime = Date.parse(left && left.updatedAt || '') || 0;
  const rightTime = Date.parse(right && right.updatedAt || '') || 0;
  if (leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  const leftNumber = Number(left && left.remote && left.remote.number) || 0;
  const rightNumber = Number(right && right.remote && right.remote.number) || 0;
  if (leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }
  return String(left && left.id || '').localeCompare(String(right && right.id || ''));
}

function describePullRequestAction(pr, reviewTask, implementationTask, workerByAgentId) {
  if (implementationTask) {
    return describePullRequestImplementationAction(
      implementationTask,
      workerByAgentId.get(implementationTask.agentId) || null
    );
  }
  if (reviewTask) {
    return describePullRequestReviewAction(pr, reviewTask, workerByAgentId.get('reviewer') || null);
  }
  if (String(pr.status || '') === 'changes_requested') {
    return `waiting for ${pr.agentId || 'implementation agent'} to respond to review`;
  }
  if (String(pr.status || '') === 'approved') {
    return 'approved, waiting for merge';
  }
  if (String(pr.status || '') === 'conflicted') {
    return `waiting for ${pr.agentId || 'implementation agent'} to resolve merge conflict`;
  }
  return 'waiting for reviewer';
}

function describePullRequestImplementationAction(task, worker) {
  const agentId = task.agentId || 'implementation-agent';
  const isRunning = Boolean(
    worker
      && worker.status === 'running'
      && (task.status === 'leased' || (task.execution && task.execution.status === 'waiting_for_external_agent'))
  );
  if (task.type === 'review_followup') {
    return isRunning
      ? `${agentId} responding to review`
      : `waiting for ${agentId} to respond to review`;
  }
  if (task.type === 'conflict_resolution') {
    return isRunning
      ? `${agentId} resolving merge conflict`
      : `waiting for ${agentId} to resolve merge conflict`;
  }
  return isRunning
    ? `${agentId} updating the PR`
    : `waiting for ${agentId}`;
}

function describePullRequestReviewAction(pr, reviewTask, reviewerWorker) {
  if (reviewTask.status === 'assigned') {
    return reviewerWorker && reviewerWorker.status === 'running'
      ? 'reviewer reviewing'
      : 'reviewer assigned';
  }
  if (reviewTask.status === 'queued') {
    if (String(pr.status || '') === 'approved') {
      return reviewerWorker && reviewerWorker.status === 'running'
        ? 'reviewer retrying merge'
        : 'waiting for reviewer merge follow-up';
    }
    return reviewerWorker && reviewerWorker.status === 'running'
      ? 'reviewer reviewing'
      : 'waiting for reviewer';
  }
  if (reviewTask.status === 'changes_requested') {
    return `waiting for ${reviewTask.sourceAgentId || pr.agentId || 'implementation agent'} to respond to review`;
  }
  if (reviewTask.status === 'blocked_conflict') {
    return `waiting for ${reviewTask.sourceAgentId || pr.agentId || 'implementation agent'} to resolve merge conflict`;
  }
  if (reviewTask.status === 'approved') {
    return 'approved, waiting for merge';
  }
  return `review status: ${formatStatusLabel(reviewTask.status)}`;
}

function formatPullRequestStatusLine(prStatus) {
  const numberLabel = prStatus.number ? `PR #${prStatus.number}` : `PR ${prStatus.prId}`;
  return `${numberLabel} | ${formatStatusLabel(prStatus.status)} | ${prStatus.title} | ${prStatus.action}`;
}

function formatStatusLabel(status) {
  return String(status || 'unknown').replace(/_/g, ' ');
}

function selectImplementationTaskForStatus(tasks) {
  const pendingTasks = (tasks || []).filter((task) => !isTerminalTaskStatus(task.status));
  if (pendingTasks.length === 0) {
    return null;
  }
  return pendingTasks
    .slice()
    .sort((left, right) => {
      const rankDiff = rankImplementationTaskForStatus(left) - rankImplementationTaskForStatus(right);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    })[0];
}

function rankImplementationTaskForStatus(task) {
  if (task.execution && task.execution.status === 'waiting_for_external_agent') {
    return 0;
  }
  if (task.status === 'leased') {
    return 1;
  }
  if (task.status === 'changes_requested') {
    return 2;
  }
  if (task.status === 'conflicted') {
    return 3;
  }
  if (task.type === 'review_followup') {
    return 4;
  }
  if (task.type === 'conflict_resolution') {
    return 5;
  }
  if (task.status === 'queued') {
    return 6;
  }
  return 10;
}

function countAdditionalPendingTasks(tasks, primaryTaskId) {
  const pendingCount = (tasks || []).filter((task) => !isTerminalTaskStatus(task.status)).length;
  if (!primaryTaskId) {
    return pendingCount;
  }
  return Math.max(0, pendingCount - 1);
}

function isTerminalTaskStatus(status) {
  return ['merged', 'approved'].includes(String(status || ''));
}

function resolveTaskBranch(task, prById, branchLockByLane) {
  if (task && task.execution && task.execution.branch) {
    return task.execution.branch;
  }
  if (task && task.laneKey && branchLockByLane.has(task.laneKey)) {
    return branchLockByLane.get(task.laneKey).branch || null;
  }
  if (task && task.prId && prById.has(task.prId)) {
    return prById.get(task.prId).headBranch || null;
  }
  return null;
}

function describeImplementationTask(task) {
  const typeLabel = task.type === 'review_followup'
    ? 'review follow-up'
    : task.type === 'conflict_resolution'
      ? 'conflict resolution'
      : 'task';
  return `${typeLabel} "${task.title}" (${task.id})`;
}

function describeReviewTask(task, prById) {
  const pr = task && task.prId ? prById.get(task.prId) : null;
  return `${describeReviewTarget(pr, task && task.prId)} from ${task && task.sourceAgentId ? task.sourceAgentId : 'unknown source'}`;
}

function describeReviewTarget(pr, fallbackPrId) {
  const prLabel = pr && pr.remote && pr.remote.number
    ? `PR #${pr.remote.number}`
    : `PR ${fallbackPrId || (pr && pr.id) || 'unknown'}`;
  const prTitle = pr && pr.title ? pr.title : '';
  return prTitle ? `${prLabel} "${prTitle}"` : prLabel;
}

function summarizeStatusText(value, maxLength = 120) {
  const summary = String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
  if (summary.length <= maxLength) {
    return summary;
  }
  return `${summary.slice(0, maxLength - 1)}…`;
}

function formatAgentStatusLine(agentStatus, options = {}) {
  const parts = [
    agentStatus.agentId,
    agentStatus.role,
    agentStatus.workerStatus,
  ];
  if (options.includePid === true) {
    parts.push(`pid=${agentStatus.pid || '-'}`);
  }
  if (agentStatus.detail) {
    parts.push(agentStatus.detail);
  }
  return parts.join(' | ');
}

function buildLeaseDetails(leases, taskQueues) {
  const tasksById = new Map(listTasks(taskQueues).map((task) => [task.id, task]));
  return (leases.leases || []).map((lease) => {
    const task = tasksById.get(lease.taskId);
    if (!task) {
      return lease.taskId;
    }
    return `${task.agentId}:${task.id}`;
  });
}

function pruneExpiredLeases(leasesState, tasksState, now) {
  const expiredTaskIds = [];
  leasesState.leases = leasesState.leases.filter((lease) => {
    const active = Date.parse(lease.expiresAt) > now;
    if (!active) {
      expiredTaskIds.push(lease.taskId);
    }
    return active;
  });

  if (!tasksState || expiredTaskIds.length === 0) {
    return;
  }

  listTasks(tasksState).forEach((task) => {
    if (expiredTaskIds.includes(task.id) && task.status === 'leased') {
      task.status = 'queued';
      task.updatedAt = new Date(now).toISOString();
    }
  });
}

function resolveTaskQueuePath(rootDir, config, agentId) {
  const agent = getAgent(config, agentId);
  const relativePath = agent.taskQueue || path.join('prompts', 'autonomous', 'v2', 'state', 'queues', `${agentId}.json`);
  return path.isAbsolute(relativePath)
    ? relativePath
    : resolveRuntimeManagedPath(rootDir, relativePath);
}

function resolveRuntimeManagedPath(rootDir, relativePath) {
  const normalized = path.normalize(relativePath);
  const trackedStatePrefix = path.join(...DEFAULT_AUTONOMY_SEGMENTS, 'state');
  const runtimeStateDir = path.join(rootDir, ...DEFAULT_RUNTIME_SEGMENTS, 'state');
  if (normalized === trackedStatePrefix || normalized.startsWith(`${trackedStatePrefix}${path.sep}`)) {
    return path.join(runtimeStateDir, trimLeadingSeparator(normalized.slice(trackedStatePrefix.length)));
  }
  if (normalized === 'state' || normalized.startsWith(`state${path.sep}`)) {
    return path.join(runtimeStateDir, trimLeadingSeparator(normalized.slice('state'.length)));
  }
  return path.join(rootDir, normalized);
}

function trimLeadingSeparator(value) {
  let normalized = String(value || '');
  while (normalized.startsWith('/') || normalized.startsWith('\\')) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function buildTaskQueueState(agent, tasks = []) {
  return {
    agentId: agent.id,
    role: agent.role,
    tasks,
  };
}

function readTaskQueues(rootDir, config) {
  const paths = getAutonomyPaths(rootDir);
  const legacyTasks = fs.existsSync(paths.tasksState)
    ? (readJson(paths.tasksState).tasks || [])
    : [];

  return (config.agents || []).reduce((queues, agent) => {
    const queuePath = resolveTaskQueuePath(rootDir, config, agent.id);
    const seededTasks = legacyTasks.filter((task) => task.agentId === agent.id);
    const rawQueue = fs.existsSync(queuePath)
      ? readJson(queuePath)
      : buildTaskQueueState(agent, seededTasks);
    queues[agent.id] = buildTaskQueueState(agent, Array.isArray(rawQueue.tasks) ? rawQueue.tasks : seededTasks);
    return queues;
  }, {});
}

function writeTaskQueues(rootDir, config, taskQueues) {
  const paths = getAutonomyPaths(rootDir);
  (config.agents || []).forEach((agent) => {
    const queueState = getTaskQueue(taskQueues, config, agent.id);
    writeJson(resolveTaskQueuePath(rootDir, config, agent.id), queueState);
  });
  writeJson(paths.tasksState, { tasks: listTasks(taskQueues) });
}

function getTaskQueue(taskQueues, config, agentId) {
  if (taskQueues[agentId]) {
    return taskQueues[agentId];
  }
  const agent = getAgent(config, agentId);
  taskQueues[agentId] = buildTaskQueueState(agent, []);
  return taskQueues[agentId];
}

function listTasks(taskQueues) {
  return Object.values(taskQueues).flatMap((queue) => queue.tasks);
}

function getTask(taskQueues, taskId) {
  const task = findTask(taskQueues, taskId);
  if (task) {
    return task;
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function findTask(taskQueues, taskId) {
  for (const queue of Object.values(taskQueues)) {
    const task = queue.tasks.find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

function resolvePrRecordTask(state, taskId) {
  const liveTask = findTask(state.taskQueues, taskId);
  if (liveTask) {
    return liveTask;
  }
  const completedTask = findCompletedTask(state.branchLocks, taskId);
  if (completedTask) {
    return completedTask;
  }
  throw new Error(`Unknown task "${taskId}".`);
}

function findCompletedTask(branchLocksState, taskId) {
  for (const branchLock of (branchLocksState && branchLocksState.locks) || []) {
    const task = ((branchLock && branchLock.completedTasks) || []).find((candidate) => candidate.id === taskId);
    if (task) {
      return task;
    }
  }
  return null;
}

function buildTaskLaneKey(task) {
  if (task.laneKey) {
    return task.laneKey;
  }
  if (task.prdId) {
    return `${task.prdId}:${task.agentId}`;
  }
  return task.id;
}

function listLaneTasks(taskQueues, agentId, laneKey) {
  return Object.values(taskQueues)
    .filter((queue) => queue.agentId === agentId)
    .flatMap((queue) => queue.tasks)
    .filter((task) => buildTaskLaneKey(task) === laneKey);
}

function listCompletedLaneTasks(branchLocksState, agentId, laneKey) {
  const branchLock = findBranchLockByLane(branchLocksState, agentId, laneKey);
  if (!branchLock || !Array.isArray(branchLock.completedTasks)) {
    return [];
  }
  return branchLock.completedTasks
    .slice()
    .sort((left, right) => String(left.completedAt || '').localeCompare(String(right.completedAt || '')));
}

function getPrimaryReviewer(config) {
  const reviewer = (config.agents || []).find((agent) => agent.role === 'review');
  if (!reviewer) {
    throw new Error('No reviewer agent configured.');
  }
  return reviewer;
}

function buildReviewerTaskId(pr) {
  return `review-${pr.id}`;
}

function ensureReviewerTask(taskQueues, config, pr, sourceTask, now) {
  const reviewer = getPrimaryReviewer(config);
  const reviewerQueue = getTaskQueue(taskQueues, config, reviewer.id);
  const reviewTaskId = buildReviewerTaskId(pr);
  let reviewTask = reviewerQueue.tasks.find((candidate) => candidate.id === reviewTaskId);
  if (!reviewTask) {
    reviewTask = {
      id: reviewTaskId,
      title: `Review ${pr.title}`,
      description: `Review ${pr.id} for ${sourceTask.title}`,
      agentId: reviewer.id,
      type: 'review',
      prId: pr.id,
      sourceTaskId: sourceTask.id,
      sourceAgentId: sourceTask.agentId,
      reviewRound: (pr.reviews || []).length + 1,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };
    reviewerQueue.tasks.push(reviewTask);
  }
  return reviewTask;
}

function queueReviewerTask(taskQueues, config, pr, sourceTask, now) {
  const reviewerTask = ensureReviewerTask(taskQueues, config, pr, sourceTask, now);
  reviewerTask.title = `Review ${pr.title}`;
  reviewerTask.description = `Review ${pr.id} for ${sourceTask.title}`;
  reviewerTask.headBranch = pr.headBranch;
  reviewerTask.baseBranch = pr.baseBranch;
  reviewerTask.sourceTaskId = sourceTask.id;
  reviewerTask.sourceAgentId = sourceTask.agentId;
  reviewerTask.acceptance = sourceTask.acceptance || [];
  reviewerTask.scopeViolations = (pr.scopeViolations || []).slice();
  reviewerTask.reviewRound = (pr.reviews || []).length + 1;
  reviewerTask.status = 'queued';
  reviewerTask.updatedAt = now;
  return reviewerTask;
}

function getReviewerTask(taskQueues, config, pr) {
  const reviewer = (config.agents || []).find((agent) => agent.role === 'review');
  if (!reviewer) {
    return null;
  }
  const reviewerQueue = getTaskQueue(taskQueues, config, reviewer.id);
  return reviewerQueue.tasks.find((candidate) => candidate.id === buildReviewerTaskId(pr)) || null;
}

function enqueueLaneFollowupTask(taskQueues, config, pr, patch) {
  const queue = getTaskQueue(taskQueues, config, pr.agentId);
  const taskId = patch.id;
  let task = queue.tasks.find((candidate) => candidate.id === taskId);
  const nextDescription = String(
    patch.description
      || (task && task.description)
      || `Address reviewer feedback for ${pr.title}`
  ).trim();
  if (!task) {
    task = {
      id: taskId,
      title: patch.title,
      description: nextDescription,
      agentId: pr.agentId,
      prdId: pr.prdId || undefined,
      laneKey: pr.laneKey || pr.taskId,
      type: patch.type || 'implementation',
      sprintId: pr.sprintId || 'shared',
      baseBranch: pr.baseBranch,
      allowedPaths: (pr.allowedPaths || []).slice(),
      checks: [],
      acceptance: buildReviewFollowupAcceptance(pr, nextDescription),
      status: 'queued',
      createdAt: patch.createdAt || new Date().toISOString(),
      updatedAt: patch.updatedAt || new Date().toISOString(),
      prId: pr.id,
    };
    if (!task.prdId) {
      delete task.prdId;
    }
    queue.tasks.push(task);
    return task;
  }

  task.title = patch.title || task.title;
  task.description = nextDescription;
  task.type = patch.type || task.type;
  task.acceptance = buildReviewFollowupAcceptance(pr, nextDescription, task.acceptance);
  task.status = 'queued';
  task.updatedAt = patch.updatedAt || new Date().toISOString();
  task.prId = pr.id;
  return task;
}

function buildLaneFollowupTaskId(pr) {
  return `${pr.agentId}-followup-${pr.id}-${(pr.reviews || []).length}`;
}

function buildLaneConflictTaskId(pr) {
  const conflictCount = Array.isArray(pr.conflicts) ? pr.conflicts.length + 1 : 1;
  return `${pr.agentId}-conflict-${pr.id}-${conflictCount}`;
}

function buildReviewFollowupAcceptance(pr, description, existingAcceptance = []) {
  const explicitAcceptance = uniqueStrings(existingAcceptance || []);
  const prAcceptance = uniqueStrings((pr && pr.acceptance) || []);
  if (explicitAcceptance.length > 0 && !stringListsEqual(explicitAcceptance, prAcceptance)) {
    return explicitAcceptance;
  }
  const summary = String(description || '').trim();
  return [summary || `Address reviewer feedback for ${pr && pr.title ? pr.title : 'this PR'}`];
}

function stringListsEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function findPullRequestByLane(prState, task) {
  const laneKey = buildTaskLaneKey(task);
  return (prState.pullRequests || []).find((candidate) => {
    return candidate.agentId === task.agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function findBranchLockByLane(branchLocksState, agentId, laneKey) {
  return (branchLocksState.locks || []).find((candidate) => {
    return candidate.agentId === agentId && (candidate.laneKey || candidate.taskId) === laneKey;
  }) || null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  values.forEach((value) => {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}

function collectTaskScopeViolations(task) {
  return (task && Array.isArray(task.scopeViolations) ? task.scopeViolations : []).map((entry) => ({
    taskId: task.id,
    file: String(entry && entry.file || '').trim(),
    reason: String(entry && entry.reason || '').trim(),
  })).filter((entry) => entry.file && entry.reason);
}

function uniqueScopeViolations(values) {
  const seen = new Set();
  const output = [];
  (values || []).forEach((value) => {
    const taskId = String(value && value.taskId || '').trim();
    const file = String(value && value.file || '').trim();
    const reason = String(value && value.reason || '').trim();
    const key = `${taskId}::${file}::${reason}`;
    if (!taskId || !file || !reason || seen.has(key)) {
      return;
    }
    seen.add(key);
    output.push({ taskId, file, reason });
  });
  return output;
}

function buildLaneSourceSummary(task, completedLaneTasks, pendingLaneTasks) {
  const laneTasks = uniqueTasksById([
    ...completedLaneTasks,
    task,
    ...pendingLaneTasks,
  ]);
  if (laneTasks.length <= 1) {
    return {
      title: task.title,
      body: task.description || '',
    };
  }

  return {
    title: `${task.agentId.replace(/-agent$/, '')} lane work for ${task.prdId || task.id}`,
    body: [
      `Lane task ids: ${laneTasks.map((candidate) => candidate.id).join(', ')}`,
      `Allowed paths: ${uniqueStrings(laneTasks.flatMap((candidate) => candidate.allowedPaths || [])).join(', ')}`,
    ].join('\n'),
  };
}

function uniqueTasksById(tasks) {
  const seen = new Set();
  return (tasks || []).filter((task) => {
    const id = String(task && task.id || '');
    if (!id || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function buildTaskBranchName(config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const agentSegment = slugify(task.agentId);
  const laneSegment = slugify(buildTaskLaneKey(task));
  return `${config.branchPrefixes.task}/${sprintSegment}/${agentSegment}/${laneSegment}`;
}

function buildWorktreePath(rootDir, config, task) {
  const sprintSegment = slugify(task.sprintId || 'shared');
  const laneSegment = slugify(buildTaskLaneKey(task));
  return path.join(rootDir, config.worktreesRoot, task.agentId, `${sprintSegment}-${laneSegment}`);
}

function resolveBaseRef(rootDir, branchName) {
  const remoteRef = `origin/${branchName}`;
  if (gitRefExists(rootDir, remoteRef)) {
    return remoteRef;
  }
  if (gitRefExists(rootDir, branchName)) {
    return branchName;
  }
  throw new Error(`Base branch "${branchName}" does not exist locally or on origin.`);
}

function gitRefExists(rootDir, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      cwd: rootDir,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function isGitWorktree(worktreePath) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: worktreePath,
      stdio: 'ignore',
    });
    return true;
  } catch (_) {
    return false;
  }
}

function runGit(rootDir, args) {
  execFileSync('git', args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGitWorktreeAdd(rootDir, args, worktreePath, options = {}) {
  const runner = options.quiet === true ? runGitQuiet : runGit;
  try {
    runner(rootDir, ['worktree', 'add', ...args]);
  } catch (error) {
    const message = extractExecError(error);
    if (!fs.existsSync(worktreePath) && message.includes('missing but already registered worktree')) {
      pruneStaleWorktrees(rootDir);
      runner(rootDir, ['worktree', 'add', ...args]);
      return;
    }
    throw error;
  }
}

function pruneStaleWorktrees(rootDir) {
  try {
    runGitQuiet(rootDir, ['worktree', 'prune', '--expire', 'now']);
  } catch (_) {
    // Best-effort cleanup only.
  }
}

function upsertBranchLock(branchLocksState, nextLock) {
  const currentIndex = branchLocksState.locks.findIndex((lock) => {
    if (nextLock.laneKey && lock.laneKey) {
      return lock.laneKey === nextLock.laneKey && lock.agentId === nextLock.agentId;
    }
    return lock.taskId === nextLock.taskId;
  });
  if (currentIndex >= 0) {
    branchLocksState.locks[currentIndex] = {
      ...branchLocksState.locks[currentIndex],
      ...nextLock,
    };
    return;
  }
  branchLocksState.locks.push(nextLock);
}

function collectFilesForValidation(rootDir, options) {
  const explicitFiles = getListOption(options, 'files');
  if (explicitFiles.length > 0) {
    return explicitFiles.map(normalizeRepoPath);
  }

  if (options.worktree) {
    const worktreePath = path.isAbsolute(options.worktree)
      ? options.worktree
      : path.join(rootDir, options.worktree);
    const output = execFileSync('git', ['diff', '--name-only'], {
      cwd: worktreePath,
      encoding: 'utf8',
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(normalizeRepoPath);
  }

  return [];
}

function evaluateScope({ files, agent, task }) {
  const violations = [];
  const includeGlobs = task.allowedPaths && task.allowedPaths.length > 0 ? task.allowedPaths : agent.include || [];
  const excludeGlobs = agent.exclude || [];

  for (const file of files) {
    const inTaskScope = includeGlobs.length === 0 || matchesAnyGlob(file, includeGlobs);
    const inAgentScope = !agent.include || agent.include.length === 0 || matchesAnyGlob(file, agent.include);
    const excluded = excludeGlobs.length > 0 && matchesAnyGlob(file, excludeGlobs);

    if (!inTaskScope) {
      violations.push({ file, reason: 'outside task allowedPaths' });
      continue;
    }
    if (!inAgentScope) {
      violations.push({ file, reason: 'outside agent include scope' });
      continue;
    }
    if (excluded) {
      violations.push({ file, reason: 'matches agent exclude scope' });
    }
  }

  return {
    ok: violations.length === 0,
    files,
    includeGlobs,
    excludeGlobs,
    violations,
  };
}

function normalizeRepoPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matchesAnyGlob(filePath, globs) {
  const normalizedPath = normalizeRepoPath(filePath);
  return globs.some((glob) => globToRegExp(normalizeRepoPath(glob)).test(normalizedPath));
}

function globToRegExp(glob) {
  const placeholder = '\u0000';
  let pattern = glob.replace(/\*\*/g, placeholder);
  pattern = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  pattern = pattern.replace(/\*/g, '[^/]*');
  pattern = pattern.replace(new RegExp(placeholder, 'g'), '.*');
  return new RegExp(`^${pattern}$`);
}

function buildStablePullRequestId(laneKey) {
  return `pr-${slugify(laneKey || 'lane')}`;
}

function normalizeReviewDecision(decision) {
  if (decision === 'approve' || decision === 'approved') {
    return 'approved';
  }
  if (decision === 'changes-requested' || decision === 'changes_requested') {
    return 'changes_requested';
  }
  throw new Error(`Unsupported review decision "${decision}". Use approve or changes-requested.`);
}

function evaluateMerge({ config, pr, actor }) {
  const reasons = [];
  const mergeActors = config.mergeActors || [];
  if (mergeActors.length > 0) {
    if (!mergeActors.includes(actor.id)) {
      reasons.push(`actor ${actor.id} is not allowed to merge`);
    }
  } else if (actor.role !== 'merge') {
    reasons.push(`actor ${actor.id} is not a merge agent`);
  }
  if (pr.baseBranch !== config.integrationBranch) {
    reasons.push(`PR base branch must be ${config.integrationBranch}, received ${pr.baseBranch}`);
  }
  if ((config.blockedBranches || []).includes(pr.baseBranch)) {
    reasons.push(`PR base branch ${pr.baseBranch} is blocked`);
  }
  if (pr.status !== 'approved') {
    reasons.push(`PR status must be approved before merge, received ${pr.status}`);
  }
  if (!pr.reviews || pr.reviews.length === 0) {
    reasons.push('PR has no recorded review');
  } else {
    const latestDecision = pr.reviews[pr.reviews.length - 1].decision;
    if (latestDecision !== 'approved') {
      reasons.push(`latest review decision is ${latestDecision}`);
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    mergeStrategy: config.mergeStrategy || 'merge',
    integrationBranch: config.integrationBranch,
  };
}

function resolveGithubRepo(rootDir) {
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: rootDir,
    encoding: 'utf8',
  }).trim();

  const parsed = parseGithubRemoteUrl(remoteUrl);
  if (parsed) {
    return parsed;
  }
 
  throw new Error(`Could not parse GitHub repo from remote URL: ${remoteUrl}`);
}

function parseGithubRemoteUrl(remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsedUrl = new URL(remoteUrl);
    if (parsedUrl.hostname === 'github.com') {
      const trimmedPath = parsedUrl.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
      const segments = trimmedPath.split('/').filter(Boolean);
      if (segments.length >= 2) {
        return {
          owner: segments[0],
          repo: segments.slice(1).join('/'),
        };
      }
    }
  } catch (error) {
    // Fall back to regex parsing for non-URL formats.
  }

  const httpsMatch = remoteUrl.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
    };
  }
  return null;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }
  return value;
}

function publishPullRequest(repo, token, payload) {
  return githubRequest(repo, token, 'POST', '/pulls', payload);
}

async function createOrFindPullRequest(repo, token, payload) {
  try {
    return await publishPullRequest(repo, token, payload);
  } catch (error) {
    if (!isGithubValidationError(error)) {
      throw error;
    }
    const existing = await findPullRequestByHead(repo, token, payload.base, payload.head);
    if (existing) {
      return existing;
    }
    throw error;
  }
}

function publishReview(repo, token, pullNumber, review) {
  const event = review.decision === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES';
  return githubRequest(repo, token, 'POST', `/pulls/${pullNumber}/reviews`, {
    body: review.publishedSummary || review.summary || '',
    event,
  });
}

function mergePullRequest(repo, token, pullNumber, payload) {
  return githubRequest(repo, token, 'PUT', `/pulls/${pullNumber}/merge`, payload);
}

function addIssueLabels(repo, token, issueNumber, labels) {
  return githubRequest(repo, token, 'POST', `/issues/${issueNumber}/labels`, {
    labels,
  });
}

function addIssueComment(repo, token, issueNumber, body) {
  return githubRequest(repo, token, 'POST', `/issues/${issueNumber}/comments`, {
    body,
  });
}

async function findPullRequestByHead(repo, token, baseBranch, headBranch) {
  const pulls = await githubRequest(
    repo,
    token,
    'GET',
    `/pulls?state=all&base=${encodeURIComponent(baseBranch)}&head=${encodeURIComponent(`${repo.owner}:${headBranch}`)}`,
    null
  );
  if (!Array.isArray(pulls) || pulls.length === 0) {
    return null;
  }
  return pulls[0];
}

function performLocalMerge(rootDir, config, pr, actor) {
  const mergeRunDir = path.join(rootDir, '.autonomy', 'merge-runs');
  const mergePath = path.join(mergeRunDir, slugify(pr.id));
  const tempBranch = `merge-run-${slugify(pr.id)}`;
  const rootBranch = getCheckedOutBranch(rootDir);
  const syncRootWorktree = rootBranch === pr.baseBranch && isTrackedWorktreeClean(rootDir);
  ensureDir(mergeRunDir);
  cleanupWorktree(rootDir, mergePath);
  deleteLocalBranch(rootDir, tempBranch);

  try {
    const baseRef = resolveBaseRef(rootDir, pr.baseBranch);
    runGitWorktreeAdd(rootDir, ['--detach', mergePath, baseRef], mergePath, { quiet: true });
    runGitQuiet(mergePath, ['switch', '-c', tempBranch]);

    const strategy = config.mergeStrategy || 'merge';
    if (strategy === 'squash') {
      runGitQuiet(mergePath, ['merge', '--squash', pr.headBranch]);
      runGitQuiet(mergePath, ['commit', '-m', buildMergeCommitTitle(actor, pr)]);
    } else {
      runGitQuiet(mergePath, ['merge', '--no-ff', '--no-edit', pr.headBranch]);
    }

    const sha = runGitRead(mergePath, ['rev-parse', 'HEAD']).trim();
    runGitQuiet(rootDir, ['update-ref', `refs/heads/${pr.baseBranch}`, sha]);
    if (syncRootWorktree) {
      syncCheckedOutBranchWorktree(rootDir);
    }
    cleanupWorktree(rootDir, mergePath);
    deleteLocalBranch(rootDir, tempBranch);
    return { ok: true, sha };
  } catch (error) {
    cleanupWorktree(rootDir, mergePath);
    deleteLocalBranch(rootDir, tempBranch);
    return { ok: false, message: extractExecError(error) };
  }
}

function cleanupWorktree(rootDir, worktreePath) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
      cwd: rootDir,
      stdio: 'ignore',
    });
  } catch (_) {
    // Ignore; the path may not be a registered worktree yet.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function deleteLocalBranch(rootDir, branchName) {
  try {
    execFileSync('git', ['branch', '-D', branchName], {
      cwd: rootDir,
      stdio: 'ignore',
    });
  } catch (_) {
    // Ignore; the branch may not exist yet.
  }
}

function getCheckedOutBranch(rootDir) {
  try {
    return execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || null;
  } catch (_) {
    return null;
  }
}

function isTrackedWorktreeClean(rootDir) {
  return execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() === '';
}

function syncCheckedOutBranchWorktree(rootDir) {
  execFileSync('git', ['reset', '--hard', 'HEAD'], {
    cwd: rootDir,
    stdio: 'ignore',
  });
}

function runGitQuiet(cwd, args) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runGitRead(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function extractExecError(error) {
  if (error.stderr) {
    return String(error.stderr).trim();
  }
  if (error.stdout) {
    return String(error.stdout).trim();
  }
  return error.message;
}

function githubRequest(repo, token, method, endpoint, payload) {
  const body = payload ? JSON.stringify(payload) : null;
  const options = {
    hostname: 'api.github.com',
    path: `/repos/${repo.owner}/${repo.repo}${endpoint}`,
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'autonomy-v2',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };

  if (body) {
    options.headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const request = https.request(options, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        const parsed = raw ? JSON.parse(raw) : {};
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(parsed);
          return;
        }
        const error = new Error(`GitHub API ${response.statusCode}: ${parsed.message || raw}`);
        error.statusCode = response.statusCode;
        error.payload = parsed;
        reject(error);
      });
    });

    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function isGithubValidationError(error) {
  return Boolean(error && error.statusCode === 422);
}

function isSelfPullRequestReviewError(error) {
  if (!error) {
    return false;
  }
  const payloadErrors = Array.isArray(error.payload && error.payload.errors)
    ? error.payload.errors
    : [];
  return payloadErrors.some((entry) => String(entry || '').toLowerCase().includes('own pull request'));
}

module.exports = {
  archiveCompletedPrdSpecs,
  buildAgentStatusSummaries,
  buildMergeCommitTitle,
  buildPersonaPrBody,
  buildPersonaPrTitle,
  buildPullRequestStatusSummaries,
  buildPullRequestLabels,
  buildSignedReviewSummary,
  buildTaskBranchName,
  buildWorktreePath,
  evaluateMerge,
  evaluateScope,
  extractExecError,
  findArchivablePrdIds,
  globToRegExp,
  matchesAnyGlob,
  main,
  normalizeReviewDecision,
  parseGithubRemoteUrl,
  performLocalMerge,
  parseCli,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
