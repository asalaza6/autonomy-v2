# How Autonomy V2 Works

Autonomy v2 is a GitHub-backed, repo-local multi-agent delivery loop.

The package owns the command implementations, scheduler, runner, control-plane
server, bridge, and scaffold templates. The consumer repo owns the actual
runtime state, git branches, worktrees, prompts, queue files, PRDs, checks, and
deployment wiring.

## Core Layers

### Package entrypoints

- `autonomy-v2` is the operator CLI for `init`, `prd:add`, `status`, `deploy`,
  queue mutation, worktree preparation, and PR/review state transitions.
- `autonomy-v2-server` is the polling scheduler. It repeatedly syncs tracked
  repo state, finds due agents, and starts workers.
- `autonomy-v2-control` is the control-plane binary. In `serve` mode it hosts
  the manager/project UI and queue API. In `bridge` mode it runs locally and
  executes queued jobs against mapped repo paths.

### Repo contract

The scaffolded repo contract lives under `prompts/autonomous/v2/`.

Important tracked files:

- `config/agents.json` defines agents, branches, queue paths, checks, scopes,
  merge behavior, and git identities.
- `config/sprint.json` defines sprint-level workflow defaults.
- `config/control-plane.json` defines the repo id, manager display metadata,
  deployment link metadata, and optional deploy hook.
- `queues/<agent-id>.json` stores tracked implementation and reviewer queue
  truth.
- `specs/prds/*.json` stores active PRD specs.
- `specs/prds/queue/*.json` stores queued PRDs when another active PRD exists.
- `specs/prds/archived/*.json` stores completed PRDs that sync should ignore.
- `specs/prd-state/*.json` stores narrow tracked PM planning lifecycle state.

### Runtime cache

`.autonomy/` is local operational state, not durable product truth.

It stores runtime worker status, branch locks, reconstructed PR records, sync
cursors, logs, control-plane state, and worktrees. Much of it is useful for
speed and debugging, but scheduler recovery should rebuild as much as possible
from tracked git state, remote lane branches, and GitHub PR state.

## Source Of Truth

Tracked git state is authoritative for durable workflow facts:

- PRD specs
- PRD planning lifecycle state
- implementation queues
- reviewer queues
- branch-local implementation queue progress

Local runtime state is appropriate for host-specific or short-lived facts:

- worker liveness
- worktree paths
- branch lock ownership
- logs
- control-plane local cache
- sync cursors

This split is the main design guardrail. AI calls are allowed to be
nondeterministic, but queue mutation, branch preparation, checks, scope
validation, commits, pushes, reviews, and merges are deterministic wrapper
steps.

## PRD To Merge Flow

1. An operator or the manager submits a PRD.
2. `prd:add` writes the PRD spec to the integration branch, usually `dev`, or
   to the queued PRD directory if another active PRD is already present.
3. The scheduler fetches the integration branch and imports tracked PRD specs.
4. The PM agent claims one queued PRD and asks Codex to edit the PRD spec with
   lane task plans.
5. PM validates the planned tasks and commits them into tracked implementation
   queue files.
6. An implementation agent claims the next dispatchable tracked task.
7. The worker prepares a deterministic lane branch and worktree.
8. The default runner invokes Codex in that worktree. Codex edits files, but it
   does not commit, push, merge, or open PRs itself.
9. The wrapper collects changed files, validates scope, runs configured checks,
   advances the branch-local queue, commits, records the work commit SHA, and
   pushes the lane branch.
10. When the lane has no remaining queued work, the wrapper records or updates
    one lane PR.
11. Reviewer work is queued for that lane PR.
12. The reviewer runner builds review context, computes diff files, evaluates
    scope, runs checks, asks Codex for a review decision, then normalizes that
    decision with deterministic check and scope results.
13. Approved PRs are merged into the integration branch. Change requests append
    a `review_followup` task to the same implementation lane.

There is one PR per lane, not one PR per task.

## Manager And Bridge

The manager is the hosted control room at `/manager`.

It shows:

- registered repos
- active and queued PRDs
- agent status
- active PRs
- bridge and scheduler heartbeat health
- deploy availability and deploy jobs
- version status from the latest deploy result or repo snapshot

The project page at `/project/<repoId>` is a narrower view for one repo.

The hosted manager does not directly control repo files. It stores jobs and
status snapshots. The local bridge is the execution boundary:

1. The bridge reads repo registrations from local
   `prompts/autonomous/v2/config/control-plane.json` files.
2. It posts each repo's status snapshot to the hosted control plane.
3. It polls for queued jobs matching those repo ids.
4. It claims one job at a time.
5. For PRD jobs, it runs the repo-local `prd:add` flow.
6. For deploy jobs, it runs the repo-local `deploy` flow.
7. It marks jobs completed or failed and keeps posting fresh status snapshots.

That means one hosted control plane can show and queue work for multiple repos,
while the machine running the bridge remains the only place that needs local
filesystem and git access to those repos.

## Repo Registration

A repo becomes visible to the manager when a bridge can load its
`control-plane.json` and post a status snapshot.

Minimal repo config:

```json
{
  "schemaVersion": 1,
  "repoId": "my-app",
  "label": "My App",
  "description": "Customer-facing app",
  "deploymentUrl": "https://my-app.example.com",
  "deploymentLabel": "Production site"
}
```

Run a bridge with one or more local repo paths:

