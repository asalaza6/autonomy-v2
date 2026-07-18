# Autonomy v2 Package
"version": "1.4.55" restarted to

This is the repository-local package form of `autonomy-v2`.

The package owns the command implementations and prompt templates, while the
runtime/state and execution still occur in a consumer workspace.
Consumer repos that want a hosted browser/API control plane own that
deployment, configuration, and runtime wiring themselves.

## Package layout

- `bin/` CLI entrypoints
- `src/` runtime modules
- `templates/` bootstrap templates copied into the workspace by `init`
- `docs/` support documentation for config and packaging behavior
- implementation and review always use `src/autonomy-v2/runner/default-runner.js` with fixed execution behavior.

## Quick mental model

Autonomy v2 is a repo-local orchestration package. The package provides the
CLI, server, runner, control-plane, and scaffold templates, but actual work is
executed inside each consumer repository.

The durable workflow truth lives in git on the integration branch:

- repo config and prompt scaffolding under `prompts/autonomous/v2/config/`
- PRD specs under `prompts/autonomous/v2/specs/prds/`
- PRD lifecycle state under `prompts/autonomous/v2/specs/prd-state/`
- implementation and reviewer queues under `prompts/autonomous/v2/queues/`

Local process state lives under `.autonomy/` and is treated as cache,
coordination, logs, worktrees, and status projection. Scheduler recovery should
prefer tracked git state and GitHub state over stale runtime files.

The steady-state loop is:

1. add a PRD
2. sync from the integration branch
3. let the PM agent plan lane tasks
4. let implementation agents run Codex in isolated worktrees
5. let the reviewer validate, request follow-up work, or merge
6. optionally deploy the integration branch to production

The hosted manager is a browser/API queue and status surface. It does not touch
repo files directly. A local bridge registers repo status with the manager,
claims queued jobs, and executes `prd:add` or `deploy` inside each mapped local
repo.

## Docs

- [How Autonomy V2 Works](./docs/how-it-works.md)
- [Autonomy V2 Config Support](./docs/autonomy-v2-config-support.md)
- [Orchestrator Flow](./docs/orchestrator-flow.md)
- [Control Plane Bridge](./docs/control-plane-bridge.md)
- [Health Score](./docs/health-score.md)
- [Orchestrator Failure Cases](./docs/orchestrator-failure-cases.md)
- [Structureness Health Flow](./docs/structureness-health-flow.md)
- [Git-backed Implementation Queues](./docs/git-backed-implementation-queues.md)
- [Current Issues / Deferred Fixes](./issues.md)
- [Feature Design Template](./features.md)

## Custom Agent Enable Flags

Custom-agent configs support both a top-level `enabled` flag and per-agent
`enabled` flags. Omitting either flag defaults to enabled. Set a specific
agent to `false` to keep it registered in runtime status while preventing
decision polling and spawning:

```json
{
  "agents": [
    {
      "id": "strategy-agent-alpacaTrader4",
      "enabled": false,
      "target": { "type": "strategy", "id": "alpacaTrader4" }
    }
  ]
}
```

## Custom Agent Parallelism

Set `spawn.parallelism` to run a bounded pool from one custom-agent definition.
It defaults to `1` and accepts integers from `1` through `32`:

```json
{
  "agents": [
    {
      "id": "game-agent",
      "target": { "type": "repository", "id": "my-game" },
      "workspace": ".autonomy/runtime/game-agent",
      "spawn": {
        "mode": "poll",
        "parallelism": 4,
        "singletonKey": "agent.id"
      }
    }
  ]
}
```

Slot 1 keeps the existing runtime key (`game-agent:my-game`); later slots use
`#2`, `#3`, and so on. Each slot has independent runtime state, invocation
artifacts, and a derived workspace. The server admits at most one new decision
per logical pool per tick, so claimed work is dispatched promptly while active
workers continue concurrently.

Decision and lifecycle commands receive `AUTONOMY_CUSTOM_AGENT_SLOT`,
`AUTONOMY_CUSTOM_AGENT_PARALLELISM`, and a matching
`parallel: { "slot": n, "total": N }` envelope. Commands that own external
claims or workspaces should use that identity to isolate per-slot state.

