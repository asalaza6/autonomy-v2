import fs from 'node:fs';
import path from 'node:path';

/** Shared repository containment and reads for page and action runtimes. */
export function createRepositoryFiles(root: string) {
  const requestedRoot = path.resolve(root);
  const rootDir = fs.realpathSync(root);
  function resolve(reference: string) {
    if (typeof reference !== 'string' || reference.includes('\0')) throw new Error('Invalid repository path.');
    const requestedRelative = path.relative(requestedRoot, path.resolve(requestedRoot, reference));
    const target = path.isAbsolute(reference) && requestedRelative !== '..' && !requestedRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(requestedRelative)
      ? path.resolve(rootDir, requestedRelative) : path.resolve(rootDir, reference);
    function inside(candidate: string) {
      const relative = path.relative(rootDir, candidate);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside the repository.');
    }
    inside(target);
    let parent = target;
    while (!fs.existsSync(parent)) {
      if (fs.lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Unresolved symlink in repository path.');
      parent = path.dirname(parent);
    }
    inside(fs.realpathSync(parent));
    return target;
  }
  function readJson<T>(file: string, fallback?: T): T {
    const target = resolve(file);
    if (!fs.existsSync(target) && arguments.length > 1) return fallback;
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  }
  function listFiles(directory: string, recursive = false) {
    const result: { path: string; type: 'file' | 'directory' | 'symlink' }[] = [];
    const walk = (base: string) => {
      for (const entry of fs.readdirSync(resolve(base), { withFileTypes: true })) {
        const file = path.join(base, entry.name);
        const type = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file';
        result.push({ path: path.relative(rootDir, file).split(path.sep).join('/'), type });
        if (type === 'directory' && recursive) walk(file);
      }
    };
    const target = resolve(directory);
    if (fs.existsSync(target)) walk(target);
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  function readFile(file: string, encoding: 'utf8' | 'base64' = 'utf8') {
    if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('Unsupported encoding.');
    return fs.readFileSync(resolve(file)).toString(encoding);
  }
  return { rootDir, resolve, readJson, readFile, listFiles };
}