```bash
npx autonomy-v2-control bridge \
  --server-url https://your-control-plane.example.com \
  --repo-map /Users/me/projects/my-app,/Users/me/projects/admin
```

You can also pin ids explicitly:

```bash
npx autonomy-v2-control bridge \
  --server-url https://your-control-plane.example.com \
  --repo-map my-app=/Users/me/projects/my-app,admin=/Users/me/projects/admin
```

If an explicit map key is used, it must match the repo's `repoId`.

## Deployments

The manager shows a Deploy button when a repo status snapshot says the
integration branch has changes relative to the production branch.

By default:

- source branch is `integrationBranch`, usually `dev`
- target branch is `productionBranch`, usually `main`

When a deploy job runs, the bridge calls the repo-local `deploy` command. That
command:

1. verifies the source and target branches differ
2. requires a clean working tree
3. resolves the source and target refs
4. verifies the target is an ancestor of the source, so deployment can
   fast-forward safely
5. updates the target branch ref to the source SHA
6. pushes the target branch to `origin` when an origin remote exists
7. runs an optional `deployCommand`
8. records build and publish version information when available

`deploymentUrl` and `deploymentLabel` are display metadata only. They do not
perform deployment. The deploy hook is `deployCommand`.

`deployCommand` may be a string, an argv array, or an object.

String form:

```json
{
  "deployCommand": "npm run deploy"
}
```

Array form:

```json
{
  "deployCommand": ["git", "push", "heroku", "main"]
}
```

Object form:

```json
{
  "deployCommand": {
    "command": "npm",
    "args": ["run", "deploy"],
    "cwd": ".",
    "env": {
      "DEPLOY_TARGET": "production"
    }
  }
}
```

Deploy hooks receive these environment variables:

- `AUTONOMY_DEPLOY_SOURCE_BRANCH`
- `AUTONOMY_DEPLOY_TARGET_BRANCH`
- `AUTONOMY_DEPLOY_SHA`

For this repo, `prompts/autonomous/v2/config/control-plane.json` currently
uses:

```json
{
  "deployCommand": ["git", "push", "heroku", "main"]
}
```

So a deploy from the manager fast-forwards `main` from `dev`, pushes
`origin/main`, then pushes `main` to the `heroku` remote.

### Build and publish versions

The manager's version display is a build identifier, not only the published
package version. When git metadata is available, deploy snapshots use:

```text
<packageVersion>+build.<commitCount>.<shortSha>
```

For example, a repo whose `package.json` still says `1.4.44` can still show a
new build such as `1.4.44+build.109.abc123abc123` when `dev` points at a newer
commit. The publish version is kept separately as metadata, so package-version
based releases remain supported without hiding newer commit-based builds.

## Hosted Control Plane Deployment

The hosted control plane is just the API/UI process. It can run anywhere that
can run the package.

This repo's `Procfile` runs:

```Procfile
web: node dist/bin/autonomy-v2-control.js serve --root . --host 0.0.0.0 --port $PORT
```

Consumer deployments can equivalently run:

```bash
npx --no-install autonomy-v2-control serve --root . --host 0.0.0.0 --port "$PORT"
```

The hosted process needs persistence if queued jobs and status snapshots should
survive restarts. For local or ephemeral testing, set:

```bash
AUTONOMY_CONTROL_PLANE_PERSIST=0
```

## Safe Testing

Basic project checks:

```bash
npm run typecheck
npm test
```

Local manager smoke test:

```bash
npm run build
AUTONOMY_CONTROL_PLANE_PERSIST=0 \
  node dist/bin/autonomy-v2-control.js serve --root . --port 3333 --dev
```

Open:

```text
http://127.0.0.1:3333/manager
```

Register the current repo with one bridge pass:

```bash
node dist/bin/autonomy-v2-control.js bridge \
  --root . \
  --server-url http://127.0.0.1:3333 \
  --repo-map . \
  --once
```

Use a throwaway repo for deploy testing. Configure a harmless deploy hook:

```json
{
  "deployCommand": ["node", "-e", "console.log('deploy hook ok')"]
}
```

Then make `dev` one commit ahead of `main`, run the local manager and bridge,
and click Deploy on `/project/<repoId>`. The expected result is a completed
deploy job, `main` fast-forwarded to `dev`, and deploy hook output recorded in
the job result.

Do not test deploy against a real repo unless pushing the production branch and
running its configured deploy hook is intended.

## Key Files

- `src/server/orchestrator/scheduler.ts` runs scheduler ticks.
- `src/server/orchestrator/workers-core.ts` dispatches agent role execution.
- `src/agents/*AgentDefinition.ts` defines PM, implementation, and review
  behavior.
- `src/autonomy-v2/runner/default-runner.ts` enters implementation or review
  runner flows.
- `src/codex/planning.ts` builds PM planning prompts and validates planned
  tasks.
- `src/codex/worker.ts` builds implementation and review Codex prompts.
- `src/sync/syncer.ts` rebuilds runtime projection from tracked git state.
- `src/server/control-plane/control-plane-main.ts` hosts manager/project UI and
  job APIs.
- `src/server/control-plane/control-plane-bridge.ts` claims hosted jobs and
  executes them locally.
- `src/autonomy-v2/control-plane/status-service.ts` builds repo status
  snapshots for the manager.
- `src/autonomy-v2/commands/deploy.ts` resolves deployment config and executes
  deploy.
- `src/autonomy-v2/commands/shared-github.ts` contains local deploy and merge
  git/GitHub helpers.
