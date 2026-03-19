# Aquarium Deep Systems Sprint

This PRD is intentionally lane-pure. PM should decompose it into a large aquarium-only sprint for `aquarium-agent`.

## Product Goal

Turn aquarium from a compact prototype into a deeper management loop with visible mid-run progression, more expressive fish behavior, stronger threat escalation, and clearer player-facing goals.

The player experience should move from:

- feed fish
- collect coins
- react to pests

to a richer loop with:

- short-term tank maintenance decisions
- medium-term roster and upgrade planning
- escalating danger waves
- clearer win / loss pressure and session milestones

## Sprint Shape

PM should plan a large sprint, not a smoke test.

Expected shape:

- 10 to 14 implementation tasks
- all tasks assigned to `aquarium-agent`
- one shared aquarium lane branch
- one aquarium PR with many commits
- no cross-lane work

Each task should be small enough for one commit, but together they should add up to a meaningful feature sprint.

## Scope Boundaries

Stay inside:

- `src/barebones-starter/games/apps/aquarium/**`

Primary files and folders likely to matter:

- `config.ts`
- `world.ts`
- `step.ts`
- `draw.ts`
- `constants.ts`
- `types.ts`
- `actors/**`
- `logic/**`
- `sprites.ts`
- aquarium-local docs or sprint notes if needed

## Deliverable Themes

PM should cover most of these themes in the task plan.

### 1. Run Progression and Goals

- add clearer stage goals or milestone targets
- make success / failure pressure legible over a longer session
- introduce mid-run pacing beats so the tank evolves over time

### 2. Fish Roster Depth

- create more distinct fish archetypes and upgrade paths
- strengthen fish personality differences in movement, appetite, output, or upkeep
- make the roster feel intentionally tiered rather than flat

### 3. Economy and Upgrade Loop

- deepen coin generation and spending choices
- make upgrades feel synergistic rather than isolated
- improve recovery options after weak play without removing risk

### 4. Threat Director

- improve pest escalation and wave logic
- introduce at least one more dramatic threat beat such as miniboss pressure, special pest types, or timed danger windows
- make defensive tools and their tradeoffs clearer

### 5. Presentation and Readability

- improve HUD clarity
- make important state changes visible in moment-to-moment play
- improve animation / visual feedback / sprite usage where practical

### 6. Session Wrap-Up

- improve end-of-run clarity, summaries, or milestone messaging
- leave the player with a sense of what advanced during the session

## Planning Rules For PM

- Do not emit tasks for other agents.
- Do not emit reviewer tasks.
- Prefer tasks that change real gameplay or presentation systems over placeholder markdown notes.
- Prefer modifying existing aquarium systems over adding throwaway scaffolding.
- Spread the plan across multiple aquarium subsystems so the sprint naturally creates many commits.
- Include tests only where the repo already supports them naturally for the touched area.

## Definition Of Done

- Aquarium has a visibly deeper progression loop.
- The tank feels more alive, more pressured, and more readable than the current baseline.
- The sprint touches multiple aquarium subsystems, not just tuning constants.
- The resulting PR should plausibly contain many commits because the work decomposes into many real tasks.

## Explicit Non-Goals

- no changes outside aquarium scope
- no generic placeholder files just to inflate task count
- no PM-generated reviewer work

