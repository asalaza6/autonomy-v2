# Autonomy v2

A repository-local custom-agent runtime. The agent server schedules work;
repository lifecycle scripts own planning, implementation, review, checks and
cleanup. Packaged presets provide shared lifecycle implementations.

The hosted control panel and bridge have been removed. Frontend support is a
host-independent runtime, action registry and page loader. A host supplies TSX
compilation and React mounting; the package does not start a UI server or ship
a desktop app.

## Run agents

```sh
npx autonomy-v2 init --root /path/to/repo
npx autonomy-v2-server serve --root /path/to/repo
npx autonomy-v2 custom-agent:list --root /path/to/repo
```

The existing `prompts/autonomous/v2/config/control-plane.json` filename is
retained for repository configuration. Its `spawnCustomAgents` field selects
one or more custom-agent configs; it no longer configures a hosted panel.

## Local frontend configuration

```json
{
  "repoId": "my-repo",
  "controls": {
    "preset": "development",
    "frontend": "./controls/frontend.tsx",
    "options": "./controls/options.json"
  }
}
```

Control definitions use `frontend.tsx`, `actions.ts`, and `options.json`.
`control-presets/` supplies optional tested defaults, separate from agent
`presets/`. Omit `preset` and provide your own files, or override individual
preset files. Action paths point to compiled JavaScript unless the host supplies
a TypeScript importer. Packaged controls supply React pages, actions, and options. A host supplies
React mounting and a module importer; no desktop framework is required.

Pages receive `{ context, runtime, options }`. Actions receive validated input
and `{ rootDir, runtime, capabilities, log, options }`. The runtime only loads and dispatches definitions.
Existing `actionPresets` arrays and `frontend`/`frontendPreset` configuration
remain supported when `controls` is absent.

| Action preset | Registered actions |
| --- | --- |
| `shared` | `chat:send`, `agent:toggle` |
| `development` | Shared and maintenance actions plus `prd:list`, `prd:add`, `prd:reset`, `prd:priority`, `deploy` |
| `maintenance` | `package:update`, `server:restart` |

See [Local frontend](docs/local-frontend.md) for integration and action inputs.

## Custom agents

Lifecycle stages are decision, environment, prompt, execution and finalize.
Use explicit commands for a custom implementation or `presetAgentId` for the
packaged `shadow-pm-agent`, `shadow-architecture-agent` and
`shadow-reviewer-agent` definitions. Presets run scripts from this package;
consumers do not need copies. Overrides remain supported.

[Configuration](docs/autonomy-v2-config-support.md) ·
[Orchestration](docs/orchestrator-flow.md)

## Development

```sh
npm run build
npm run typecheck
npm run lint
npm test
```
