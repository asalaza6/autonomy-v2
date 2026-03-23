# Autonomy V2 Orchestrator Failure Cases

This document describes where the orchestrator may fail today and, more importantly, which failures should be considered real orchestration failures.

The key framing is:

- AI output is not inherently a failure.
- If the model returns an output, the orchestrator should prefer to classify, record, or continue rather than crash.
- Failures should come from deterministic contract violations, state corruption, missing prerequisites, or infrastructure boundaries.

This means a result like "no code changes were needed" is not an orchestrator failure by itself. It may be a valid task outcome.

## Core principle

The orchestrator should only fail when it cannot safely decide what to do next.

That usually means one of these:

- it cannot trust the current state
- it cannot mutate required state safely
- it cannot determine the correct next transition
- it cannot complete a required deterministic side effect

It should not fail just because the AI behaved differently than expected inside a valid envelope.

## What is not a failure

These cases should generally not crash the orchestrator:

- Codex returns an output that says the task is already satisfied
- Codex returns an output that results in zero file changes
- Codex returns a weak summary or low-value explanation
- Codex chooses not to modify code because the requirement is already met
- a review finds no blocking issues
- a PM decomposition is imperfect but structurally valid

These may require a state transition, a note in logs, or human visibility, but not a hard orchestration failure.

## Failure classes

The repo has several different kinds of failure, and they should not all be treated the same.

### 1. Configuration failures

These are real hard failures because the orchestrator cannot trust its setup.

Examples:

- missing `agents.json`
- malformed JSON config
- duplicate agent IDs
- unsupported agent roles
- missing `systemPrompt`
- missing `gitIdentity`
- missing `runnerCommand` for non-PM agents
- invalid `mergeActors`

Why these are real failures:

- the scheduler cannot construct a valid state machine without a valid roster and agent contract

Expected handling:

- fail fast
- print a precise configuration error
- do not retry automatically until config changes

### 2. Environment prerequisite failures

These are real failures when the command cannot proceed without external prerequisites.

Examples:

- missing required environment variables
- missing GitHub auth for operations that require GitHub
- invalid root path
- required executable not present for a configured runner
- invalid `--poll-ms` or `--sync-ms`

Why these are real failures:

- the orchestrator does not have the required inputs to perform the requested deterministic step

Expected handling:

- fail fast for the active command
- mark the issue as operator-visible
- avoid endless scheduler retries for the same persistent precondition failure

### 3. Locking and state mutation failures

These are real failures because they threaten state consistency.

Examples:

- timeout acquiring the state lock
- timeout acquiring the server lock in a context that expects exclusivity
- failure writing runtime JSON
- failure writing queue or lease state
- failure writing agent logs or error reports when those writes are required for correctness

Why these are real failures:

- the orchestrator cannot safely mutate shared state

Expected handling:

- abort the active transition
- do not partially apply later steps
- surface the specific lock or write failure

### 4. State integrity failures

These happen when stored state no longer matches the orchestrator's assumptions.

Examples:

- unknown task ID for a required transition
- unknown PR ID during review or merge
- leased task disappears between lease and dispatch
- task is not present in the expected queue
- branch/worktree metadata points to a missing or invalid git worktree
- aggregate runtime files disagree with per-agent queues in a way the code cannot reconcile

Why these are real failures:

- the orchestrator can no longer trust the state machine

Expected handling:

- stop the current transition
- preserve evidence in logs
- prefer repair/reconciliation before resuming automated execution

### 5. Sync and reconciliation failures

These are failures in the boundary between tracked git truth, GitHub truth, and local runtime cache.

Examples:

- failure fetching the integration branch
- failure reading PRD specs from the fetched ref
- invalid PRD JSON in tracked specs
- duplicate PRD IDs in tracked specs
- failure reconstructing runtime state from tracked truth
- failure syncing remote branch or PR metadata

Why these are real failures:

- the scheduler relies on sync to know which work exists and whether runtime state is stale

Expected handling:

- fail the sync phase
- do not silently invent replacement state
- avoid converting a permanent sync bug into an infinite poll loop

## PM planning failures

PM planning sits at the boundary between AI and deterministic validation.

### What should count as failure

- Codex returns no structured output
- Codex output cannot be parsed
- Codex output violates required schema
- returned task specs reference unknown implementation agents
- task IDs are invalid or duplicated
- allowed paths are outside the target lane scope
- acceptance criteria are missing when the planner contract requires them
- failure persisting the planned PRD spec back to the integration branch
- failure creating runtime tasks after planning

Why these are failures:

- the planner result is not actionable or cannot be safely committed into the state machine

### What should not count as failure

- the plan is smaller than expected
- the plan has only one task
- the plan is conservative
- the plan reuses an already-satisfied idea as long as it is structurally valid

Those are quality questions, not orchestrator failures.

## Implementation execution failures

Implementation is where the repo currently mixes AI outcomes with orchestration outcomes most aggressively.

### Real failures