## Custom Agent Prompt Identity

Custom-agent configs can customize the wrapper identity text shown at the top of
the spawned agent prompt. Use top-level `promptRole` to apply one role to the
whole config, or per-agent `promptRole` to override it for one agent. The
launcher renders it as `You are a ...`. For full control over the sentence, use
`promptIntro` instead.

```json
{
  "promptRole": "trading strategy operator agent",
  "agents": [
    {
      "id": "strategy-agent-alpacaTraderCrypto24x7",
      "target": { "type": "strategy", "id": "alpacaTraderCrypto24x7" }
    }
  ]
}
```

## Current package command usage

The package itself is used through `npx autonomy-v2 ...` or by invoking the
installed binaries directly from a consumer repo.

Health score commands are available locally in each consumer repo:

```bash
npx autonomy-v2 health:score
npx autonomy-v2 health:why
npx autonomy-v2 health:help
```

## Install + initialize in a new workspace

```bash
nvm install 20
nvm use 20
```

```bash
# from the target workspace
npm install -O @asalaza6/autonomy-v2
npx autonomy-v2 init --root .
```

### Update autonomy-v2 in an existing project

From the target repository root:

```bash
npx autonomy-v2 update --root .
```

To refresh only the autonomy scaffold and local runtime bootstrap files without updating the package dependency:

```bash
npx autonomy-v2 refresh --root .
```

If Codex shows `refresh_token_reused` or says your access token could not be refreshed, reset the local session and sign in again:

```bash
codex logout
codex login
```

If browser-based login does not open or complete, use device auth instead:

```bash
codex login --device-auth
```

Use `--force` to refresh and prune scaffolded artifacts:

```bash
npx autonomy-v2 init --root . --force
```

`autonomy-v2 update` detects `npm`, `pnpm`, or `yarn`, updates `@asalaza6/autonomy-v2` to `latest` as an optional dependency, and runs `init --force` automatically when the repo is already initialized. Use `--skip-init` if you only want the package dependency update. `autonomy-v2 refresh` runs only the `init --force` scaffold refresh.

From a local monorepo path:

```bash
node packages/autonomy-v2/bin/autonomy-v2 init --root /path/to/repo
node packages/autonomy-v2/bin/autonomy-v2 prd:add --root /path/to/repo --id <id> --title <title> --specification <text> [--priority highest]
node packages/autonomy-v2/bin/autonomy-v2 prd:add --root /path/to/repo --id <id> --title <title> ...
node packages/autonomy-v2/bin/autonomy-v2-server serve --root /path/to/repo
```

From another folder using the installed package:

```bash
npx autonomy-v2 init --root /path/to/consumer-repo
npx autonomy-v2 prd:add --root /path/to/consumer-repo --id <id> --title <title> ... [--priority highest]
npx autonomy-v2-server serve --root /path/to/consumer-repo
```

## Local consumer debugging

To make sibling apps use this checkout's built package instead of the published npm release:

1. Build this repo once, or keep it running in watch mode while you debug:

```bash
npm run build
npm run build:watch
```

2. In each consumer repo, link the sibling package:

```bash
cd ../moving-game && npm run autonomy:v2:link-local
cd ../jsvpoolsinc && npm run autonomy:v2:link-local
```

3. Verify where the package resolves from:

```bash
npm run autonomy:v2:which
```

If the printed path points into `../autonomy-v2`, that consumer is running this repo's current `dist/`.

To switch a consumer back to the published package, run `npm run autonomy:v2:unlink-local` in that repo.

### Local control-plane dev mode

For live control-plane debugging against this checkout:

1. In this repo, keep the package rebuilding:

```bash
npm run build:watch
```

2. In the consumer repo, run the control plane in watch mode:

```bash
cd ../moving-game && npm run autonomy:v2:control:dev
cd ../jsvpoolsinc && npm run autonomy:v2:control:dev
```

