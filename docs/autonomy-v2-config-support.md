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

By design, `.gitignore` and `.env.autonomy` are always normalized during init to keep bootstrap files consistent, even if they already exist.

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
