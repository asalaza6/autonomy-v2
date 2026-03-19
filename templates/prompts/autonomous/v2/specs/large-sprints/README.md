# Large Sprint PRD Drafts

These are draft PRD specifications intended for later use with `node scripts/autonomy-v2.js prd:add ...`.

They are deliberately stored outside `prompts/autonomous/v2/specs/prds/` so the live scheduler does not ingest them automatically.

Current drafts:

- `aquarium-large-sprint.md`
- `adventure-large-sprint.md`
- `fluxborne-large-sprint.md`

Supporting metadata lives in `manifest.json`.

Design intent:

- one large PRD per executor lane
- many implementation tasks per PRD
- many commits on a single PR per lane
- all three PRDs can be queued together later

