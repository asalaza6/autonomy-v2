# Project Context

This file is the project-specific context pack for this repo's Autonomy V2
agents. Keep it current when the repo architecture, deploy path, checks, or
operator workflow changes.

Each agent `system.md` points here so agents can read one stable document before
searching the rest of the repo.

## Project Identity

This repo is the `@asalaza6/autonomy-v2` package. It owns the CLI commands,
scheduler, default runner, hosted control-plane server, bridge, templates, and
repo-local prompt/config scaffolding used by consumer repos.

`autonomy-v2` is installed into consumer repos, but this repo owns the package
implementation and the hosted manager/control-plane app.

## Mental Model

- Durable workflow truth lives in git on `dev`, mostly under
  `prompts/autonomous/v2/`.
- `.autonomy/` is local runtime cache for logs, worker state, worktrees, locks,
  and reconstructed status.
- PRDs are committed to `dev`.
- PM planning writes tracked implementation queue tasks.
- Implementation agents work in lane branches and worktrees.
- Reviewer gates lane PRs and approved PRs merge back to `dev`.
- Deployment is a separate promotion: deploy fast-forwards `main` from `dev`
  and then runs the configured deploy command.
- The hosted manager does not directly edit repo files. It queues jobs and
  receives status. The local bridge maps repo ids to local paths and executes
  `prd:add` or `deploy` inside the mapped repo.

## Branch And Deploy Contract

- integration branch: `dev`
- production branch: `main`
- blocked direct targets: `main`, `master`
- merge strategy: merge commits into `dev`
- deploy source: `dev`
- deploy target: `main`
- deploy hook: `git push heroku main`
- hosted control plane is served by `autonomy-v2-control`

The manager deploy button queues a deploy job. The bridge claims the job and
runs the repo-local `autonomy-v2 deploy` command. That command fast-forwards
`main` from `dev`, pushes `origin/main` when `origin` exists, and then runs the
repo's configured `deployCommand`.

## Important Files And Directories

- `src/autonomy-v2/commands/` for CLI commands, deploy, PRD, queue, and git
  operations
- `src/server/control-plane/` for manager UI, project UI, API, bridge, and
  browser client
- `src/autonomy-v2/control-plane/` for runtime status snapshots and dashboard
  summaries
- `src/sync/` for tracked PRD, queue, branch, and GitHub state reconstruction
- `src/autonomy-v2/runner/` for packaged runner behavior
- `templates/` for scaffolded files copied into consumer repos by `init`
- `prompts/autonomous/v2/config/` for this repo's agent, sprint, and
  control-plane wiring
- `prompts/autonomous/v2/queues/` for tracked implementation and review queue
  state
- `prompts/autonomous/v2/specs/prds/` for active PRD specs
- `prompts/autonomous/v2/specs/prds/queue/` for waiting PRDs
- `prompts/autonomous/v2/specs/prds/archived/` for completed PRDs that sync
  ignores
- `tests/unit/` and `tests/smoke/` for focused automated coverage

## Entrypoints

- `autonomy-v2` runs package CLI commands such as `init`, `prd:add`, `status`,
  and `deploy`
- `autonomy-v2-server` runs the polling scheduler
- `autonomy-v2-control serve` hosts the manager/project UI and API
- `autonomy-v2-control bridge` runs locally and executes queued control-plane
  jobs

## Current Agents

- `pm-agent`: plans queued PRDs into implementation queue tasks
- `architecture-agent`: the only implementation lane; owns scope `**/*`
- `reviewer`: gates and merges implementation PRs into `dev`

Current implementation check:

```bash
npm run typecheck
```

## High-Risk Areas

- deploy flow: `dev -> main`, origin pushes, `deployCommand`, and Heroku hooks
- control-plane server, bridge, manager UI, and project UI
- tracked PRD specs, implementation queues, reviewer queues, and sync recovery
- GitHub PR reconstruction, branch state, merge behavior, and worktrees
- packaged templates and prompt/config files copied into consumer repos
- version reporting, especially publish/package version versus build/commit
  version

## Useful Test Targets

- `tests/unit/control-plane-*.test.ts` for manager/dashboard/bridge/status logic
- `tests/smoke/control-plane.test.ts` for served manager and bridge behavior
- `tests/smoke/deploy.test.ts` for deploy command behavior
- sync and queue unit tests for PRD import, lane state, and review follow-up

Run broader tests when changing shared contracts or behavior that crosses CLI,
server, bridge, sync, and templates.
