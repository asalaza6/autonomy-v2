# Committed Specs

- Place one active PRD spec under `prompts/autonomous/v2/specs/prds/<prd-id>.json`.
- Extra queued PRDs are written to `prompts/autonomous/v2/specs/prds/queue/<prd-id>.json`.
- `node scripts/autonomy-v2.js prd:add ...` writes the active PRD to `specs/prds/` and places additional PRDs into `specs/prds/queue/`, then pushes to `dev` automatically.
- PRD specs may include either explicit `tasks` or freeform `specification` / `requirements` inputs for the PM Codex lane to decompose.
- The polling server imports committed specs from `origin/dev` and turns them into local PM inbox entries and tasks.
