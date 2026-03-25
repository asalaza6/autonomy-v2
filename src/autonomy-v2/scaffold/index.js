const fs = require('fs');
const path = require('path');
const { getAgentDefinition } = require('../../agents/AgentDefinitionRegistry');
const {
  AGENT_ROLES,
  buildRoleScopedLabel,
  getRoleAgentLabel,
  getRoleLabel,
  isImplementationRole,
  isPmRole,
  isReviewRole,
} = require('../../agents/role-catalog');

function validateImplementationChecks(config, sourcePath) {
  const invalidAgents = [];

  for (const agent of config.agents || []) {
    if (!isImplementationRole(agent.role)) {
      continue;
    }

    if (!Array.isArray(agent.checks) || agent.checks.length === 0 || agent.checks.some((check) => String(check || '').trim().length === 0)) {
      invalidAgents.push(agent.id || '(unknown)');
    }
  }

  if (invalidAgents.length > 0) {
    throw new Error(`Invalid autonomy config at ${sourcePath}: ${buildRoleScopedLabel(AGENT_ROLES.IMPLEMENTATION, 'agents')} must define a non-empty checks array. Invalid agents: ${invalidAgents.join(', ')}.`);
  }
}

function collectAgentScaffoldEntries(rootDir, config, helpers) {
  return (config.agents || []).flatMap((agent) => {
    const systemPromptPath = resolveScaffoldPath(rootDir, agent.systemPrompt);
    const handoffPath = path.join(path.dirname(systemPromptPath), 'handoff.md');
    const logPath = helpers.getAgentLogPath(rootDir, agent.id);
    const queuePath = helpers.resolveTaskQueuePath(rootDir, config, agent.id);

    return [
      {
        relativeFile: relativeScaffoldPath(rootDir, systemPromptPath) || systemPromptPath,
        targetPath: systemPromptPath,
        content: getAgentScaffoldContent(rootDir, agent, systemPromptPath, 'system.md', config, helpers),
      },
      {
        relativeFile: relativeScaffoldPath(rootDir, handoffPath) || handoffPath,
        targetPath: handoffPath,
        content: getAgentScaffoldContent(rootDir, agent, handoffPath, 'handoff.md', config, helpers),
      },
      {
        relativeFile: relativeScaffoldPath(rootDir, logPath) || logPath,
        targetPath: logPath,
        content: getAgentScaffoldContent(rootDir, agent, logPath, 'log.md', config, helpers),
      },
      {
        relativeFile: relativeScaffoldPath(rootDir, queuePath) || queuePath,
        targetPath: queuePath,
        content: buildQueueTemplate(agent.id, agent.role),
      },
    ];
  });
}

