# Autonomy V2 Config Support

This document describes how configuration works for the repository-local autonomy v2 setup.

## What Is Configured

The current default configuration lives in the consumer repo under:

- `prompts/autonomous/v2/config/agents.json`
- `prompts/autonomous/v2/config/sprint.json`
- `prompts/autonomous/v2/queues/<agent-id>.json`

The runtime state stays separate under:

- `.autonomy/runtime/`
- `.autonomy/worktrees/`

The entire `.autonomy/` directory is scaffolded as local runtime state and is ignored by default.
Queue files may live in the repository tree or under runtime state depending on each agent's `taskQueue`.
In the starter template, `pm-agent`, `architecture-agent`, and `reviewer` all use repo-relative queue files under `prompts/autonomous/v2/queues/`.
Only implementation queues are currently treated as git-backed authoritative queue state.

## What `init` Creates

Running `autonomy-v2 init --root <repo>` scaffolds the repo-local config and support files into the target repository.

By default it writes:

- `.gitignore`
- `.env.autonomy`
- `.env.autonomy` is scaffolded with placeholders and ignored by default.
- `prompts/autonomous/v2/config/agents.json`
- `prompts/autonomous/v2/config/sprint.json`
- `prompts/autonomous/v2/agents/*`
- `prompts/autonomous/v2/queues/*`
- `prompts/autonomous/v2/state/*`

Existing config files are preserved. Generated agent scaffolding is recreated from the active config, and `--force` prunes stale generated agent files when the roster changes.

By design, `.gitignore` is only expanded during init: missing bootstrap ignore rules are appended, while existing custom entries are preserved. Existing `.env.autonomy` files are preserved so local secrets and overrides are not replaced.

## Default Agent Set

The default config supports a small set of starter agents.

Active starter agents:

- `pm-agent`
- `architecture-agent`
- `reviewer`

Roles:

- `pm-agent` plans PRDs into tasks
- `architecture-agent` plans and guides repository initialization and structure-oriented implementation tasks
- `reviewer` reviews and merges approved PRs into `dev`

The default integration and production branches are:

- integration: `dev`
- production: `main`

## Legacy Roster Disable Flag

The repo-level control-plane config can disable the built-in `agents.json` roster scheduler while leaving custom agents enabled:

```json
{
  "legacyRosterEnabled": false,
  "spawnCustomAgents": [
    "../moving-game/agents/custom-agents.json"
  ]
}
```

When `legacyRosterEnabled` is `false`, the scheduler skips the old PRD sync, the old PM/implementation/reviewer dispatch path from `agents.json`, and the old approved-PR merge watchdog. It still loads repo status, refreshes runtime state, and polls `spawnCustomAgents`.

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

Those presets expand to the same PM, architecture, and reviewer command layout used by `darwinexzero-frontend` and `moving-game`: `agents/pm/*`, `agents/architecture/*`, and `agents/reviewer/*`, with the default custom lifecycle runtime paths under `.autonomy/runtime/custom-lifecycle` and worktrees under `.autonomy/worktrees/`.

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

The control-plane UI exposes configured custom agents, including agents that have
not run yet. It shows runtime status, target, workspace, decision metadata,
conversation metadata, tool env presence, and last error when available.

Each individual custom agent can be enabled or disabled from that UI. The
`enabled` value in the custom-agent config remains the default, but once a UI
choice is made the repo-local runtime override in
`.autonomy/runtime/state/runtime.json` is the source of truth for that agent's
runtime key. The override is applied by the bridge through a
`custom-agent:toggle` job, so remote manager pages and repo-local control pages
use the same mutation path.

## How Runner Execution Works

Implementation and review execution always uses the fixed packaged runner:

- `node <package-root>/src/autonomy-v2/runner/default-runner.js`

Runner execution behavior is not configurable through `agents.json`.

## Validation Rules

Config loading fails fast if the active config is malformed.

The current validator checks for:

- missing or duplicate agent IDs
- unsupported agent roles
- missing `systemPrompt`
- missing `gitIdentity`
- invalid `schemaVersion` values when present
- invalid `taskQueue` values when present
- `mergeActors` entries that do not map to a known agent

## How To Customize A Repo

To adapt autonomy v2 in a new repo:

1. Run `autonomy-v2 init`.
2. Edit `prompts/autonomous/v2/config/agents.json`.
3. Edit `prompts/autonomous/v2/config/sprint.json`.
4. Add or remove agent objects in `agents.json` as needed.
5. Update lane scopes, checks, and git identities for the repo’s actual code layout.
6. Re-run `autonomy-v2 init --force` to materialize any new agents and prune removed generated scaffolding.

### Agent Config Shape

The active config supports any number of agents. Common fields are:

- `id`
- `role`
- `schemaVersion` if you need to record a config format revision
- `systemPrompt`
- `gitIdentity`
- runner execution is fixed at runtime
- `include`
- `checks`
- `taskQueue` when you want to override the default queue location; otherwise the runtime uses the standard queue path for that agent id

Queue defaults:

- implementation agents default to repo-relative queue files in `prompts/autonomous/v2/queues/<agent-id>.json`
- non-implementation agents use their configured `taskQueue`
- for non-implementation agents, repo-relative queue paths stay in the repo tree
- `prompts/autonomous/v2/state/...` and `state/...` queue paths resolve into `.autonomy/runtime/state/...`
- the starter template uses repo-relative queue files for `pm-agent` and `reviewer`

The scaffold generator derives system prompts, handoff files, log files, and queue files from the config entries, so adding a new implementation lane does not require package changes.

## Operational Notes

- `status` reports the loaded config path and the loaded agent list.
- Scheduler and CLI commands read the repo-local config, not package-global state.
- Implementation queues are git-backed and authoritative; they are read from tracked refs and committed back to the integration branch.
- PM and review queues are local operational queue files resolved from `taskQueue`; in the starter template they live in repo paths, but they are not treated as tracked git-backed queue truth.
- Leases, worker status, logs, worktrees, branch locks, sync state, and runtime projections remain local runtime state.
- Implementation task completion is observed from tracked queue state plus git branch state, not from runtime implementation queue files.
