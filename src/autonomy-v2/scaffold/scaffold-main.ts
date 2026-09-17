import fs from 'fs';
import path from 'path';

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

export { getTemplateContent, resolveTemplateTargetPath };