function pruneStaleAgentScaffold(rootDir, agentEntries, helpers) {
  const desiredPaths = new Set(agentEntries.map((entry) => path.resolve(entry.targetPath)));
  const paths = helpers.getAutonomyPaths(rootDir);
  const candidateDirs = [
    path.join(paths.repoAutonomyDir, 'agents'),
    path.join(paths.repoAutonomyDir, 'queues'),
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

function getAgentScaffoldContent(rootDir, agent, targetPath, fileName, config, helpers) {
  const relativePath = relativeScaffoldPath(rootDir, targetPath);
  if (relativePath) {
    const diskPath = path.join(helpers.templateRoot, relativePath);
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

  if (isPmRole(agent.role)) {
    return [
      `# ${agentLabel} System`,
      '',
      `You are the ${getRoleAgentLabel(AGENT_ROLES.PM)} for ${projectName}.`,
      '',
      '## Role',
      '',
      '- Watch the PRD inbox for newly inserted product requests.',
      `- Decompose each PRD into scoped ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} tasks for the feature agents.`,
      '- Route tasks into the correct per-agent queues with concrete acceptance criteria.',
      '',
      '## Hard Rules',
      '',
      '- Do not write feature code.',
      `- Do not ${getRoleLabel(AGENT_ROLES.REVIEW)} or merge pull requests.`,
      '- Do not create repo-wide tasks when a narrower scoped task is possible.',
      `- Always target automation at \`${integrationBranch}\`, never \`${productionBranch}\` or \`master\`.`,
      '',
      '## Workflow',
      '',
      '1. Read the next queued PRD from the PRD inbox.',
      `2. Break it into atomic tasks for the configured ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} lanes as needed.`,
      '3. Assign each task to one agent queue that already owns the needed scope.',
      '4. Record the decomposition result and mark the PRD as planned.',
      '',
    ].join('\n');
  }

  if (isReviewRole(agent.role)) {
    return [
      `# ${agentLabel} System`,
      '',
      `You are the ${getRoleLabel(AGENT_ROLES.REVIEW)} and integration agent for ${projectName}.`,
      '',
      '## Role',
      '',
      `- ${getRoleLabel(AGENT_ROLES.REVIEW)[0].toUpperCase()}${getRoleLabel(AGENT_ROLES.REVIEW).slice(1)} PRs created by ${buildRoleScopedLabel(AGENT_ROLES.IMPLEMENTATION, 'agents')}.`,
      '- Focus on correctness, regressions, missing tests, scope violations, and unsafe merges.',
      '- Approve or request changes.',
      `- Merge approved PRs into \`${integrationBranch}\`.`,
      '',
      '## Hard Rules',
      '',
      `- Never ${getRoleLabel(AGENT_ROLES.REVIEW)} your own authored work.`,
      `- Do not implement feature changes while ${getRoleLabel(AGENT_ROLES.REVIEW)}.`,
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
    `You are the ${agentLabel} ${getRoleLabel(AGENT_ROLES.IMPLEMENTATION)} agent for ${projectName}.`,
    '',
    '## Role',
    '',
    '- Implement only tasks assigned to you.',
    `- Work only from task branches based on \`${integrationBranch}\`.`,
    `- Open or update pull requests targeting \`${integrationBranch}\`.`,
    '',
    '## Hard Rules',
    '',
    '- Edit only files within your configured agent scope.',
    ...scopeLines,
    `- Do not merge to \`${productionBranch}\` or \`master\`.`,
    `- Do not merge directly to \`${integrationBranch}\`; publish changes for ${getRoleLabel(AGENT_ROLES.REVIEW)}.`,
    '',
    '## Required Checks',
    '',
    ...checkLines,
    '',
    '## Required Workflow',
    '',
    '1. Read your current tracked queue task and acceptance criteria.',
    '2. Work inside the assigned worktree and branch.',
    '3. Run required checks before publishing.',
    '4. Keep the diff focused on your lane.',
    `5. Update the PR when ${getRoleLabel(AGENT_ROLES.REVIEW)} asks for changes.`,
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
  if (new RegExp(`^${AGENT_ROLES.PM}([-_\\s]?agent)?$`, 'i').test(source) || new RegExp(`^${AGENT_ROLES.PM}-agent$`, 'i').test(source)) {
    return 'PM Agent';
  }
  return source
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveTemplateTargetPath(rootDir, relativeFile, helpers) {
  if (relativeFile.startsWith('.')) {
    return path.join(rootDir, relativeFile);
  }
  if (relativeFile.startsWith('scripts/')) {
    return path.join(rootDir, relativeFile);
  }
  const paths = helpers.getAutonomyPaths(rootDir);
  const baseDir = isRuntimeTemplate(relativeFile)
    ? paths.runtimeAutonomyDir
    : paths.repoAutonomyDir;
  return path.join(baseDir, relativeFile);
}

function isRuntimeTemplate(relativeFile) {
  return relativeFile.startsWith('state/') || /(^|\/)log\.md$/.test(relativeFile);
}

function getTemplateContent(relativeFile, helpers) {
  if (Object.prototype.hasOwnProperty.call(helpers.generatedTemplateFiles, relativeFile)) {
    return helpers.generatedTemplateFiles[relativeFile]();
  }
  const diskPath = path.join(helpers.templateRoot, relativeFile);
  if (fs.existsSync(diskPath)) {
    return fs.readFileSync(diskPath, 'utf8');
  }
  return '';
}

function buildQueueTemplate(agentId, role) {
  return `${JSON.stringify(
    getAgentDefinition(role).buildQueueState({ id: agentId, role }, []),
    null,
    2
  )}\n`;
}

module.exports = {
  buildQueueTemplate,
  collectAgentScaffoldEntries,
  getTemplateContent,
  pruneStaleAgentScaffold,
  resolveTemplateTargetPath,
  validateImplementationChecks,
};
