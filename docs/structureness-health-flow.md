# Structureness Health Flow

One-line prompt: Follow `docs/structureness-health-flow.md`, measure the current structure health, explain the main score drag, and make real structural refactors until the threshold passes or you hit a real architectural blocker.

This document is the practical runbook for raising the export-graph health score with `analyze-exports.mjs`.

It is based on an actual repair pass in this repo, not just on the analyzer implementation.

## Source of truth

Always start from the analyzer, not from assumptions:

```bash
node analyze-exports.mjs --format health --health-output json --threshold 80
```

Minimal prompt form:

```text
Run `node analyze-exports.mjs --format health --threshold 80`, use `docs/structureness-health-flow.md` to interpret the score and score drag, then make targeted structural refactors and rerun until the score passes or you hit a real architectural constraint.
```

For this repo, the JSON output is the most useful format because it gives the exact fields needed for a refactor loop:

- `score`
- `metrics`
- `topOffenders`
- `topSccs`
- `topDirectories`

During one real pass in this repo, the baseline was:

- `score.value = 69.51`
- `score.passed = false`
- `metrics.layerFlow.wrongWayEdges = 0`
- `metrics.layerFlow.skipRatio = 0.637`
- `metrics.cycleBurden.filesInCycles = 18`
- `metrics.cycleBurden.largestSccSize = 11`

After one targeted refactor pass, the score moved to:

- `score.value = 70.53`
- `metrics.layerFlow.skipRatio = 0.6211`
- `metrics.layerFlow.skipEdges = 177` from `186`
- `metrics.layerFlow.skipSeverityTotal = 564` from `623`
- `metrics.hubPressure.bridgeSuspectCount = 29` from `33`
- `metrics.layerFlow.wrongWayEdges = 0` unchanged

The improvement was real but incremental. That is normal for this analyzer. Large gains usually come from removing repeated skip patterns or collapsing SCCs, not from cosmetic file movement.

## What the score rewards

The weighted score is built from:

- `layerFlow` at `0.3`
- `cycleBurden` at `0.25`
- `depthBalance` at `0.15`
- `rootClarity` at `0.1`
- `hubPressure` at `0.1`
- `directoryCoherence` at `0.1`

In practice, the fastest ways to move the score are:

- reduce `wrongWayEdges`
- reduce `skipRatio`
- reduce `filesInCycles`
- reduce `largestSccSize`
- reduce bridge-like modules that connect many directories across many depth bands
- reduce directory spread where one directory spans multiple depth bands

The analyzer is especially sensitive to:

- wrong-way imports that climb to shallower layers
- imports that skip one or more depth bands
- files that sit inside SCCs
- bridge suspects with high total degree and wide cross-directory reach

## The loop

Use this sequence every time:

1. Run the health command.
2. Inspect `score`, `metrics`, `topOffenders`, `topSccs`, and `topDirectories`.
3. Pick one structural problem with repeat impact.
4. Refactor.
5. Re-run the same command.
6. Compare the new output against the previous one.

Do not optimize blind. The analyzer is already telling you where the graph is expensive.

## How to choose the next refactor

Use this order.

1. `wrongWayEdges`
2. Large SCCs
3. Repeated skip-heavy bridge modules
4. Same-level tangles
5. Directory smearing

If `wrongWayEdges > 0`, fix those first. They are heavily penalized and usually indicate a real architectural regression.

If `wrongWayEdges = 0`, the next highest leverage target is usually one of:

- a large SCC in `topSccs`
- a bridge module in `topOffenders`
- a directory with high `depthSpread` in `topDirectories`

## Patterns that worked in this repo

### 1. Hoist deep dependencies behind local hubs

The first useful pass in this repo was not breaking the biggest SCC directly. It was reducing repeated deep imports from command and runner entrypoints.

That pass introduced:

- [command-dependencies.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/commands/command-dependencies.ts)
- [runner-dependencies.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/runner-dependencies.ts)

Then these files were updated to depend on those local hubs instead of directly importing deep modules:

- [pr.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/commands/pr.ts)
- [gate.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/commands/gate.ts)
- [merge.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/commands/merge.ts)
- [prd.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/commands/prd.ts)
- [task-flow.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/task-flow.ts)
- [gate-flow.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/gate-flow.ts)

Why this helped:

- it removed repeated layer-skipping imports from high-churn orchestration files
- it cut bridge pressure in the command and runner surfaces
- it improved score without introducing wrong-way imports

