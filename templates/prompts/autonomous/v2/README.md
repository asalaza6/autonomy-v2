# Autonomous v2

Autonomous v2 is a GitHub-backed multi-agent delivery loop.

It is built around one steady-state operator workflow:

1. start the scheduler
2. add a PRD

From there, the system is expected to:

- sync `origin/dev`
- import the PRD into runtime state
- have `pm-agent` generate lane tasks
- run the default implementation lane(s)
- open one PR per implementation lane only after that lane finishes its queued tasks
- queue reviewer work
- review and merge to `dev`

`main` remains a manual promotion step.

## What v2 is

V2 is not a web server or dashboard. The "server" is a polling scheduler.

On each poll it:

- syncs against `origin/dev`
- reconciles imported PRD state
- decides which agents are due
- spawns at most one worker per agent id

The default poll interval is 2000 ms.

## Current agent set

The active v2 agents are defined in `prompts/autonomous/v2/config/agents.json`, and the scaffold generator reads that file directly.

The default setup ships with:

- `pm-agent`
- `architecture-agent`
- `reviewer`

Other repos can add or remove implementation agents by editing `agents.json` and rerunning `init --force`.

Implementation and review execution uses the packaged fixed runner at `src/autonomy-v2/runner/default-runner.js`.

Lane ownership is path-scoped in the active config:

- `architecture-agent` -> `**/*`

## Source of truth

The important v2 distinction is between tracked input and local execution cache.

### Tracked truth

Tracked truth lives in git on `dev`:

- agent config
- sprint config
- agent prompt files
- implementation queues in `prompts/autonomous/v2/queues/<agent-id>.json`
- committed active PRD specs in `prompts/autonomous/v2/specs/prds/<prd-id>.json`
- queued PRDs in `prompts/autonomous/v2/specs/prds/queue/<prd-id>.json`
- completed PRD specs may be moved into `prompts/autonomous/v2/specs/prds/archived/`, which sync ignores
- PM-generated implementation task entries once planning completes

### Runtime cache

Runtime state lives under `.autonomy/runtime`:

- non-implementation queues
- leases
- worker status
- reconstructed PR records
- logs
- worktree metadata

For imported PRDs, runtime files are not treated as the long-term authority anymore. On sync, the system rebuilds imported PRD state from:

- `origin/dev`
- remote lane branches
- GitHub PR state and commit counts

That rebuild happens in `src/autonomy-v2-dev-sync.js`.

## Current behavior

What is true on `dev` today:

- `prd:add` commits a PRD spec to `dev` and pushes it automatically.
- Sync imports active PRD specs from `prompts/autonomous/v2/specs/prds/<prd-id>.json`.
- Files in `prompts/autonomous/v2/specs/prds/queue/` and `prompts/autonomous/v2/specs/prds/archived/` are ignored during sync.
- The scheduler syncs `origin/dev` every tick.
- When safe, local `dev` is fast-forwarded to the fetched remote ref so the checkout stays aligned.
- `pm-agent` uses Codex CLI to turn a freeform PRD into lane task specs.
- PM persists those generated implementation tasks into tracked per-agent queue files on `dev`.
- The starter template stores `pm-agent`, implementation-agent, and `reviewer` queue files under `prompts/autonomous/v2/queues/`.
- Only implementation queues are currently treated as tracked queue truth; `.autonomy/runtime/state/*` remains operational cache and derived state.
- Implementation agents use Codex CLI inside isolated git worktrees.
- Each implementation lane reuses one deterministic lane branch and worktree.
- One PR is created per `prd + implementation-agent` lane.
- A lane PR is created only after that lane has completed its currently queued tasks.
- Implementation completion is inferred from tracked queue state, not from raw branch commit count.
- Reviewer work is per-lane and can start as soon as the first lane PR exists; it does not wait for all implementation lanes to finish.
- If reviewer requests changes, the system creates or updates a lane-local `review_followup` task on the same branch.
- Review follow-up tasks use the latest reviewer summary as their default acceptance payload unless the task already has explicit custom acceptance.
- Reviewer uses Codex CLI to review lane diffs, then publishes review state and merges approved PRs.
- When GitHub refuses same-actor review submission, the system falls back to comment-based review recording and continues.
- Successful merge can archive fully completed PRD specs into `specs/prds/archived/`; operators can also run `prd:archive-completed` manually.
- Restart/reconciliation derives imported completion from GitHub state rather than replaying stale local queue entries.

## Workflow

### 1. Start the scheduler

```bash
npm run autonomy:v2:server
```

The scheduler begins polling immediately.

### 2. Add a PRD

```bash
node scripts/autonomy-v2.js prd:add --id prd-123 --title "Example" --specification "..." --requirement "..."
```

That command:

- writes to `prompts/autonomous/v2/specs/prds/<prd-id>.json` when no active PRD exists, otherwise to `prompts/autonomous/v2/specs/prds/queue/<prd-id>.json`
- commits it to `dev`
- pushes `dev`

### 3. Sync imports the PRD

The next scheduler tick:

- fetches `origin/dev`
- reads committed PRD specs from git
- imports or updates runtime PRD records

### 4. PM plans the PRD

`pm-agent` claims the newest queued PRD and uses Codex CLI to generate lane task specs.

