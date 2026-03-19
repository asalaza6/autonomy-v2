# Adventure World Expansion Sprint

This PRD is intentionally lane-pure. PM should decompose it into a large adventure-only sprint for `adventure-agent`.

## Product Goal

Turn adventure into a broader exploration-and-encounter experience with more interesting traversal beats, stronger creature / combat variety, clearer objective structure, and a better sense of world progression.

The player experience should move from a basic roam-and-fight loop toward:

- clearer goals
- richer encounters
- more meaningful capture / progression choices
- stronger world identity across a longer run

## Sprint Shape

Expected shape:

- 10 to 14 implementation tasks
- all tasks assigned to `adventure-agent`
- one shared adventure lane branch
- one adventure PR with many commits
- no cross-lane work

Each task should still be atomic enough for one commit.

## Scope Boundaries

Stay inside:

- `src/barebones-starter/games/apps/adventure/**`

Primary areas likely to matter:

- `config.ts`
- `world.ts`
- `step.ts`
- `draw.ts`
- `constants.ts`
- `types.ts`
- `state.ts`
- `actors/**`
- `logic/**` if introduced or already present

## Deliverable Themes

PM should cover most of these themes.

### 1. World Structure and Objective Flow

- introduce clearer objectives, checkpoints, contracts, or run goals
- improve pacing from early exploration to more dangerous encounters
- make world progression easier to understand moment to moment

### 2. Encounter and Combat Depth

- expand enemy or creature archetype diversity
- improve encounter composition and pressure scaling
- create more distinct combat decisions beyond simple repetition

### 3. Capture / Companion / Progression Layer

- deepen creature capture, recruitment, or progression systems
- make collected or captured creatures matter more to the player’s long-term choices
- improve clarity around why certain creatures are valuable

### 4. Traversal and Biome Identity

- strengthen zone variation or environmental identity
- improve transitions between safer and riskier spaces
- make the map feel more deliberate than a flat play space

### 5. UI and Run Feedback

- improve run-state readability
- make player status, encounter context, and progress messaging clearer
- add better feedback for major progression events

### 6. End-of-Run / Mid-Run Summary Signals

- give the player better closure or reflection on what changed during the run
- improve milestone, unlock, or objective messaging

## Planning Rules For PM

- Do not emit tasks for other agents.
- Do not emit reviewer tasks.
- Prefer real gameplay, world, combat, and progression work over placeholder notes.
- Prefer building on existing adventure structures over creating detached scaffolding.
- Make the task list broad enough that the resulting PR becomes a real multi-commit sprint.
- Include tests only where they fit naturally into existing patterns.

## Definition Of Done

- Adventure feels materially larger and more directed.
- The sprint deepens exploration, encounters, and progression together.
- The work spans multiple adventure subsystems.
- The final lane PR should plausibly contain many commits because the task plan is large and real.

## Explicit Non-Goals

- no changes outside adventure scope
- no filler tasks created only to inflate commit count
- no PM-generated reviewer work

