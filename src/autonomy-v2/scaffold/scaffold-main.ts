import fs from 'fs';
import path from 'path';
import { getAgentDefinition } from '../../agents/AgentDefinitionRegistry.js';

function validateImplementationChecks(config, sourcePath) {
  for (const agent of config.agents || []) {
    getAgentDefinition(agent).validateScaffoldConfig(agent, sourcePath);
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
  const definition = getAgentDefinition(agent);
  const relativePath = relativeScaffoldPath(rootDir, targetPath);
  if (relativePath) {
    const diskPath = path.join(helpers.templateRoot, relativePath);
    if (fs.existsSync(diskPath)) {
      return fs.readFileSync(diskPath, 'utf8');
    }
  }

  switch (fileName) {
    case 'system.md':
      return definition.buildSystemPrompt(agent, config);
    case 'handoff.md':
      return definition.buildHandoffTemplate(agent);
    case 'log.md':
      return definition.buildLogTemplate(agent);
    default:
      return '';
  }
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



export { collectAgentScaffoldEntries };
export { getTemplateContent };
export { pruneStaleAgentScaffold };
export { resolveTemplateTargetPath };
export { validateImplementationChecks };
