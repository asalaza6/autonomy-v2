# State-Driven Logic

This document explains which autonomy v2 behaviors are still driven by local runtime state, which parts are already git-backed, and which state-driven areas are realistic candidates to move into git-backed logic.

## Terms

- `git-backed authoritative state`: state read from tracked refs and written back to the integration branch as part of normal workflow
- `runtime-local state`: state stored in the current workspace under `.autonomy/runtime/` or other local files and not treated as tracked git truth
- `derived runtime projection`: local state rebuilt from tracked repo state and external systems so the scheduler can operate without recomputing everything on every step

## Current Git-Backed Authority

These are already the durable workflow truth today:

- PRD specs in `prompts/autonomous/v2/specs/prds/*.json`
- queued PRD specs in `prompts/autonomous/v2/specs/prds/queue/*.json`
- implementation queue files in `prompts/autonomous/v2/queues/<implementation-agent>.json`
- implementation lane progress recorded in tracked queue state on `dev` and on the lane branch

Important distinction:

- a file living inside the repo tree does not automatically make it git-backed authoritative state
- PM and reviewer queue files can be configured to live under `prompts/autonomous/v2/queues/`, but today they are still treated as local operational files unless the workflow explicitly commits and reads them as tracked truth

## Current State-Driven Logic

### 1. Worker and scheduler bookkeeping

Current storage:

- `.autonomy/runtime/state/runtime.json`

What it holds:

- worker activity
- scheduler grace-window flags such as backlog suppression bookkeeping
- other process-local runtime coordination

Why it is still local:

- this data is machine-local and short-lived
- it reflects process liveness, not product truth
- committing worker heartbeat data to git would create constant churn with little recovery value

Recommendation:

- keep local

### 2. Branch locks and worktree ownership

Current storage:

- `.autonomy/runtime/state/branch-locks.json`
- `.autonomy/worktrees/*`

What it holds:

- lane-to-branch association
- worktree path
- branch/worktree reuse metadata
- completed lane task lookup used during local orchestration

Why it is still local:

- worktree paths are host-specific
- branch lock ownership is primarily a local coordination concern
- active lock data behaves like a local lease even when some of the payload mirrors tracked queue state

Migration potential:

- partial only
- branch name and completed-task summaries could be reduced or moved into tracked lane metadata if needed
- worktree paths and live lock ownership should stay local

Recommendation:

- keep the lock itself local
- only consider moving a minimal branch mapping if restart recovery still needs it after further simplification

### 3. Spec sync bookkeeping

Current storage:

- `.autonomy/runtime/state/spec-sync.json`

What it holds:

- last fetched ref
- imported spec bookkeeping

Why it is still local:

- this is a sync cursor and cache, not workflow truth
- it can be rebuilt or safely discarded

Recommendation:

- keep local

### 4. Tracked PRD lifecycle companion

Current storage:

- `prompts/autonomous/v2/specs/prd-state/<prd-id>.json`

What it holds:

- tracked lifecycle statuses: `planning`, `planned`, `failed`
- `plannedTaskIds`
- `lastError`
- timestamps for PM planning state transitions

Why it is tracked:

- it captures PM planning state that is not fully derivable from spec placement alone
- it is committed alongside planning outcomes so restart and cross-machine behavior stay deterministic

Migration potential:

- low
- the remaining design question is whether to track more lifecycle milestones or derive them more aggressively

Recommendation:

- keep the companion file narrow
- do not move sync-only cache fields into git

### 5. Non-implementation task authority after migration

Current storage:

- reviewer tasks: `prompts/autonomous/v2/queues/reviewer.json`
- PM tasks: the resolved `taskQueue` file for the PM agent

What it holds:

- reviewer queue truth on the integration branch
- PM operational queue state when PM work is dispatched locally

Why the split exists:

- reviewer task truth now follows the same tracked model as implementation work
- PM work is still operational local state because PRD specs and tracked PRD lifecycle already supply the durable planning contract

Migration potential:

