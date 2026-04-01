# Autonomy v2 Package

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

## Docs

- [Autonomy V2 Config Support](./docs/autonomy-v2-config-support.md)
- [Orchestrator Flow](./docs/orchestrator-flow.md)
- [Control Plane Bridge](./docs/control-plane-bridge.md)
- [Orchestrator Failure Cases](./docs/orchestrator-failure-cases.md)
- [Structureness Health Flow](./docs/structureness-health-flow.md)
- [Git-backed Implementation Queues](./docs/git-backed-implementation-queues.md)
- [Current Issues / Deferred Fixes](./issues.md)
- [Feature Design Template](./features.md)

## Current package command usage

The package itself is used through `npx autonomy-v2 ...` or by invoking the
installed binaries directly from a consumer repo.

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

`autonomy-v2 update` detects `npm`, `pnpm`, or `yarn`, updates `@asalaza6/autonomy-v2` to `latest` as an optional dependency, and runs `init --force` automatically when the repo is already initialized. Use `--skip-init` if you only want the package dependency update.

From a local monorepo path:

```bash
node packages/autonomy-v2/bin/autonomy-v2 init --root /path/to/repo
node packages/autonomy-v2/bin/autonomy-v2 prd:add --root /path/to/repo --id <id> --title <title> --specification <text>
node packages/autonomy-v2/bin/autonomy-v2 prd:add --root /path/to/repo --id <id> --title <title> ...
node packages/autonomy-v2/bin/autonomy-v2-server serve --root /path/to/repo
```

From another folder using the installed package:

```bash
npx autonomy-v2 init --root /path/to/consumer-repo
npx autonomy-v2 prd:add --root /path/to/consumer-repo --id <id> --title <title> ...
npx autonomy-v2-server serve --root /path/to/consumer-repo
```

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
