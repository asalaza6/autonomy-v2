# Three Project Platform Expansion Sprint

This PRD is intentionally multi-lane. PM should decompose it into three large implementation lanes:

- `aquarium-agent`
- `adventure-agent`
- `action-agent`

Each lane should receive a real large-scope feature plan, and the final outcome should be three substantial lane PRs rather than one mixed branch.

## Product Goal

Deliver a meaningful feature expansion for each of the three projects in the repo while raising the engineering bar on shared thinking:

- Aquarium should gain deeper simulation and progression depth.
- Adventure should gain broader exploration, encounter, and progression depth.
- Fluxborne should gain larger-scale combat, mission, and home-base depth.

This sprint is not only about adding more features. It is also intended to pressure-test code reuse, boundary discipline, and project separation.

The expected outcome is:

- three ambitious project-specific feature expansions
- strong lane separation
- visible effort to reuse existing logic where appropriate
- clear avoidance of unnecessary duplicate systems

## Sprint Shape

PM should plan a large sprint, not a smoke test.

Expected shape:

- 30 to 42 implementation tasks total
- 8 to 14 tasks for `aquarium-agent`
- 8 to 14 tasks for `adventure-agent`
- 10 to 16 tasks for `action-agent`
- one shared branch per implementation lane
- one PR per lane
- many commits per lane PR
- no PM-generated reviewer tasks

Each task should still be atomic enough for one commit.

## Scope Boundaries

Stay inside the existing lane boundaries:

- `aquarium-agent` -> `src/barebones-starter/games/apps/aquarium/**`
- `adventure-agent` -> `src/barebones-starter/games/apps/adventure/**`
- `action-agent` -> `src/barebones-starter/games/apps/fluxborne/**`

PM must not generate tasks that mix code across those project directories in the same implementation task.

## Cross-Project Engineering Intent

This sprint should deliberately reward disciplined engineering choices.

PM should bias task planning toward:

- reusing existing lane-local systems before inventing parallel abstractions
- extending existing gameplay, UI, progression, and state logic before adding redundant replacements
- identifying patterns that are similar across projects and making sure each lane solves them in the least wasteful way available inside its scope

PM should explicitly avoid:

- duplicate helpers created just because an agent touched a nearby file
- new systems that overlap heavily with existing repo logic without justification
- cross-project leakage where one project starts importing or depending on another project's implementation details

## Reviewer Guidance

Reviewer guidance is part of this PRD and should be preserved in downstream planning context.

The reviewer should be intentionally stingy on separation and reuse.

The reviewer should treat the following as high-priority review criteria:

### 1. Separation Discipline

- block changes that blur project boundaries without a strong reason
- block lane work that introduces messy coupling or confused ownership
- prefer clean extension of the current project over broad ad hoc architecture drift

### 2. Reuse Over Reinvention

- identify places where the implementation could have reused existing logic instead of creating a new parallel path
- identify places where code could be generalized or extended within the lane rather than duplicated
- request changes when a new subsystem is introduced even though equivalent or near-equivalent logic already exists nearby

### 3. Shared Pattern Awareness

- call out solutions that make later reuse harder across projects
- prefer composable, understandable structures over one-off feature hacks
- be skeptical of large new abstractions unless they clearly reduce duplication or simplify future work

## Lane Deliverable Themes

PM should cover most of these themes per lane.

### Aquarium Lane

- deepen fish behavior, economy, and progression decisions
- improve tank pressure, threat escalation, and session structure
- improve readability and player feedback as systemic depth grows

### Adventure Lane

- deepen exploration structure, encounter variety, and progression
- strengthen objectives, biome identity, and companion or capture payoff
- improve run readability and milestone feedback

### Fluxborne Lane

- deepen combat builds, contracts, and mission structure
- improve continuity between runs, acts, and home-base progression
- strengthen UI clarity around heavy systems and progression state

## Planning Rules For PM

- Generate implementation tasks only.
- Do not emit reviewer tasks.
- Keep each task lane-pure and atomic.
- Prefer modifying existing code paths over introducing detached scaffolding.
- Prefer feature work that produces real gameplay or UX value, not placeholder notes.
- Make the task list large enough that each lane PR becomes a genuine multi-commit feature sprint.
- Include tests only where existing patterns make them natural and useful.
- Include acceptance criteria that make reuse and separation expectations inspectable when appropriate.

## Definition Of Done

- Aquarium, Adventure, and Fluxborne each gain a substantial feature expansion.
- The work lands as three large lane PRs with many commits.
- The implementations show discipline around project separation.
- The sprint does not create obvious redundant systems where existing logic could have been reused or extended.
- Reviewer feedback should plausibly involve multiple rounds because the bar on structure, reuse, and separation is intentionally high.

## Explicit Non-Goals

- no cross-lane implementation tasks
- no PM-generated reviewer work
- no filler tasks created only to inflate commit count
- no sloppy duplication of nearby existing logic without justification
