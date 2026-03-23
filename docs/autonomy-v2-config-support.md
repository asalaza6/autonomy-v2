# Autonomy V2 Config Support

This document describes how configuration works for the repository-local autonomy v2 setup.

## What Is Configured

The current default configuration lives in the consumer repo under:

- `prompts/autonomous/v2/config/agents.json`
- `prompts/autonomous/v2/config/sprint.json`
- `prompts/autonomous/v2/queues/<implementation-agent>.json`

The runtime state stays separate under:

- `.autonomy/runtime/`
- `.autonomy/worktrees/`

The entire `.autonomy/` directory is scaffolded as local runtime state and is ignored by default.
Tracked implementation queue files are not part of `.autonomy/`; they live in the repository tree and are committed to git.

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
- `scripts/autonomy-v2-default-runner.js`

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

## How Runner Commands Work

The repo-local config keeps the current runner command shape:

- `node scripts/autonomy-v2-default-runner.js`

That wrapper resolves the packaged default runner when the package is installed, and falls back to the package source copy when needed.

## Validation Rules

Config loading fails fast if the active config is malformed.

The current validator checks for:

- missing or duplicate agent IDs
- unsupported agent roles
- missing `systemPrompt`
- missing `gitIdentity`
- missing `runnerCommand` for non-PM agents
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
7. Keep the runtime wrapper script if the repo wants the same runner command shape.

### Agent Config Shape

The active config supports any number of agents. Common fields are:

- `id`
- `role`
- `schemaVersion` if you need to record a config format revision
- `systemPrompt`
- `gitIdentity`
- `runnerCommand` for non-PM agents
- `include`
- `checks`
- `taskQueue` when you want to override the default queue location; otherwise the runtime uses the standard queue path for that agent id

Queue defaults:

- implementation agents default to tracked queue files in `prompts/autonomous/v2/queues/<agent-id>.json`
- review and other runtime-managed queues remain under `.autonomy/runtime/state/queues/`

The scaffold generator derives system prompts, handoff files, log files, and queue files from the config entries, so adding a new implementation lane does not require package changes.

## Operational Notes

- `status` reports the loaded config path and the loaded agent list.
- Scheduler and CLI commands read the repo-local config, not package-global state.
- Implementation queues are tracked in git; review queues, leases, logs, worker status, and worktrees remain local runtime cache.
- Implementation task completion is observed from tracked queue state plus git branch state, not from runtime implementation queue files.
