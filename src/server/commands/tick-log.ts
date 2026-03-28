function logTickResult(result) {
  return logTickResultWithWriter(result, console.log, () => new Date().toISOString());
}

function logTickResultWithWriter(result, writeLine = console.log, timestampFactory = () => new Date().toISOString()) {
  if (!result) {
    return false;
  }
  let emitted = false;
  if (result.sync && (
    result.sync.fetchMessage ||
    result.sync.imported.length > 0 ||
    result.sync.updated.length > 0 ||
    result.sync.invalid.length > 0
  )) {
    const line = [
      `[${new Date().toISOString()}] synced ${result.sync.integrationBranch}`,
      `ref=${result.sync.fetchedRef || '-'}`,
      `imported=${result.sync.imported.length}`,
      `updated=${result.sync.updated.length}`,
      `invalid=${result.sync.invalid.length}`,
    ];
    if (result.sync.fetchMessage) {
      line.push(`fetch=${result.sync.fetchMessage}`);
    }
    writeLine(line.join(' | '));
    emitted = true;
  }
  if (Array.isArray(result.started) && result.started.length > 0) {
    result.started.forEach((entry) => {
      const pidText = entry.pid ? ` pid=${entry.pid}` : '';
      writeLine(`[${timestampFactory()}] started ${entry.agentId} | ${entry.mode} | ${entry.reason}${pidText}`);
    });
    emitted = true;
  }

  return emitted;
}

export { logTickResult,  };
