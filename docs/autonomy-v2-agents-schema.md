# Autonomy V2 Agent Configuration Schema (`prompts/autonomous/v2/config/agents.json`)

This document defines how the top-level agent configuration JSON should be structured for `autonomy-v2`.

The current implementation is intentionally permissive for custom fields, but the keys below are the ones that are validated and consumed by the runtime.

## 1) Top-level shape

`agents.json` must be a JSON object:

```json
{
  "schemaVersion": 1,
  "integrationBranch": "dev",
  "productionBranch": "main",
  "blockedBranches": ["main", "master"],
  "branchPrefixes": {
    "task": "agent",
    "resolve": "resolve"
  },
  "mergeActors": ["reviewer"],
  "worktreesRoot": ".autonomy/worktrees",
  "mergeStrategy": "merge",
  "agents": [ ... ]
}
```

## 2) Top-level fields (validated + consumed)

| Field | Type | Required | Validation | Runtime meaning |
|---|---|---:|---|---|
| `schemaVersion` | number | No | Positive integer when present | Informational only; no strict migration logic tied today |
| `integrationBranch` | string | No | Non-empty string if present | Target branch for generated worktree branches and PR base |
| `productionBranch` | string | No | Non-empty string if present | Hard guard used by PM runner instructions (do not target production branch for normal automation) |
| `blockedBranches` | string[] | No | Optional array; no strict per-item validation | Branches disallowed for merge (enforced in merge checks) |
| `branchPrefixes` | object | No | Optional object | Controls branch naming prefixes |
| `branchPrefixes.task` | string | No | Must be present to use if object is present | Prefix for implementation branch names |
| `branchPrefixes.resolve` | string | No | No strict validation | Present for compatibility |
| `mergeActors` | string[] | No | Each entry must match an existing agent `id` | Restricts which agents can perform merge operations |
| `worktreesRoot` | string | No | Non-empty path string when present | Root directory for spawned worktrees |
| `mergeStrategy` | string | No | Not strictly validated | Passed to merge logic; effective values in practice are `merge` and `squash` |
| `agents` | array | Yes | Required and must be non-empty array | Ordered agent roster |

### Notes on unknown fields
Any other top-level fields are tolerated by `config` loader and may be used by custom tooling. The package does not reject unknown keys.

## 3) Agent object shape (`agents[]`)

Each agent must be an object with the fields below.

```json
{
  "id": "aquarium-agent",
  "personaName": "aquarium-agent",
  "role": "implementation",
  "systemPrompt": "prompts/autonomous/v2/agents/aquarium-agent/system.md",
  "runnerCommand": ["node", "scripts/autonomy-v2-default-runner.js"],
  "taskQueue": "prompts/autonomous/v2/state/queues/aquarium-agent.json",
  "gitIdentity": {
    "name": "automation-bot[bot]",
    "email": "automation-bot[bot]@users.noreply.github.com"
  },
  "checks": ["npm run typecheck"],
  "include": ["src/barebones-starter/games/apps/aquarium/**"],
  "exclude": ["**/*.generated/**"],
  "prLabels": ["agent:aquarium"],
  "commentSignature": "aquarium-agent"
}
```

| Field | Type | Required | Validation / behavior |
|---|---|---:|---|
| `id` | string | Yes | Required, non-empty, globally unique |
| `role` | string | Yes | Must be one of: `pm`, `implementation`, `review` |
| `systemPrompt` | string | Yes | Path (relative recommended) to prompt markdown used by Codex planning/review prompts |
| `gitIdentity` | object | Yes | Must include non-empty `name` and `email` |
| `runnerCommand` | string[] | Required for `implementation` and `review` | Array of command tokens, non-empty |
| `taskQueue` | string | No | Path to that agent queue file |
| `personaName` | string | No | Human-readable label, forwarded to PM planning context |
| `include` | string[] | No | Scope allowlist for this agent (globs). Used for PM validation + scope checks |
| `exclude` | string[] | No | Scope blocklist for this agent (globs). Used by scope checks |
| `checks` | string[] | Yes for implementation agents by runtime convention | Must be non-empty for implementation agents at runtime. These are merged with task-level checks before execution |
| `prLabels` | string[] | No | Optional metadata carried into PR records |
| `commentSignature` | string | No | Optional metadata used by reviewer workflow conventions |

