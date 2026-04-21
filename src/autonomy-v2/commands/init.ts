import fs from 'fs';
import path from 'path';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { collectAgentScaffoldEntries, getTemplateContent, pruneStaleAgentScaffold, resolveTemplateTargetPath, validateImplementationChecks, } from '../scaffold/scaffold-main.js';
import { BASE_TEMPLATE_FILES, GENERATED_TEMPLATE_FILES, TEMPLATE_ROOT, ensureDir, getAgentLogPath, getAutonomyPaths, printOutput, readJson, } from './shared-core.js';
import { resolveTaskQueuePath } from './shared-queues.js';

function run(rootDir, options) {
  const created = [];
  const skipped = [];
  const removed = [];
  const updated = [];
  const paths = getAutonomyPaths(rootDir);

  ensureDir(paths.configDir);
  ensureDir(paths.repoAutonomyDir);
  ensureDir(paths.runtimeAutonomyDir);

  for (const relativeFile of BASE_TEMPLATE_FILES) {
    const targetPath = resolveTemplateTargetPath(rootDir, relativeFile, {
      getAutonomyPaths,
    });
    ensureDir(path.dirname(targetPath));
    const templateContent = getTemplateContent(relativeFile, {
      generatedTemplateFiles: GENERATED_TEMPLATE_FILES,
      templateRoot: TEMPLATE_ROOT,
    });
    if (relativeFile === '.gitignore') {
      const gitignoreResult = mergeGitignore(targetPath, templateContent);
      if (gitignoreResult === 'created') {
        created.push(relativeFile);
      } else if (gitignoreResult === 'updated') {
        updated.push(relativeFile);
      } else {
        skipped.push(relativeFile);
      }
      continue;
    }

    const preserveIfExists = relativeFile === '.env.autonomy'
      || relativeFile === 'project-context.md'
      || relativeFile === 'config/agents.json'
      || relativeFile === 'config/control-plane.json'
      || relativeFile === 'config/sprint.json';
    const shouldSkipExisting = fs.existsSync(targetPath)
      && (preserveIfExists || options.force !== true);
    if (shouldSkipExisting) {
      skipped.push(relativeFile);
      continue;
    }

    fs.writeFileSync(targetPath, templateContent, 'utf8');
    created.push(relativeFile);
  }

  if (options.force === true) {
    [
      path.join(paths.stateDir, 'tasks.json'),
      path.join(paths.stateDir, 'prds.json'),
    ].forEach((stalePath) => {
      if (!fs.existsSync(stalePath)) {
        return;
      }
      fs.rmSync(stalePath, { force: true });
      removed.push(path.relative(rootDir, stalePath));
    });
  }

  const rawConfigText = fs.readFileSync(paths.agentsConfig, 'utf8');
  const config = validateAutonomyConfig(readJson(paths.agentsConfig), paths.agentsConfig);
  const normalizedConfigText = `${JSON.stringify(config, null, 2)}\n`;
  if (rawConfigText !== normalizedConfigText) {
    fs.writeFileSync(paths.agentsConfig, normalizedConfigText, 'utf8');
    removeListEntry(skipped, 'config/agents.json');
    updated.push('config/agents.json');
  }
  validateImplementationChecks(config, paths.agentsConfig);
  const agentEntries = collectAgentScaffoldEntries(rootDir, config, {
    getAgentLogPath,
    getAutonomyPaths,
    resolveTaskQueuePath,
    templateRoot: TEMPLATE_ROOT,
  });

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
    removed.push(...pruneStaleAgentScaffold(rootDir, agentEntries, {
      getAutonomyPaths,
    }));
  }

  const payload = {
    rootDir,
    created,
    skipped,
    removed,
    updated,
  };

  printOutput(options, payload, () => {
    console.log(`Initialized autonomy v2 scaffold at ${paths.repoAutonomyDir}`);
    console.log(`Runtime state path: ${paths.runtimeAutonomyDir}`);
    console.log(`Created: ${created.length}`);
    console.log(`Skipped: ${skipped.length}`);
    if (updated.length > 0) {
      console.log(`Updated: ${updated.length}`);
    }
    if (removed.length > 0) {
      console.log(`Removed: ${removed.length}`);
    }
  });
}

function removeListEntry(list, value) {
  const index = list.indexOf(value);
  if (index >= 0) {
    list.splice(index, 1);
  }
}

function mergeGitignore(targetPath, templateContent) {
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, templateContent, 'utf8');
    return 'created';
  }

  const currentContent = fs.readFileSync(targetPath, 'utf8');
  const existingLines = new Set(
    currentContent
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
  const missingLines = templateContent
    .split(/\r?\n/)
    .filter((line) => line.trim() && !existingLines.has(line.trim()));

  if (missingLines.length === 0) {
    return 'skipped';
  }

  const separator = currentContent.endsWith('\n')
    ? currentContent.endsWith('\n\n') ? '' : '\n'
    : '\n\n';
  fs.writeFileSync(targetPath, `${currentContent}${separator}${missingLines.join('\n')}\n`, 'utf8');
  return 'updated';
}

export { run };
