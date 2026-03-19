# Committed Specs

- Place committed PRD specs under `prompts/autonomous/v2/specs/prds/<prd-id>.json`.
- `node scripts/autonomy-v2.js prd:add ...` writes and pushes those spec files to `dev` automatically.
- PRD specs may include either explicit `tasks` or freeform `specification` / `requirements` inputs for the PM Codex lane to decompose.
- The polling server imports committed specs from `origin/dev` and turns them into local PM inbox entries and tasks.