That watch mode runs the sibling `../autonomy-v2/dist` control-plane entrypoint directly, so rebuilding this repo restarts the local control-plane server with your latest changes.
In `--dev` mode, the browser UI also auto-reloads when the watched control-plane process restarts after a local rebuild.

Server process controls are package-owned, so consumer repos can delegate the tested local restart flow to this package:

```bash
npx autonomy-v2 server:status
npx autonomy-v2 server:kill
npx autonomy-v2 server:start
npx autonomy-v2 server:restart
```

These commands use the repo root as their operating directory, track ownership through `.autonomy/server-lock/owner.json`, write restart diagnostics to `.autonomy/runtime/restart-server.log`, and clean up related macOS Terminal tabs when available. The default start command is `npm run autonomy:v2:server`; consumers can override it with `AUTONOMY_RESTART_COMMAND` and `AUTONOMY_RESTART_ARGS`.

## Happy-path consumer repo setup

For a brand-new consumer repo, the functional happy path is:

1. Install `@asalaza6/autonomy-v2` in the consumer repo.
2. Run `npx autonomy-v2 init --root .` to scaffold prompts, queues, specs, and runtime bootstrap files.
3. Add repo-level scripts that wrap `npx autonomy-v2`, `npx autonomy-v2 server:*`, `npx autonomy-v2-server`, and `npx autonomy-v2-control`.
4. Commit the tracked `prompts/autonomous/v2/` scaffold into the consumer repo.
5. Add `.npmrc` when the package is installed from GitHub Packages.
6. Add `.env.autonomy` with `AUTONOMY_INITIALIZED=1`, `GITHUB_TOKEN`, and `AUTONOMY_CONTROL_PLANE_SERVER_URL`.
7. Add hosted control-plane wiring in your deployment target with a `Procfile` or equivalent launcher and `APP_ROLE=control-plane`.
8. Deploy one shared control-plane app running `npx --no-install autonomy-v2-control serve`.
9. Run the local bridge with `npx autonomy-v2-control bridge` so the hosted app can discover this repo dynamically from `prompts/autonomous/v2/config/control-plane.json`.
10. Run the local scheduler with `npx autonomy-v2-server serve --root .`.
11. Submit PRDs in `/manager` or `/project/<repoId>` on the hosted control plane and let the bridge import them into the local repo.

## GitHub auth setup

Create a GitHub token with repository access and store it in your environment:

```bash
GITHUB_TOKEN=ghp_...
```

Required token capabilities:

- `Contents` (repository contents, commits, branches, downloads, releases, and merges)
- `Issues` (issues and related comments, assignees, labels, milestones)
- `Metadata` (required)
- `Pull requests` (pull requests and related comments, assignees, labels, milestones, and merges)

Place in one of:

- `.env.autonomy.local`
- `.env.autonomy`
- `.env.local`
- `.env`

## npm publish auth setup

To publish this package without storing a token in the repo, create a local publish env file:

```bash
cp .env.publish.example .env.publish
```

Then set your npm token in `.env.publish`:

```bash
NPM_TOKEN=npm_...
```

The release scripts load `.env.publish.local` first, then `.env.publish`, generate a temporary npm config from `NPM_TOKEN`, and use that token for `npm publish`.
Both files are gitignored.

If `NPM_TOKEN` is a GitHub token such as `ghp_...` or `github_pat_...`, publish defaults to GitHub Packages at `https://npm.pkg.github.com/`.
If `NPM_TOKEN` is an npm token such as `npm_...`, publish defaults to `https://registry.npmjs.org/`.
You can override that with `NPM_PUBLISH_REGISTRY=...` in the same env file.

## Compatibility with current repo setup

- Root scripts in `package.json` already forward into this package:
  - `autonomy:v2:init`
  - `autonomy:v2:status`
  - `autonomy:v2:runtime`
  - `autonomy:v2:server`
  - `autonomy:v2:control`
  - `autonomy:v2:tick`

## Package health checks

- Local package smoke check:

```bash
node packages/autonomy-v2/package-smoke.test.js
```

## Design scope

This package focuses on generic workflow orchestration.
Only the package boundary and packaging metadata were organized.
