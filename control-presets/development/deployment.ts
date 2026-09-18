import path from 'node:path';
import type { LocalAction } from '../../src/runtime/index.js';

type Context = Parameters<LocalAction['run']>[1];

/** Development policy; filesystem and process execution belong to the runtime. */
export async function deploy(context: Context) {
  const { runtime, rootDir, options = {}, log } = context;
  const configDir = String(options.configDir || 'prompts/autonomous/v2/config');
  const configPath = `${configDir}/agents.json`;
  const controlPath = `${configDir}/control-plane.json`;
  const config = await runtime.readJson<Record<string, any>>(configPath, {});
  const control = await runtime.readJson<Record<string, any>>(controlPath, {});
  const sourceBranch = String(options.integrationBranch || config.integrationBranch || 'dev').trim() || 'dev';
  const targetBranch = String(options.productionBranch || config.productionBranch || 'main').trim() || 'main';
  if (sourceBranch === targetBranch) throw new Error(`Deploy source branch and target branch must differ. Received ${sourceBranch}.`);

  const git = async (args: string[], optional = false) => {
    const result = await runtime.runProcess('git', args);
    if (result.status !== 0) {
      if (optional) return null;
      throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
    }
    return result.stdout.trim();
  };
  const ref = async (branch: string) => {
    if (await git(['rev-parse', '--verify', branch], true) !== null) return branch;
    if (await git(['rev-parse', '--verify', `origin/${branch}`], true) !== null) return `origin/${branch}`;
    throw new Error(`Base branch "${branch}" does not exist locally or on origin.`);
  };
  const status = await git(['status', '--porcelain'], true);
  if (status === null || status) throw new Error('Working tree must be clean before deploy.');
  const checkedOut = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], true);
  const sourceRef = await ref(sourceBranch);
  const targetRef = await ref(targetBranch);
  const sourceConfig = async (file: string) => {
    const raw = await git(['show', `${sourceRef}:${file.replace(/\\/g, '/')}`], true);
    try { return raw === null ? undefined : JSON.parse(raw).deployCommand; } catch { return undefined; }
  };
  const sourceControlCommand = await sourceConfig(controlPath);
  const sourceAgentCommand = await sourceConfig(configPath);
  const commandValue = sourceControlCommand !== undefined ? sourceControlCommand
    : sourceAgentCommand !== undefined ? sourceAgentCommand
      : Object.hasOwn(control, 'deployCommand') ? control.deployCommand : config.deployCommand;
  const command = normalizeCommand(commandValue, rootDir);
  if (await git(['merge-base', '--is-ancestor', targetRef, sourceRef], true) === null) {
    throw new Error(`Cannot fast-forward deploy ${sourceBranch} to ${targetBranch}: ${targetBranch} has commits that are not in ${sourceBranch}.`);
  }
  const versionAt = async (at: string) => {
    const raw = await git(['show', `${at}:package.json`], true);
    let packageVersion: string | null = null;
    try { packageVersion = String(JSON.parse(raw || '{}').version || '').trim() || null; } catch { /* Missing package versions are allowed. */ }
    const sha = await git(['rev-parse', at], true);
    const shortSha = await git(['rev-parse', '--short=12', at], true);
    const rawCount = await git(['rev-list', '--count', at], true);
    const count = rawCount ? Number(rawCount) : null;
    const buildNumber = Number.isFinite(count) ? count : null;
    return { packageVersion, sha, buildNumber, version: buildNumber && shortSha ? `${packageVersion || '0.0.0'}+build.${buildNumber}.${shortSha}` : packageVersion };
  };
  const source = await versionAt(sourceRef);
  const target = await versionAt(targetRef);
  const manifest = await runtime.readJson<{ version?: string }>('package.json', {});
  const packageVersion = String(manifest.version || '').trim() || null;
  const version = {
    currentVersion: source.version || source.packageVersion || target.version || packageVersion,
    previousVersion: target.version, sourceVersion: source.version, targetVersion: target.version,
    isNewVersion: Boolean(source.sha && target.sha && source.sha !== target.sha) || newer(source.packageVersion, target.packageVersion),
    packageVersion: source.packageVersion || target.packageVersion || packageVersion,
    previousPackageVersion: target.packageVersion, sourcePackageVersion: source.packageVersion, targetPackageVersion: target.packageVersion,
    sourceSha: source.sha, targetSha: target.sha, sourceBuildNumber: source.buildNumber, targetBuildNumber: target.buildNumber,
  };
  const sha = await git(['rev-parse', sourceRef]);
  await git(['update-ref', `refs/heads/${targetBranch}`, sha]);
  if (checkedOut === targetBranch) await git(['reset', '--hard', 'HEAD']);
  let pushed = false;
  let pushMessage = 'origin remote not configured; committed locally only';
  if (await git(['remote', 'get-url', 'origin'], true) !== null) {
    try { await git(['push', 'origin', targetBranch]); }
    catch (error) { throw new Error(`Failed to push deploy to origin/${targetBranch}: ${error.message}`); }
    pushed = true;
    pushMessage = `pushed to origin/${targetBranch}`;
  }
  let deployCommand = null;
  if (command) {
    log(`Running deploy command: ${command.display}`);
    const result = await runtime.runProcess(command.shell ? '/bin/sh' : command.command,
      command.shell ? ['-c', [command.command, ...command.args.map(shellQuote)].join(' ')] : command.args, {
        cwd: command.cwd, timeoutMs: 600000,
        env: { AUTONOMY_DEPLOY_SOURCE_BRANCH: sourceBranch, AUTONOMY_DEPLOY_TARGET_BRANCH: targetBranch, AUTONOMY_DEPLOY_SHA: sha, ...command.env },
      });
    const rawOutput = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    const output = rawOutput.length > 4000 ? `${rawOutput.slice(0, 4000)}\n[deploy command output truncated]` : rawOutput;
    if (output) log(output);
    if (result.status !== 0) throw new Error(`Deploy command "${command.display}" failed with exit code ${result.status}: ${output || result.signal || 'no output'}`);
    deployCommand = { command: command.display, cwd: path.relative(rootDir, command.cwd) || '.', exitCode: result.status, output: output || null };
  }
  return { ok: true, sha, sourceBranch, targetBranch, pushed, pushMessage, version, deployCommand };
}

function normalizeCommand(value: any, rootDir: string) {
  if (value === undefined || value === null) return null;
  if (!['string', 'object'].includes(typeof value)) throw new Error('deployCommand must be a string, an array, or an object.');
  const data = typeof value === 'string' ? { command: value, shell: true }
    : Array.isArray(value) ? { command: value[0], args: value.slice(1) } : value;
  const command = String(data.command || '').trim();
  if (!command) return null;
  const args = Array.isArray(data.args) ? data.args.map(String) : [];
  const env = Object.fromEntries(Object.entries(data.env && typeof data.env === 'object' && !Array.isArray(data.env) ? data.env : {})
    .filter(([key, entry]) => key.trim() && entry !== undefined && entry !== null).map(([key, entry]) => [key.trim(), String(entry)]));
  return { command, args, shell: data.shell === true, cwd: path.resolve(rootDir, String(data.cwd || '.')), env,
    display: [command, ...args].map((part) => /\s/.test(part) ? JSON.stringify(part) : part).join(' ') };
}
function shellQuote(value: string) { return `'${value.replace(/'/g, `'\\''`)}'`; }
function newer(left: string | null, right: string | null) {
  const parse = (value: string) => /^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/.exec(value)?.[1].split('.').map(Number);
  if (!left || !right) return false;
  const a = parse(left), b = parse(right);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}
