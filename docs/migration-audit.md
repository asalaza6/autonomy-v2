# Generic runtime migration audit

Verified September 17, 2026.

## Ownership

| Location | Responsibility |
| --- | --- |
| `src/server/` | Custom-agent scheduling, lifecycle execution, process management, logs |
| `src/frontend/` | Config/module loading, runtime injection, operations, page reloads |
| `src/runtime/` | Shared repository IO, process execution, action contracts |
| `src/lock/`, `src/codex/`, `src/env/` | Locks, model execution, environment loading |
| `src/autonomy-v2/` | Generic initialization, agent/server commands, named action dispatch |
| `presets/` | PM, architecture, reviewer definitions and lifecycle policy |
| `control-presets/` | React pages, PRD policy, deployment, chat, optional maintenance |
| Consumer repository | Optional replacement agent, page, action and options files |

Core contains no role roster, PRD commands, implementation/review queues,
reconciliation, deployment policy, or GitHub workflow services. The copied
control-preset legacy engine and duplicate lock/IO helpers are removed.
The filename uniqueness checker was removed because preset contracts deliberately
reuse filenames. Obsolete workflow scaffolds, templates and tests were deleted.

Preset actions receive the same generic runtime as repository actions. The
public runtime can be imported; workflow-specific capabilities are not added
to core. PRD reads and writes use the integration branch even when the checkout
is elsewhere. Agent preset lifecycle scripts retain their existing behavior.

## Verification

- Autonomy: **115 tests pass**, on Node 25 and Node 20. Build, lint and Knip pass.
- Fluxborne game lifecycle: **68 tests pass**.
- Fluxborne game-agent: **105 tests pass** using its required Node 20 runtime.
- Consumer process tests require OS process inspection; sandbox failures were
  rerun with that access. Fixtures exercise deployment behavior without live publication.
- Both consumer configs select the shared control preset. The current runtime
  resolves their existing game-agent IDs, enabled state, and React page.
- Real Git fixtures cover PRD queueing, priority, reset, archival, another checked
  out branch, fast-forward deployment and repository deployment hooks.
- React tests cover rendering, navigation, forms, agent toggles, history and
  subscription disposal. Core tests cover preset overrides, repository-only
  controls, worker runtime access, options reload, and no implicit actions.
- Extracted npm package loads all three control pages and three agent definitions
  without the source tree. A separate strict TypeScript consumer compiles against
  the packed public declarations.

Repository lifecycle tests and read-only consumer loading establish compatibility
without running live model work. React mounting remains a host responsibility;
this migration supplies components and their runtime contract.
