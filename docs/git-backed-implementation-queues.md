# Git-backed Implementation Queues

Implementation orchestration now uses tracked per-agent queue files in git.

The important files are:

- `prompts/autonomous/v2/queues/<agent-id>.json`
- `prompts/autonomous/v2/specs/prds/<prd-id>.json`
- `prompts/autonomous/v2/specs/prds/queue/<prd-id>.json`

## Source of truth

For implementation agents, the queue file on `dev` is the enqueue source of truth.

That means:

- PM planning writes implementation task entries into tracked queue files
- manual implementation task insertion also writes tracked queue files
- runtime `.autonomy` queue files are not authoritative for implementation work

For an active implementation branch, the branch-local copy of the same queue file becomes the in-progress execution view for that lane.

## Queue contract

Implementation queue files use this shape:

```json
{
  "schemaVersion": 1,
  "agentId": "architecture-agent",
  "role": "implementation",
  "tasks": [
    {
      "id": "prd-123-architecture-agent-1",
      "title": "Implement example",
      "prdId": "prd-123",
      "laneKey": "prd-123:architecture-agent",
      "description": "…",
      "allowedPaths": ["src/**"],
      "acceptance": ["…"],
      "source": "planned",
      "state": "queued",
      "branch": null,
      "startedAt": null,
      "completedAt": null,
      "commitSha": null,
      "completionMode": null
    }
  ]
}
```

States are:

- `queued`
- `active`
- `done`

Completion modes are:

- `code`
- `noop`

## Dispatch model

When the scheduler chooses implementation work:

1. it reads the tracked queue on `dev`
2. it marks the chosen task `active` on `dev`
3. it creates or reuses the deterministic lane branch/worktree
4. it runs the implementation runner in that worktree

Once the branch exists, queue advancement happens on the branch-local queue file.

Status resolution prefers:

1. branch queue if the lane is active
2. `dev` queue if no active branch queue exists

## Implementation runner contract

Implementation execution is diff-driven, not structured-output-driven.

The coding agent is treated as a side-effect producer:

- it may edit files
- it may decide no edits are needed
- it does not need to return schema-valid structured JSON for implementation

The deterministic wrapper decides outcome from:

- process exit
- changed files
- scope validation
- configured checks
- git commit/push results

Outcomes:

- diff + valid checks/scope -> `done` with `completionMode=code`
- no diff + successful deterministic run -> `done` with `completionMode=noop`

## Commit metadata

The queue records the work commit SHA in `commitSha`.

Because a git commit cannot contain its own final SHA inside the committed file contents, implementation completion currently uses:

1. a work commit that captures the code change or noop completion state
2. a queue-metadata commit that records that work commit SHA into the tracked queue file

This means branch commit count is not the authoritative progress signal for implementation lanes. Queue state is.

## Review follow-up

If review requests changes:

- the follow-up task is appended to the tracked implementation queue for that lane
- if the implementation branch is still active, the branch-local queue is updated directly

No runtime-only implementation follow-up queue is authoritative.
