function logTickResult(result) {
  for (const entry of result?.customAgentStarted || []) {
    console.log(`[${new Date().toISOString()}] started ${entry.agentId} | custom-agent | pid=${entry.pid || '-'}`);
  }
}

export { logTickResult };