- cannot lease the task safely
- cannot prepare the worktree or branch
- runner command cannot be launched
- deterministic required checks fail when the policy says they are blocking
- git add/commit/push fails when those steps are required for the chosen transition
- task finish / PR record mutation fails after work has been produced
- scope evaluator finds a hard scope breach and the policy treats it as blocking

These are orchestration or policy failures because the deterministic wrapper cannot safely complete the task lifecycle.

### Ambiguous cases that should usually not be hard failures

- zero changed files
- no commit created
- Codex reports that the requirement is already satisfied
- Codex produces documentation or reasoning but no repo diff
- a task is effectively a validation task and the correct result is "nothing to do"

These should usually map to a non-error outcome like:

- `noop`
- `already_satisfied`
- `verified_no_change`
- `completed_without_diff`

The orchestrator can still record the result and close or defer the task, but it should not crash merely because no commit was made.

### Why this matters

A requirement such as "confirm this path already behaves correctly" may be fully satisfied by inspection. Forcing every successful task to produce a commit confuses "evidence of work" with "successful completion."

## Review failures

Review has the same distinction between AI judgment and deterministic wrapper failure.

### Real failures

- cannot prepare review context
- cannot compute diff against the base branch
- cannot run required blocking checks
- cannot record the review state
- cannot perform a required merge operation after approval
- cannot create the required follow-up task after changes requested

### Not inherently failures

- review decides approve
- review decides changes requested
- review summary is brief
- review has no concerns

Those are normal outcomes, not orchestrator errors.

## Git and GitHub failures

These are real when the current transition requires them.

Examples:

- remote branch cannot be fetched
- commit cannot be created
- push rejected
- PR publish fails
- review publish fails
- merge API rejects the merge
- GitHub remote URL cannot be parsed

Expected handling:

- classify by operation
- record the failure on the affected task/PR
- avoid losing local execution evidence
- avoid re-running the same step forever without new inputs

## Worker lifecycle failures

Worker-process failures are orchestration failures because they break the deterministic wrapper, not because the AI was wrong.

Examples:

- worker exits before reporting result
- detached runner crashes
- worker dies after lease but before task transition
- runtime state says worker is running but OS says it is gone

Expected handling:

- recover the runtime entry
- preserve error context
- avoid re-dispatching blindly if the failure is permanent

The key point is that a dead worker and a successful no-op task are completely different categories and should not be handled the same way.

## CLI input failures

These are normal command-level failures, not scheduler design failures.

Examples:

- unknown command
- missing required option
- invalid JSON payload for `--task-spec`
- invalid review decision flag

Expected handling:

- fail that invocation
- show a precise message
- do not treat it as a worker or AI failure

## Suggested classification model

The orchestrator should classify outcomes before deciding whether to throw.

Suggested outcome buckets:

- `success`
  Deterministic transition completed.
- `success_noop`
  Deterministic transition completed and no change was necessary.
- `blocked`
  Work cannot proceed until a dependency or prerequisite changes.
- `invalid_input`
  Operator or config input is malformed.
- `infrastructure_error`
  Git, GitHub, filesystem, process, or environment boundary failed.
- `state_error`
  Runtime state is inconsistent or missing required entities.
- `policy_rejection`
  Deterministic policy rejected the result, for example blocking checks or scope violations.

This is more useful than a single "throw on anything unexpected" model.

## Specific places that deserve policy review

Based on the current code shape, these are the main areas where the repo should decide "is this really a failure or just a different valid outcome?"

### 1. No-diff implementation results

Current reasoning risk:

- the system can treat "no file changes" as a task failure

Why that is weak:

- some requirements are already satisfied
- some tasks are validation-only
- some tasks may only need state recording, not code mutation

Better policy:

- classify as `success_noop` when the requirement is already satisfied and no deterministic policy demands a diff

### 2. PM output quality vs PM validity

Current reasoning risk:

- poor decomposition may be treated the same as invalid decomposition

Better policy:

- fail only on structural invalidity, not on quality disagreement

### 3. Review judgment vs review wrapper failure

Current reasoning risk:

- a review outcome may be conflated with a review execution failure

Better policy:

- `approve` and `changes_requested` are business outcomes
- inability to compute diff or record review is the actual failure

### 4. Retry behavior after deterministic failures

Current reasoning risk:

- permanent infrastructure or state failures can be retried as if they were transient

Better policy:

- retries should be explicit and policy-based
- some failures should halt the task or server until operator intervention

## Practical decision rule

A useful question for every `throw new Error()` site is:

"Does this mean the orchestrator cannot safely continue, or does it only mean the AI produced an unexpected but still acceptable outcome?"

If the answer is the second one, it should usually become:

- a classified result
- a task status update
- a log entry
- or a `noop` transition

not a hard orchestration failure.

## Summary

The real failure boundary in this repo should be:

- deterministic orchestration contract breaches
- deterministic policy violations
- corrupted or missing state
- infrastructure unavailability

It should not be:

- "the model returned something we did not prefer"
- "the model decided no code change was needed"
- "the model completed the reasoning but there was no diff"

That distinction is the difference between an AI-assisted orchestrator and a fragile workflow that assumes every successful task must end in a commit.