- low for reviewer queue authority because it is already git-backed
- medium for PM queue authority if PM dispatch itself needs durable queue truth across machines

Recommendation:

- keep reviewer queues tracked
- keep PM queue state local unless PM dispatch is explicitly promoted to tracked queue truth

### 6. PM and reviewer queue files

Current storage:

- resolved from each agent's `taskQueue`
- in the starter template, both currently point at repo paths under `prompts/autonomous/v2/queues/`

What they hold:

- operational queue entries for non-implementation agents

Why they differ today:

- reviewer queue state is read from tracked refs and committed back to the integration branch as queue truth
- PM queue state is still resolved from the local filesystem path in the active checkout

Migration potential:

- low for reviewer queues
- medium for PM queues

Recommendation:

- reviewer queue authority is already in the right place
- PM queue authority is the remaining candidate; if it moves, prefer a minimal tracked planning-state model instead of adding redundant queue churn

### 7. Pull request runtime state

Current storage:

- `.autonomy/runtime/state/prs.json`

What it holds:

- lane PR records
- review outcomes
- merge status
- PR-to-task linkage used by the scheduler and reviewer flow

Why it is still local today:

- much of this data is mirrored from GitHub or derived from queue state
- local storage gives the scheduler a fast working projection

Migration potential:

- medium
- a minimal tracked PR manifest could improve restart recovery
- full git-backing is less attractive because GitHub already acts as the external system of record for the PR itself

Recommendation:

- prefer derivation from GitHub where possible
- only move the minimal lane linkage that cannot be recovered cheaply

### 8. Leases

Current storage:

- `.autonomy/runtime/state/leases.json`

What it appears to represent:

- runtime lease-style coordination for scheduler or worker behavior

Current status:

- documented and scaffolded as runtime state
- not a strong candidate for tracked git truth

Recommendation:

- keep local if retained
- if no longer needed in practice, deprecate or remove rather than moving it to git-backed logic

### 9. Logs and local execution artifacts

Current storage:

- `.autonomy/runtime/agents/*`
- `.autonomy/worktrees/*`
- `.autonomy/control/*`

What they hold:

- per-agent logs
- local worktrees
- local control and lock artifacts

Why they are still local:

- they are host-specific operational artifacts
- they are useful for debugging and local recovery, not durable workflow truth

Recommendation:

- keep local

## What Can Realistically Move To Git-Backed Logic

### High-value candidates

- PM queue authority if PM work needs the same cross-machine durability as reviewer and implementation work
- selected PR linkage metadata if GitHub-only reconstruction becomes too lossy
- a narrower tracked summary for archive/completion bookkeeping if runtime status queries become expensive

Why these are good candidates:

- they affect workflow correctness across restarts and across machines
- they benefit from auditability
- they are not inherently host-local

### Partial candidates

- selected branch metadata currently duplicated in `branch-locks.json`
- a minimal PR linkage manifest if GitHub lookups alone are not enough

Why only partial:

- some fields are durable workflow state
- other fields are machine-specific and should stay local

### Bad candidates

- worker liveness
- worktree paths
- sync cursors
- local logs
- lease-like process coordination

Why these should stay local:

- they are transient
- they are machine-specific
- committing them would create noise without improving correctness

## Recommended Migration Order

1. Keep implementation queues, reviewer queues, and PRD lifecycle state tracked in git.
2. If PM dispatch needs stronger durability, move PM queue authority next.
3. Only then consider whether a small subset of `prs.json` or `branch-locks.json` should move into tracked metadata.
4. Keep worker/runtime/process state local.

## Practical Rule

Use this rule when deciding whether a state-driven behavior should move to git-backed logic:

- move it if it represents durable workflow truth that should survive machines, restarts, and operator context changes
- keep it local if it represents liveness, locks, paths, caches, or short-lived scheduler coordination

Under that rule, implementation queues are already in the right place. The next best git-backed migration target is reviewer and non-implementation queue authority, not worker/runtime bookkeeping.
