import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const childFlag = '--restart-child';
const terminalChildFlag = '--restart-terminal-child';
const keepOldTerminalFlag = '--keep-old-terminal';
const detachedFlag = '--detached';
const foregroundFlag = '--foreground';
const forceFlag = '--force';

let currentAncestryPidsCache = null;

function run(rootDir: string, options = {}, command = 'server:restart') {
  const controller = createServerController(rootDir, options);
  return controller.run(command);
}

function createServerController(rootDir: string, options: Record<string, unknown> = {}) {
  const autonomyDir = path.join(rootDir, '.autonomy');
  const ownerPath = path.join(autonomyDir, 'server-lock', 'owner.json');
  const logDir = path.join(autonomyDir, 'runtime');
  const logPath = path.join(logDir, 'restart-server.log');
  const terminalStatePath = path.join(logDir, 'restart-terminals.json');
  const stopTimeoutMs = Number(process.env.AUTONOMY_RESTART_STOP_TIMEOUT_MS || 5000);
  const readyTimeoutMs = Number(process.env.AUTONOMY_RESTART_READY_TIMEOUT_MS || 10000);

  function now() {
    return new Date().toISOString();
  }

  function ensureRuntimeDir() {
    fs.mkdirSync(logDir, { recursive: true });
  }

  function appendLog(message) {
    ensureRuntimeDir();
    fs.appendFileSync(logPath, `[${now()}] ${message}\n`, 'utf8');
  }

  function readRememberedTtys() {
    const remembered: string[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(terminalStatePath, 'utf8'));
      if (Array.isArray(parsed.ttys)) {
        remembered.push(...parsed.ttys);
      }
    } catch (_) {
      // Fall through to recent log recovery.
    }
    remembered.push(...readRecentlyLoggedTtys());
    return [...new Set(remembered.map(normalizeTty).filter(Boolean))];
  }

  function readRecentlyLoggedTtys() {
    try {
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-80);
      return lines.flatMap((line) => {
        const match = line.match(/\bttys=([^\s]+)/);
        if (!match || match[1] === 'none') {
          return [];
        }
        return match[1].split(',').map((entry) => entry.trim()).filter(Boolean);
      });
    } catch (_) {
      return [];
    }
  }

  function rememberTtys(ttys) {
    ensureRuntimeDir();
    const normalizedTtys: string[] = Array.from(new Set((ttys || []).map(normalizeTty).filter(Boolean) as string[]));
    fs.writeFileSync(terminalStatePath, `${JSON.stringify({
      updatedAt: now(),
      ttys: normalizedTtys,
    }, null, 2)}\n`, 'utf8');
  }

  function readOwner() {
    try {
      const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      const pid = Number(parsed.pid);
      return Number.isInteger(pid) && pid > 0 ? { ...parsed, pid } : null;
    } catch (_) {
      return null;
    }
  }

  function isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  function readCommand(pid) {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    });
    return result.status === 0 ? result.stdout.trim() : '';
  }

  function readTty(pid) {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'tty='], {
      encoding: 'utf8',
    });
    return result.status === 0 ? normalizeTty(result.stdout.trim()) : '';
  }

  function readProcessCwd(pid) {
    const result = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      return '';
    }
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('n'));
    return line ? path.resolve(line.slice(1).trim()) : '';
  }

  function readCurrentTty() {
    const result = spawnSync('tty', [], {
      encoding: 'utf8',
    });
    return result.status === 0 ? normalizeTty(result.stdout.trim()) : '';
  }

  function normalizeTty(value) {
    const tty = String(value || '').trim();
    if (!tty || tty === '?' || tty === '??') {
      return '';
    }
    return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  }

  function readProcessTable() {
    const result = spawnSync('ps', ['-axo', 'pid=,ppid=,tty=,command='], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      return [];
    }
    return result.stdout
      .split('\n')
      .map(parseProcessLine)
      .filter(Boolean);
  }

  function parseProcessLine(line) {
    const match = String(line || '').match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
    if (!match) {
      return null;
    }
    return {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      tty: normalizeTty(match[3]),
      command: String(match[4] || '').trim(),
    };
  }

  function collectDescendants(rootPid) {
    const table = readProcessTable();
    const childrenByParent = new Map();
    for (const entry of table) {
      const children = childrenByParent.get(entry.ppid) || [];
      children.push(entry.pid);
      childrenByParent.set(entry.ppid, children);
    }

    const descendants = [];
    const stack = [...(childrenByParent.get(rootPid) || [])];
    while (stack.length > 0) {
      const pid = stack.pop();
      descendants.push(pid);
      stack.push(...(childrenByParent.get(pid) || []));
    }
    return descendants;
  }

  function buildProcessTree(rootPid) {
    const table = readProcessTable();
    const byPid = new Map(table.map((entry) => [entry.pid, entry]));
    const childrenByParent = new Map();
    for (const entry of table) {
      const children = childrenByParent.get(entry.ppid) || [];
      children.push(entry);
      childrenByParent.set(entry.ppid, children);
    }

    const rows = [];
    function visit(pid, depth) {
      const entry = byPid.get(pid) || {
        pid,
        ppid: 0,
        tty: '',
        command: readCommand(pid),
      };
      rows.push({ ...entry, depth, alive: isAlive(pid) });
      const children = (childrenByParent.get(pid) || []).sort((left, right) => left.pid - right.pid);
      for (const child of children) {
        visit(child.pid, depth + 1);
      }
    }
    visit(rootPid, 0);
    return rows;
  }

  function isServerProcess(entry) {
    const entryCommand = String(entry?.command || '');
    if (isSelfOrAncestorProcess(entry)) {
      return false;
    }
    if (entryCommand.includes('restart-autonomy-server.mjs')) {
      return false;
    }
    if (!isProcessInRoot(entry)) {
      return false;
    }
    return entryCommand.includes('/.bin/autonomy-v2-server')
      || /\/autonomy-v2-server\.js(?:\s|$)/.test(entryCommand)
      || /\bnpm exec autonomy-v2-server\b/.test(entryCommand)
      || /\bnpx(?:\s+--no-install)?\s+autonomy-v2-server\b/.test(entryCommand);
  }

  function isProcessInRoot(entry) {
    const entryCommand = String(entry?.command || '');
    if (entryCommand.includes(rootDir)) {
      return true;
    }
    const cwd = readProcessCwd(entry?.pid);
    return cwd === rootDir || cwd.startsWith(`${rootDir}${path.sep}`);
  }

  function collectCurrentAncestryPids() {
    if (currentAncestryPidsCache) {
      return currentAncestryPidsCache;
    }
    const table = readProcessTable();
    const parentByPid = new Map(table.map((entry) => [entry.pid, entry.ppid]));
    const pids = new Set([process.pid]);
    let pid = process.pid;
    while (parentByPid.has(pid)) {
      const parentPid = parentByPid.get(pid);
      if (!parentPid || pids.has(parentPid)) {
        break;
      }
      pids.add(parentPid);
      pid = parentPid;
    }
    currentAncestryPidsCache = pids;
    return currentAncestryPidsCache;
  }

  function isSelfOrAncestorProcess(entry) {
    return collectCurrentAncestryPids().has(Number(entry?.pid || 0));
  }

  function listServerProcesses() {
    return readProcessTable()
      .filter((entry) => entry.pid !== process.pid)
      .filter(isServerProcess)
      .sort((left, right) => left.pid - right.pid);
  }

  function collectServerProcessTreeRows() {
    const owner = readOwner();
    const rootPids = new Set();
    if (owner?.pid && isAlive(owner.pid)) {
      rootPids.add(owner.pid);
    }
    for (const entry of listServerProcesses()) {
      rootPids.add(entry.pid);
    }

    const rowsByPid = new Map();
    for (const pid of rootPids) {
      for (const row of buildProcessTree(pid)) {
        if (row.pid !== process.pid) {
          rowsByPid.set(row.pid, row);
        }
      }
    }
    return [...rowsByPid.values()].sort((left, right) => right.depth - left.depth || right.pid - left.pid);
  }

  function isRelatedTerminalProcess(entry) {
    const entryCommand = String(entry?.command || '');
    if (isSelfOrAncestorProcess(entry) || !normalizeTty(entry.tty)) {
      return false;
    }
    if (!entryCommand.includes(rootDir)) {
      return false;
    }
    if (entryCommand.includes('/.autonomy/runtime/agents/') && entryCommand.includes('/stream.log')) {
      return true;
    }
    if (entryCommand.includes('autonomy-v2-server')) {
      return true;
    }
    return false;
  }

  function collectRelatedTerminalRows() {
    return readProcessTable()
      .filter(isRelatedTerminalProcess)
      .map((entry) => ({ ...entry, depth: 0, alive: isAlive(entry.pid) }));
  }

  function collectKillRows() {
    const rowsByPid = new Map();
    for (const row of collectServerProcessTreeRows()) {
      rowsByPid.set(row.pid, row);
    }
    for (const row of collectRelatedTerminalRows()) {
      rowsByPid.set(row.pid, row);
    }
    return [...rowsByPid.values()].sort((left, right) => right.depth - left.depth || right.pid - left.pid);
  }

  function formatProcessTree(rows) {
    if (rows.length === 0) {
      return [];
    }
    return rows.map((row) => {
      const prefix = row.depth === 0 ? '' : `${'  '.repeat(row.depth - 1)}- `;
      const tty = row.tty || '-';
      const state = row.alive ? 'alive' : 'not-running';
      return `${prefix}${row.pid} ppid=${row.ppid || '-'} tty=${tty} ${state} ${row.command || ''}`.trimEnd();
    });
  }

  async function delay(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForExit(pids, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      if (pids.every((pid) => !isAlive(pid))) {
        return true;
      }
      await delay(100);
    }
    return pids.every((pid) => !isAlive(pid));
  }

  function signalPid(pid, signal) {
    if (pid === process.pid || !isAlive(pid)) {
      return;
    }
    try {
      process.kill(pid, signal);
    } catch (_) {
      // The process may already be gone.
    }
  }

  function uniqueNormalizedTtys(rows) {
    return [...new Set(rows.map((row) => normalizeTty(row.tty)).filter(Boolean))];
  }

  async function stopProcessTree(pid) {
    const descendants = collectDescendants(pid);
    const pids = [...descendants.reverse(), pid].filter((entry) => entry !== process.pid);
    appendLog(`stopping pid=${pid} descendants=${descendants.length}`);
    for (const entry of pids) {
      signalPid(entry, 'SIGTERM');
    }
    if (await waitForExit(pids, stopTimeoutMs)) {
      appendLog(`stopped pid=${pid}`);
      return;
    }
    appendLog(`force-stopping pid=${pid}`);
    for (const entry of pids) {
      signalPid(entry, 'SIGKILL');
    }
    await waitForExit(pids, 1000);
  }

  function shouldCloseOldTerminal() {
    if (getBooleanOption(options, 'keep-old-terminal') || process.argv.includes(keepOldTerminalFlag)) {
      return false;
    }
    if (process.env.AUTONOMY_RESTART_CLOSE_OLD_TERMINAL === '0') {
      return false;
    }
    return process.platform === 'darwin';
  }

  function closeOldTerminalForTty(oldTty) {
    const tty = normalizeTty(oldTty);
    if (!shouldCloseOldTerminal() || !tty) {
      return;
    }

    const currentTty = readCurrentTty();
    if (currentTty && currentTty === tty) {
      appendLog(`skipping old terminal close for current tty=${tty}`);
      return;
    }

    closeTerminalsForTtys([tty]);
  }

  function closeTerminalsForTtys(ttys) {
    const normalizedTtys: string[] = Array.from(new Set((ttys || []).map(normalizeTty).filter(Boolean) as string[]));
    if (!shouldCloseOldTerminal() || normalizedTtys.length === 0) {
      return;
    }

    const targets = toAppleScriptList([
      ...normalizedTtys,
      ...normalizedTtys.map((tty) => tty.replace(/^\/dev\//, '')),
    ]);
    const script = `
set targetTtys to ${targets}
set closedCount to 0
try
  tell application "Terminal"
    repeat with windowIndex from (count of windows) to 1 by -1
      set terminalWindow to window windowIndex
      set shouldCloseWindow to false
      repeat with terminalTab in tabs of terminalWindow
        set tabTty to (tty of terminalTab as text)
        if targetTtys contains tabTty then
          set shouldCloseWindow to true
        end if
      end repeat
      if shouldCloseWindow then
        close terminalWindow
        set closedCount to closedCount + 1
      end if
    end repeat
  end tell
end try
return closedCount
`;
    const result = spawnSync('osascript', ['-e', script], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      appendLog(`closed terminal count=${result.stdout.trim() || '0'} ttys=${normalizedTtys.join(',')}`);
      return;
    }
    appendLog(`terminal close failed ttys=${normalizedTtys.join(',')}: ${result.stderr.trim() || 'unknown AppleScript failure'}`);
  }

  function toAppleScriptList(values) {
    const uniqueValues = [...new Set(values.map((value) => String(value || '')).filter(Boolean))] as string[];
    return `{${uniqueValues.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(', ')}}`;
  }

  function serverShellCommand() {
    const { launchCommand, args } = resolveLaunchCommand();
    return `cd ${shellQuote(rootDir)} && ${[launchCommand, ...args].map(shellQuote).join(' ')}`;
  }

  function shellQuote(value) {
    return `'${String(value).replaceAll("'", "'\\''")}'`;
  }

  function launchServerInNewTerminal() {
    if (process.platform !== 'darwin') {
      appendLog('new terminal launch skipped: platform is not darwin');
      launchServer();
      return;
    }

    const shellCommand = serverShellCommand();
    const script = `
set serverCommand to ${JSON.stringify(shellCommand)}
tell application "Terminal"
  activate
  do script serverCommand
end tell
return "Terminal"
`;
    const result = spawnSync('osascript', ['-e', script], {
      encoding: 'utf8',
    });
    const output = result.stdout.trim();
    if (result.status === 0 && output && !output.startsWith('ERROR:')) {
      appendLog(`launched new terminal app=${output} command=${shellCommand}`);
      return;
    }
    const detail = result.stderr.trim() || output || 'unknown AppleScript failure';
    appendLog(`new terminal launch failed: ${detail}; falling back to detached launch`);
    launchServer();
  }

  function resolveLaunchCommand() {
    const launchCommand = process.env.AUTONOMY_RESTART_COMMAND || process.execPath;
    const args = process.env.AUTONOMY_RESTART_ARGS
      ? JSON.parse(process.env.AUTONOMY_RESTART_ARGS)
      : [fileURLToPath(new URL('../../bin/autonomy-v2-server.js', import.meta.url)), 'serve', '--root', rootDir];
    if ((getBooleanOption(options, 'no-trace-window') || options['trace-window'] === false)
      && !args.includes('--no-trace-window')) args.push('--no-trace-window');
    return { launchCommand, args };
  }

  function launchServer() {
    ensureRuntimeDir();
    const out = fs.openSync(path.join(logDir, 'manual-server.log'), 'a');
    const err = fs.openSync(path.join(logDir, 'manual-server.log'), 'a');
    const { launchCommand, args } = resolveLaunchCommand();
    appendLog(`launching command=${launchCommand} args=${JSON.stringify(args)}`);
    const child = spawn(launchCommand, args, {
      cwd: rootDir,
      detached: true,
      env: process.env,
      stdio: ['ignore', out, err],
    });
    child.unref();
    appendLog(`launched helper child pid=${child.pid || 'unknown'}`);
    return child.pid || null;
  }

  function launchServerInCurrentTerminal() {
    const { launchCommand, args } = resolveLaunchCommand();
    appendLog(`launching foreground command=${launchCommand} args=${JSON.stringify(args)}`);
    console.log(`Launching ${launchCommand} ${args.join(' ')} in this terminal...`);
    const child = spawn(launchCommand, args, {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      appendLog(`foreground server exited code=${code ?? ''} signal=${signal ?? ''}`);
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
    child.on('error', (error) => {
      appendLog(`foreground launch failed: ${error.message}`);
      console.error(error.message);
      process.exit(1);
    });
  }

  async function waitForNewOwner(previousPid) {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= readyTimeoutMs) {
      const owner = readOwner();
      if (owner && owner.pid !== previousPid && isAlive(owner.pid)) {
        return owner;
      }
      await delay(200);
    }
    return null;
  }

  async function runChild(previousPid) {
    appendLog(`restart child started previousPid=${previousPid || 'none'}`);
    const previousTty = previousPid ? readTty(previousPid) : '';
    if (previousPid && isAlive(previousPid)) {
      await stopProcessTree(previousPid);
    } else if (previousPid) {
      appendLog(`previous pid ${previousPid} is not running`);
    }
    closeOldTerminalForTty(previousTty);

    launchServer();
    const owner = await waitForNewOwner(previousPid);
    if (owner) {
      appendLog(`restart ready newPid=${owner.pid}`);
      return;
    }
    appendLog('restart launched but readiness was not confirmed before timeout');
  }

  async function runTerminalChild(previousPid, requesterTty) {
    appendLog(`terminal restart child started previousPid=${previousPid || 'none'} requesterTty=${requesterTty || 'none'}`);
    const previousTty = previousPid ? readTty(previousPid) : '';
    if (previousPid && isAlive(previousPid)) {
      await stopProcessTree(previousPid);
    } else if (previousPid) {
      appendLog(`previous pid ${previousPid} is not running`);
    }

    launchServerInNewTerminal();
    const owner = await waitForNewOwner(previousPid);
    if (owner) {
      appendLog(`terminal restart ready newPid=${owner.pid}`);
    } else {
      appendLog('terminal restart launched but readiness was not confirmed before timeout');
    }

    closeOldTerminalForTty(previousTty);
    if (requesterTty && requesterTty !== previousTty) {
      closeOldTerminalForTty(requesterTty);
    }
  }

  async function killServerProcesses() {
    ensureRuntimeDir();
    const rows = collectKillRows();
    const rememberedTtys = readRememberedTtys();
    if (rows.length === 0) {
      if (rememberedTtys.length > 0) {
        appendLog(`kill requested: no processes found; closing remembered ttys=${rememberedTtys.join(',')}`);
        closeTerminalsForTtys(rememberedTtys);
        rememberTtys([]);
        console.log(`Closed remembered Autonomy terminal tabs: ${rememberedTtys.join(', ')}`);
        return true;
      }
      appendLog('kill requested: no server processes found');
      console.log('No autonomy-v2-server processes or trace terminals found.');
      return true;
    }

    const pids = rows.map((row) => row.pid);
    const ttys = [...new Set([...uniqueNormalizedTtys(rows), ...rememberedTtys])];
    rememberTtys(ttys);
    appendLog(`kill requested pids=${pids.join(',')} ttys=${ttys.join(',') || 'none'}`);
    console.log(`Killing autonomy-v2-server process tree: ${pids.join(', ')}`);

    for (const pid of pids) {
      signalPid(pid, 'SIGTERM');
    }
    let exited = await waitForExit(pids, stopTimeoutMs);
    if (!exited) {
      appendLog(`kill force pids=${pids.filter(isAlive).join(',') || 'none'}`);
      for (const pid of pids) {
        signalPid(pid, 'SIGKILL');
      }
      exited = await waitForExit(pids, 1000);
    }
    closeTerminalsForTtys(ttys);

    const remaining = collectKillRows().filter((row) => isAlive(row.pid));
    if (remaining.length > 0) {
      appendLog(`kill incomplete remaining=${remaining.map((row) => row.pid).join(',')}`);
      console.error(`Still running: ${remaining.map((row) => row.pid).join(', ')}`);
      return false;
    }
    appendLog('kill complete');
    rememberTtys([]);
    console.log('All autonomy-v2-server processes killed.');
    return true;
  }

  function assertNoServerProcesses() {
    const remaining = collectServerProcessTreeRows().filter((row) => isAlive(row.pid));
    if (remaining.length === 0) {
      return true;
    }
    console.error('Cannot start: autonomy-v2-server processes are still running:');
    for (const line of formatProcessTree(remaining.sort((left, right) => left.pid - right.pid))) {
      console.error(line);
    }
    return false;
  }

  async function startServerProcess() {
    ensureRuntimeDir();
    if (!assertNoServerProcesses()) {
      process.exitCode = 1;
      return false;
    }
    appendLog('start requested');
    if (getBooleanOption(options, 'detached')) launchServer();
    else if (getBooleanOption(options, 'foreground')) return launchServerInCurrentTerminal();
    else launchServerInNewTerminal();
    const owner = await waitForNewOwner(0);
    if (owner) {
      appendLog(`start ready pid=${owner.pid}`);
      console.log(`Started autonomy-v2-server pid ${owner.pid}.`);
      return true;
    }
    appendLog('start launched but readiness was not confirmed before timeout');
    console.log('Start requested; readiness was not confirmed before timeout.');
    return false;
  }

  async function restartServerProcess() {
    const killed = await killServerProcesses();
    if (!killed) {
      process.exitCode = 1;
      return;
    }
    const started = await startServerProcess();
    if (!started) {
      process.exitCode = 1;
    }
  }

  function printStatus() {
    const owner = readOwner();
    if (!owner) {
      console.log('autonomy-v2-server owner: missing');
      const relatedRows = collectRelatedTerminalRows();
      if (relatedRows.length > 0) {
        console.log('related terminals:');
        for (const line of formatProcessTree(relatedRows)) {
          console.log(line);
        }
      }
      return;
    }
    const ownerCommand = readCommand(owner.pid);
    console.log(`autonomy-v2-server owner: pid=${owner.pid} alive=${isAlive(owner.pid)}`);
    if (ownerCommand) {
      console.log(ownerCommand);
    }
    const tree = buildProcessTree(owner.pid);
    if (tree.length > 1) {
      console.log('children:');
      for (const line of formatProcessTree(tree.slice(1))) {
        console.log(line);
      }
    } else {
      console.log('children: none');
    }
    const treePids = new Set(tree.map((row) => row.pid));
    const relatedRows = collectRelatedTerminalRows().filter((row) => !treePids.has(row.pid));
    if (relatedRows.length > 0) {
      console.log('related terminals:');
      for (const line of formatProcessTree(relatedRows)) {
        console.log(line);
      }
    }
  }

  function startRestart() {
    const owner = readOwner();
    const previousPid = owner?.pid || 0;
    if (previousPid && !readCommand(previousPid).includes('autonomy-v2-server')) {
      console.error(`PID ${previousPid} does not look like autonomy-v2-server.`);
      process.exit(1);
    }
    if (!previousPid && !getBooleanOption(options, 'force') && !process.argv.includes(forceFlag)) {
      appendLog(`no server owner found at ${ownerPath}; launching a new server`);
    }

    ensureRuntimeDir();
    if (getBooleanOption(options, 'foreground') || process.argv.includes(foregroundFlag)) {
      return (async () => {
        appendLog(`foreground restart requested previousPid=${previousPid || 'none'}`);
        const previousTty = previousPid ? readTty(previousPid) : '';
        if (previousPid && isAlive(previousPid)) {
          await stopProcessTree(previousPid);
        } else if (previousPid) {
          appendLog(`previous pid ${previousPid} is not running`);
        }
        closeOldTerminalForTty(previousTty);
        launchServerInCurrentTerminal();
      })().catch((error) => {
        appendLog(`foreground restart failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      });
    }

    const childArgs = getBooleanOption(options, 'detached') || process.argv.includes(detachedFlag)
      ? [new URL(import.meta.url).pathname, childFlag, String(previousPid), '--root', rootDir]
      : [new URL(import.meta.url).pathname, terminalChildFlag, String(previousPid), readCurrentTty(), '--root', rootDir];
    const child = spawn(process.execPath, childArgs, {
      cwd: rootDir,
      detached: true,
      env: process.env,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`Restart requested for autonomy-v2-server${previousPid ? ` pid ${previousPid}` : ''}.`);
    if (!getBooleanOption(options, 'detached') && !process.argv.includes(detachedFlag)) {
      console.log('A new Terminal window should open with the restarted server.');
    }
    console.log(`Log: ${logPath}`);
  }

  return {
    async run(selectedCommand: string) {
      if (process.argv.includes(childFlag)) {
        const previousPid = Number(process.argv[process.argv.indexOf(childFlag) + 1] || 0);
        await runChild(previousPid);
        return;
      }
      if (process.argv.includes(terminalChildFlag)) {
        const previousPid = Number(process.argv[process.argv.indexOf(terminalChildFlag) + 1] || 0);
        const requesterTty = process.argv[process.argv.indexOf(terminalChildFlag) + 2] || '';
        await runTerminalChild(previousPid, requesterTty);
        return;
      }
      if (selectedCommand === 'server:status') {
        printStatus();
        return;
      }
      if (selectedCommand === 'server:kill') {
        const ok = await killServerProcesses();
        process.exitCode = ok ? 0 : 1;
        return;
      }
      if (selectedCommand === 'server:start') {
        if (await startServerProcess() === false) process.exitCode = 1;
        return;
      }
      if (getBooleanOption(options, 'detached') || getBooleanOption(options, 'foreground')) {
        await startRestart();
        return;
      }
      await restartServerProcess();
    },
  };
}

function getBooleanOption(options: Record<string, unknown>, key: string) {
  const value = options[key];
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function parseDirectModuleRoot(argv: string[]) {
  const rootIndex = argv.indexOf('--root');
  const rootValue = rootIndex >= 0 ? String(argv[rootIndex + 1] || '').trim() : '';
  return rootValue ? path.resolve(rootValue) : process.cwd();
}

export { createServerController, run };

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const rootDir = parseDirectModuleRoot(process.argv.slice(2));
  createServerController(rootDir, {}).run('server:restart').catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