### 2. Expect hotspot migration

A hub can improve the overall graph while becoming a new local offender itself.

That happened here:

- the command and runner flow files became less expensive
- [runner-dependencies.ts](/Users/bytedance/Documents/GitHub/autonomy-v2/src/autonomy-v2/runner/runner-dependencies.ts) showed up as a new bridge suspect

This is not necessarily bad. It means the graph is becoming more explicit. The next step is to decide whether that hub represents a valid boundary or whether it should be split further.

### 3. Entry-point cleanup is useful but not sufficient

This repo still has a large SCC containing:

- `src/agents/*`
- `src/config/index.ts`
- `src/github/index.ts`
- `src/sync/git.ts`
- `src/sync/prd.ts`
- `src/autonomy-v2/commands/command-dependencies.ts`

That means entrypoint cleanup alone will not get the score to `80`. To make a bigger move, the SCC itself needs to shrink.

## Refactor patterns that usually help

Prefer these changes:

- extract low-level shared helpers into a lower layer with fewer imports
- split files that both coordinate flow and own domain logic
- replace repeated deep imports with a local boundary module when the boundary is real
- break SCCs by pulling pure types/helpers/constants into modules with no back-edge
- move GitHub or sync concerns out of orchestration files when they are only used for one operation
- separate read-only graph inspection helpers from write/mutation helpers

Avoid these changes:

- moving files without reducing dependency depth
- adding re-export barrels that create new cycles
- flattening everything into a giant utility module
- increasing `wrongWayEdges` to reduce skips
- hiding complexity in a bridge module that now imports half the repo

## How to read the report

Use `topOffenders` to find individual files that are skip-heavy, cyclic, or bridge-like.

Use `topSccs` to find structural knots. If the same subsystem keeps appearing there, that is often the real architectural constraint.

Use `topDirectories` to find smeared directories. If one directory spans many depth bands, it likely mixes orchestration, state access, and domain logic.

Use `score.components` to see which category is holding the total score down. In this repo, `layerFlow`, `cycleBurden`, and `hubPressure` were the main drag.

## Plain-English glossary

`layer-skipping imports`

A file depends on another file several layers away instead of a nearby layer. In general, this means modules are reaching too far across the architecture.

`files in cycles`

Files are part of circular dependencies where one module eventually depends back on itself through other modules. In general, this means those files are tangled and harder to separate safely.

`bridge-module behavior`

A module connects many parts of the system that would otherwise be more separate. In general, this means the file is acting like a traffic hub or glue layer.

`largest SCC size`

The size of the biggest circular dependency cluster. In general, this means how large the single worst dependency knot is.

`high max module degree`

One file has a very large number of dependency connections. In general, this means too much architectural traffic is concentrated in one place.

`directory smearing`

Files in the same directory live across very different architecture levels. In general, this means the directory mixes responsibilities instead of representing one coherent layer.

`too many roots for the scope size`

There are many top-level starting points relative to the size of the codebase. In general, this means the system may be fragmented or have too many independent entry surfaces.

`same-level imports`

Files at the same layer depend on each other a lot. In general, this means peer modules are coupled instead of being cleanly separated.

`average directory depth spread`

On average, directories cover multiple architecture levels. In general, this means directories are not tightly aligned to a single abstraction level.

## Guardrails

Do not regress `metrics.layerFlow.wrongWayEdges` just to reduce skip edges.

Do not treat the score as the architecture. A refactor only counts if the code boundary becomes clearer.

Do not skip tests. But also distinguish between:

- a regression introduced by the refactor
- pre-existing build or test failures in the repo

During the run that informed this document, `npm test` and `npm run build` were already blocked by broad TypeScript issues outside the health-score refactor itself. That meant the structural pass could be measured, but full green validation was not available from repo baseline.

## Recommended workflow for this repo

Run this exact command first:

```bash
node analyze-exports.mjs --format health --health-output json --threshold 80
```

Then make one targeted change set at a time and compare:

- previous `score.value`
- new `score.value`
- changed metrics
- changed `topOffenders`
- changed `topSccs`
- test/build status

For this repo specifically, the highest-leverage remaining work is likely:

1. break the `agents/config/github/sync` SCC
2. split `src/sync/syncer.ts`, which remains the top offender
3. reduce cross-band spread inside `src/autonomy-v2/commands` and `src/sync`

If those do not move the score enough, the issue is probably a real architecture boundary problem rather than a missing cosmetic cleanup.
