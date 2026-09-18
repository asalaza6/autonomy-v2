# Custom-agent orchestration

The server runs `src/server/orchestrator/scheduler.ts` on each tick.

1. Acquire the repository state lock and load runtime state.
2. Refresh custom-agent process state.
3. Load the configs selected by `control-plane.json.spawnCustomAgents`.
4. Check enable overrides, poll windows, singleton ownership and pool slots.
5. Run configured decisions and reserve accepted invocations under the lock.
6. Persist runtime state and release the lock.
7. Spawn each accepted custom worker and persist its PID under the lock.

A spawn failure marks that invocation and the remaining unspawned invocations
as failed. Spawn callbacks still receive runtime keys, slot and conversation
metadata. The default admission limit is one decision per logical pool per tick.

`src/server/custom-agents/custom-agent-worker.ts` executes environment, prompt,
Codex and finalize phases. Commands exchange JSON through stdin/stdout. Finalize
also runs after execution failures. The consumer commands own workflow semantics.

`src/server/orchestrator/custom-agents.ts` retains preset expansion, multi-file
configs, enable overrides, staggered polling, singleton and parallel-pool
coordination, conversation scopes and runtime status.

A tick returns `rootDir`, `customAgentStarted`, and `runtime`. Workflow state
transitions belong to configured lifecycle commands. Agent preset defaults live
in `presets/definitions.json`; the scheduler expands them generically.

See [configuration](autonomy-v2-config-support.md) for the lifecycle contract.
