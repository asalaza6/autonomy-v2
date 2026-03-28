import fs from 'fs';
import path from 'path';
import { validateAutonomyConfig } from '../../config/config-main.js';
import { collectAgentScaffoldEntries, getTemplateContent, pruneStaleAgentScaffold, resolveTemplateTargetPath, validateImplementationChecks, } from '../scaffold/scaffold-main.js';
import { BASE_TEMPLATE_FILES, GENERATED_TEMPLATE_FILES, TEMPLATE_ROOT, ensureDir, getAgentLogPath, getAutonomyPaths, printOutput, readJson, } from './shared-core.js';
import { resolveTaskQueuePath } from './shared-queues.js';

function run(rootDir, options) {
  const bootstrapRootFiles = new Set(['.env.autonomy', '.gitignore']);
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
    const preserveIfExists = relativeFile === 'config/agents.json' || relativeFile === 'config/sprint.json';
    const isBootstrapRootFile = bootstrapRootFiles.has(relativeFile);
    const shouldSkipExisting = fs.existsSync(targetPath)
      && (preserveIfExists || (!isBootstrapRootFile && options.force !== true));
    if (shouldSkipExisting) {
      skipped.push(relativeFile);
      continue;
    }

    const templateContent = getTemplateContent(relativeFile, {
      generatedTemplateFiles: GENERATED_TEMPLATE_FILES,
      templateRoot: TEMPLATE_ROOT,
    });
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

export { run };
