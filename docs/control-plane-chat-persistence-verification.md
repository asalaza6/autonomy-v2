# Control-Plane Chat Persistence Verification

This note records the focused verification for the hosted control-plane chat
persistence and restart/redeploy behavior added in:

- `src/server/control-plane/control-plane-chat.ts`
- `src/server/control-plane/control-plane-store.ts`

It exists to provide merge-review evidence beyond wrapper-only checks for this
high-risk control-plane path.

## Commands

```bash
npm run typecheck
npm run build
node --test --test-name-pattern "control plane chat falls back to history continuity when a stored resume session is stale|control plane chat persistence survives hosted restart recovery and reuses stored Codex conversation ids|control plane chat persists conversation messages and bridge replies" dist/tests/unit/control-plane-chat.test.js
node --test --test-name-pattern "control plane preserves repo assistant conversations across server restart" dist/tests/smoke/control-plane.test.js
```

## Result

All commands passed locally on 2026-04-29.

Focused passing assertions:

- stale stored resume sessions fall back to history continuity safely
- persisted conversation messages and bridge replies survive state reload
- hosted restart recovery reuses stored Codex conversation ids when available
- repo assistant conversations remain available across server restart
- follow-up chat requests after restart continue the same conversation id
