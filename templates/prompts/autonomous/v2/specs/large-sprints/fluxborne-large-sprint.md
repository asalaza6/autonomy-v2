# Fluxborne Act Expansion Sprint

This PRD is intentionally lane-pure. PM should decompose it into a large Fluxborne-only sprint for `action-agent`.

## Product Goal

Push Fluxborne forward as the largest action project in the repo with a more substantial act-scale loop: stronger combat progression, clearer contract / mission structure, richer home base payoff, and better continuity between combat runs and long-term advancement.

The player experience should move toward:

- more meaningful combat build decisions
- clearer mission or contract goals
- stronger home base utility
- better continuity across acts, waves, maps, and upgrades

## Sprint Shape

Expected shape:

- 12 to 18 implementation tasks
- all tasks assigned to `action-agent`
- one shared action lane branch
- one Fluxborne PR with many commits
- no cross-lane work

This is intentionally the largest of the three PRDs.

## Scope Boundaries

Stay inside:

- `src/barebones-starter/games/apps/fluxborne/**`

Primary areas likely to matter:

- `config.ts`
- `components/**`
- `game/combat/**`
- `game/player/**`
- `game/map/**`
- `game/progression/**`
- `game/homeBase/**`
- `game/workshop/**`
- `game/story/**`
- `game/endless/**`
- `game/npc/**`
- `types.ts`

## Deliverable Themes

PM should spread the task plan across most of these areas.

### 1. Combat and Build Depth

- deepen player build choices, weapon identity, or combat role specialization
- strengthen the connection between moment-to-moment combat and longer-term loadout strategy
- improve combat readability where complexity increases

### 2. Contract / Mission Structure

- strengthen the player’s sense of run objectives
- add or improve mission board, contract cadence, or reward loops
- make run goals more deliberate than pure survival drift

### 3. Map and Progression Continuity

- improve transitions between zones, acts, or wave phases
- make exploration, unlocks, and progression systems feel connected
- reinforce the sense of advancing through a larger campaign loop

### 4. Home Base and Service Value

- make home base rooms and services more strategically meaningful
- improve the payoff of returning from a run
- connect services to combat progression, loadouts, or contracts

### 5. NPC / Story / World Feedback

- improve story-state visibility, NPC utility, or relationship affordances
- make progression beats feel acknowledged in the world
- strengthen player understanding of what changed after key milestones

### 6. Presentation and Interface Readability

- improve clarity in heavy-system screens such as contracts, maps, inventory, stats, or home base views
- reduce confusion around progression and player choice

## Planning Rules For PM

- Do not emit tasks for other agents.
- Do not emit reviewer tasks.
- Prefer substantial system work over documentation-only or note-only tasks.
- Use existing Fluxborne systems and directories as the basis for decomposition.
- Make the task list large enough that the resulting PR legitimately contains many commits.
- Include tests where the touched Fluxborne subsystem already has useful test coverage patterns.

## Definition Of Done

- Fluxborne gains a noticeably larger act-scale loop.
- Combat, contracts, map progression, and home base all feel more connected.
- The sprint spans multiple major Fluxborne subsystems rather than one isolated feature slice.
- The final lane PR should plausibly contain many commits because the PM decomposition is intentionally large.

## Explicit Non-Goals

- no changes outside Fluxborne scope
- no filler tasks created only to drive up commit count
- no PM-generated reviewer work