Those planned tasks are:

- written into tracked implementation queue files on `dev`
- made dispatchable without a runtime implementation queue as source of truth

### 5. Implementation lanes execute

Each implementation agent:

- reads the current tracked queue task
- prepares its deterministic worktree and branch
- runs Codex in that worktree
- determines success from repo side effects, not structured implementation JSON
- validates changed files against the agent scope
- runs configured checks
- commits the task result, records the work commit SHA in the tracked queue, and pushes

Current lane branches are deterministic:

- `agent/<sprint>/<agent-id>/<prd-id>-<agent-id>`

### 6. PR creation happens at lane completion

PR creation is lane-level, not per-task.

That means:

- task 1 advances the branch-local queue and creates task result commits on the lane branch
- task 2 continues on the same lane branch
- only after the lane has no remaining queued tasks does the system record and publish the lane PR

In a typical setup:

- 1 implementation lane
- 1-3 tasks per lane
- 1 PR per lane
- one commit per task

### 7. Reviewer processes lane PRs

When a lane PR exists, reviewer work is queued automatically.

Reviewer is lane-local. If one lane finishes early, reviewer may review or merge that PR while other implementation lanes are still running.

Reviewer:

- compares the PR branch against `origin/dev`
- checks scope and required commands
- asks Codex for the review decision
- records the result
- merges approved PRs to `dev`

If review requests changes:

- the same implementation lane receives a `review_followup` task
- the follow-up runs on the existing lane branch and worktree
- the follow-up acceptance defaults to the latest review summary
- once the branch is updated, the PR can be sent back through reviewer again

## Operator workflow

After one-time setup, the intended day-to-day flow is:

1. `npm run autonomy:v2:server`
2. `node scripts/autonomy-v2.js prd:add ...`

No extra clone is required.

The same checkout can be reused. Execution isolation comes from `.autonomy/worktrees`, not from making a fresh repo clone for every PRD.

## One-time setup

### Install package (if running from npm)

```bash
nvm install 20
nvm use 20
```

```bash
npm install -D @asalaza6/autonomy-v2
```

Then initialize in your workspace root:

```bash
npx autonomy-v2 init --root .
npx autonomy-v2 init --root . --force
```

### Environment

### GitHub auth (required)

Create a GitHub token and place it in your environment file (for example
`.env.autonomy.local` or `.env.autonomy`) as:

```bash
GITHUB_TOKEN=ghp_...
```

The token must allow repository access for the workflow:

- `Contents` (Repository contents, commits, branches, downloads, releases, and merges)
- `Issues` (Issues and related comments, assignees, labels, milestones)
- `Metadata` (Required)
- `Pull requests` (Pull requests and related comments, assignees, labels, milestones, and merges)

Autonomy commands auto-load env files in this order:

- `.env.autonomy.local`
- `.env.autonomy`
- `.env.local`
- `.env`

At minimum:

```bash
GITHUB_TOKEN=...
```

Codex CLI must also be installed and authenticated:

```bash
codex login
```

Optional:

```bash
CODEX_BIN=codex
AUTONOMY_CODEX_MODEL=...
AUTONOMY_CODEX_PROFILE=...
```

### Runtime init

```bash
npm run autonomy:v2:init -- --force
```

## Observability

Useful places to inspect:

- server stdout
- `.autonomy/runtime/agents/<agent>/log.md`
- `.autonomy/runtime/state/prs.json`
- `.autonomy/runtime/state/runtime.json`
- `prompts/autonomous/v2/queues/*.json`
- `prompts/autonomous/v2/specs/prd-state/*.json`

The per-agent logs are the fastest way to see:

- lease events
- worktree preparation
- Codex summaries
- PR publication
- review queue creation
- merge results

## Tests

The v2 test suite runs the orchestration path with stubbed Codex behavior:

```bash
npm run autonomy:v2:test
```

## Reference links

- [`prompts/autonomous/v2/config/agents.json`](config/agents.json)
- [`prompts/autonomous/v2/config/sprint.json`](config/sprint.json)

The live GitHub flow requires real `codex` auth and a valid GitHub token.

## Known limitations

Current limitations worth knowing:

- GitHub still sees one actor account for PR creation, comments, and merges in the default setup.
- Runtime worker bookkeeping is still local cache, even though imported PRD truth is rebuilt from GitHub and `dev`.
- First sync/tick cost scales with the number of active unarchived PRDs because reconciliation walks remote lane state.
- The system is hardened for restart recovery, but it is still operational software rather than a finished product surface.

## Key files

- [`[package] scripts/autonomy-v2.js`](scripts/autonomy-v2.js)
- [`[package] scripts/autonomy-v2-server.js`](scripts/autonomy-v2-server.js)
- [`[package] scripts/autonomy-v2-worker.js`](scripts/autonomy-v2-worker.js)
- [`[package] scripts/autonomy-v2-orchestrator.js`](scripts/autonomy-v2-orchestrator.js)
- [`[package] prompts/autonomous/v2/config/agents.json`](prompts/autonomous/v2/config/agents.json)
- [`[package] prompts/autonomous/v2/config/sprint.json`](prompts/autonomous/v2/config/sprint.json)
