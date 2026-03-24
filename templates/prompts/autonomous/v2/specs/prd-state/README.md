Tracked PRD lifecycle companion files live here.

Each file is named `<prd-id>.json` and records PM planning lifecycle state that is not fully derivable from spec placement alone.

Current tracked fields are intentionally narrow:

- `schemaVersion`
- `prdId`
- `status` with `planning`, `planned`, or `failed`
- `plannedTaskIds`
- `lastError`
- `createdAt`
- `updatedAt`

Queued PRDs remain derived from spec placement under `specs/prds/queue/`.
Completed PRDs remain derived from tracked lane state and merge outcomes.
