# Autonomy V2 Config Support

`control-plane.json.spawnCustomAgents` selects one custom-agent config path or
an array of paths, resolved relative to the consumer repository.

`autonomy-v2 init` creates repository settings, project context, an empty
`config/custom-agents.json`, and an empty `controls` selection. Existing config and project
context are preserved, including on `--force`. Init does not generate or prune
agent scripts, prompts or queues. Gitignore rules are appended without replacing
existing rules.

The runtime does not load legacy role definitions or sprint workflows.
An optional control preset may read old repository metadata for compatibility
(for example an integration branch). Its policy stays in that preset.
Existing custom-agent lifecycle configurations remain supported.

## Command-Driven Custom Agent Lifecycle

Custom agents can be configured as a generic command-driven lifecycle:

```txt
shouldRun -> environment -> prompt -> codex run -> finalize
```

`shouldRun` is the existing `spawn.decision.command`. Optional lifecycle commands are carried on each agent:

```json
{
  "id": "architecture-agent",
  "spawn": {
    "mode": "poll",
    "decision": {
      "command": ["node", "../moving-game/agents/architecture/should-run.js"]
    }
  },
  "environment": {
    "command": ["node", "../moving-game/agents/architecture/prepare-env.js"]
  },
  "execution": {
    "prompt": {
      "command": ["node", "../moving-game/agents/architecture/build-prompt.js"]
    }
  },
  "finalize": {
    "command": ["node", "../moving-game/agents/architecture/finalize.js"]
  }
}
```

Autonomy only runs the configured commands, passes a small JSON envelope on stdin, parses JSON from stdout, runs Codex with the prepared prompt and cwd, and records invocation status. Agent-specific semantics such as task selection, worktree preparation, checks, commits, PR creation, review queues, and merges belong in the external command files.

The command envelope includes `invocationId`, `agentId`, `repoRoot`, `phase`, `target`, `workspace.cwd`, `paths.invocationDir`, `paths.contextPath`, `decision`, `previous`, and `run`. Commands should print a JSON object. `environment` may return `cwd` or `workspacePath`; `prompt` must return `prompt` or `promptPath`; `finalize` may return any JSON object useful to the external workflow.

### Parallel custom-agent pools

An agent may opt into a bounded pool with `spawn.parallelism`. The default is
`1`; valid values are integers from `1` through `32`. Parallel pools require a
workspace below the repository root so every slot can receive an isolated
derived workspace.

The base runtime key remains unchanged for slot 1. Additional slots append
`#2`, `#3`, and so on. All slots share the logical agent's enable override and
may coexist under its singleton; a different logical agent with the same
singleton value remains blocked.

Every decision and lifecycle command receives these runtime-owned environment
variables:

- `AUTONOMY_CUSTOM_AGENT_RUNTIME_KEY`
- `AUTONOMY_CUSTOM_AGENT_BASE_RUNTIME_KEY`
- `AUTONOMY_CUSTOM_AGENT_SLOT`
- `AUTONOMY_CUSTOM_AGENT_PARALLELISM`

The stdin envelope also includes `runtimeKey`, `baseRuntimeKey`, and
`parallel: { "slot": n, "total": N }`. Lifecycle finalization runs after both
successful and failed executions so repo-defined cleanup can release the same
slot's resources.

Repos can opt into the tested command-driven lifecycle defaults with `presetAgentId` instead of copying the full agent objects. Supported preset IDs are:

- `shadow-pm-agent`
- `shadow-architecture-agent`
- `shadow-reviewer-agent`

Example:

```json
{
  "schemaVersion": 1,
  "agents": [
    { "presetAgentId": "shadow-pm-agent" },
    { "presetAgentId": "shadow-architecture-agent" },
    { "presetAgentId": "shadow-reviewer-agent" }
  ]
}
```

These presets run the packaged lifecycle scripts in `presets/pm/`, `presets/architecture/`, and `presets/reviewer/`. Consumers need only configuration; local script copies are unnecessary. Commands receive the consumer repository as `repoRoot` and retain its working directory, runtime state under `.autonomy/runtime/custom-lifecycle`, and worktrees under `.autonomy/worktrees/`. Explicit command overrides still run the consumer’s own implementation.

The packaged lifecycle scripts use the maintained Darwin implementation from commit `9764bfbc` (June 7, 2026), preserved without behavioral rewrites. They read project context and optional role prompts from the consumer repository.

The PM prompt reads `id`, `type`, and `target` directly from the consumer’s `custom-lifecycle-agents.json`; retain those metadata fields when converting existing entries to presets.

Every preset entry is still a normal custom-agent object after expansion. Repos can override selected fields locally:

```json
{
  "presetAgentId": "shadow-pm-agent",
  "target": {
    "id": "my-repo"
  },
  "spawn": {
    "intervalSeconds": 120
  },
  "finalize": {
    "command": ["node", "agents/pm/custom-finalize.mjs"]
  }
}
```

Object overrides are merged recursively, while arrays and command lists replace the preset value. `spawn.decision` is replaced as a block so mutually exclusive modes such as `{"mode":"always"}` do not retain the preset command.

Local pages enable or disable agents through the `agent:toggle` action. Runtime
overrides remain stored in `.autonomy/runtime/state/runtime.json`. No bridge or
hosted job is involved. See [Local frontend](local-frontend.md).

## New repositories

1. Run `autonomy-v2 init`.
2. Add custom agents to `prompts/autonomous/v2/config/custom-agents.json`.
3. Configure lifecycle commands, or select a `presetAgentId` and override fields.
4. Select optional controls or supply repository-owned frontend/action files.
5. Run `autonomy-v2 custom-agent:list` to inspect resolved agents, then start the server.

No role roster, workflow queues, or generated agent scripts are required by the
runtime. Lifecycle scripts own their own task formats, resources, and recovery.

## Local control definitions

`controls: { preset?, frontend?, actions?, options? }` selects optional control
preset defaults and repository file overrides. With `controls` present, legacy
`actionPresets` and frontend selection are bypassed. Without it, existing config
continues to work. See [Local frontend](local-frontend.md) for the file contract,
async host factories, JavaScript worker requirements, and options behavior.