### Additional notes on validation
- `id` must be unique across all agents.
- `runnerCommand` is not required for `pm` roles.
- `taskQueue` paths may point into repo paths or runtime-managed queue paths.
- Unknown keys on agent objects are currently preserved and passed through as-is.

## 4) Scope/behavior contract by role

- `pm`:
  - Decomposes PRDs into tasks.
  - Uses `systemPrompt`, `gitIdentity`, optional `taskQueue`.
  - `runnerCommand` is ignored for `pm`.
- `implementation`:
  - Uses `runnerCommand` to run work for queue tasks.
  - Must have non-empty `checks` at runtime.
  - `include` and `exclude` are used for scope enforcement.
- `review`:
  - Uses `runnerCommand` to evaluate review tasks and optionally merge.
  - Uses `systemPrompt`, `gitIdentity`, and `runnerCommand`.
  - `checks` are not required by validator.

## 5) Paths and defaults used during bootstrap

During `autonomy-v2 init`, generated defaults are written for:
- `prompts/autonomous/v2/config/agents.json`
- `prompts/autonomous/v2/config/sprint.json`
- Default queue files under `prompts|.autonomy runtime state` according to each agent’s `taskQueue`

## 6) Minimal valid config examples

### PM-only valid fragment
```json
{
  "schemaVersion": 1,
  "agents": [
    {
      "id": "pm-agent",
      "role": "pm",
      "systemPrompt": "prompts/autonomous/v2/agents/pm-agent/system.md",
      "gitIdentity": {
        "name": "pm-bot[bot]",
        "email": "pm-bot[bot]@users.noreply.github.com"
      }
    }
  ]
}
```

### PM + implementation + review valid fragment
```json
{
  "schemaVersion": 1,
  "integrationBranch": "dev",
  "productionBranch": "main",
  "worktreesRoot": ".autonomy/worktrees",
  "mergeActors": ["reviewer"],
  "agents": [
    {
      "id": "pm-agent",
      "role": "pm",
      "systemPrompt": "prompts/autonomous/v2/agents/pm-agent/system.md",
      "gitIdentity": {
        "name": "pm-bot[bot]",
        "email": "pm-bot[bot]@users.noreply.github.com"
      }
    },
    {
      "id": "aquarium-agent",
      "role": "implementation",
      "systemPrompt": "prompts/autonomous/v2/agents/aquarium-agent/system.md",
      "runnerCommand": ["node", "scripts/autonomy-v2-default-runner.js"],
      "taskQueue": "prompts/autonomous/v2/state/queues/aquarium-agent.json",
      "gitIdentity": {
        "name": "aquarium-bot[bot]",
        "email": "aquarium-bot[bot]@users.noreply.github.com"
      },
      "include": ["src/barebones-starter/games/apps/aquarium/**"],
      "checks": ["npm run typecheck"]
    },
    {
      "id": "reviewer",
      "role": "review",
      "systemPrompt": "prompts/autonomous/v2/agents/reviewer/system.md",
      "runnerCommand": ["node", "scripts/autonomy-v2-default-runner.js"],
      "taskQueue": "prompts/autonomous/v2/state/queues/reviewer.json",
      "gitIdentity": {
        "name": "reviewer-bot[bot]",
        "email": "reviewer-bot[bot]@users.noreply.github.com"
      },
      "commentSignature": "reviewer-agent"
    }
  ]
}
```

## 7) Invalid patterns to avoid
- Duplicate `id` entries inside `agents`.
- Unsupported `role` value.
- Missing `id`, `role`, `systemPrompt`, or `gitIdentity.name`/`gitIdentity.email`.
- Non-`implementation`/`review` agents with `runnerCommand` missing (PM does not require it; non-PM does).
- `mergeActors` entries that do not match a configured `id`.
- Implementation agents with missing/empty `checks` (accepted in config validation but enforced by runtime checks).
- `schemaVersion` not a positive integer when provided.

## 8) Related implementation
- Config loading/validation: [src/autonomy-v2-config.js](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2-config.js)
- Orchestration and role dispatch: [src/autonomy-v2-orchestrator.js](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2-orchestrator.js)
- Runner behavior: [src/autonomy-v2-default-runner.js](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2-default-runner.js)
- Planner / Codex constraints: [src/autonomy-v2-codex.js](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2-codex.js)
