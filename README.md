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
  "frontend": "./frontend/AgentPage.tsx",
  "actionPresets": ["shared", "development"],
  "frontendOptions": { "showHistory": true }
}
```

A game-agent repo can select only `shared`. Add `maintenance` when package
updates and server restarts should be available. Repos can select registered
page presets with `frontendPreset`, override their `frontend` path, and override
preset options with `frontendOptions`.

Pages receive `{ context, runtime }`. The runtime provides local file reads,
watching, agent/run inspection, logs, registered actions and operation status.
Pages own their workflow, layout and navigation; the loader has no fixed tabs
or repository-specific branches.

| Action preset | Registered actions |
| --- | --- |
| `shared` | `chat:send`, `agent:toggle` |
| `development` | `prd:add`, `prd:reset`, `prd:priority`, `deploy` |
| `maintenance` | `package:update`, `server:restart` |

See [Local frontend](docs/local-frontend.md) for integration and action inputs.

## Custom agents

Lifecycle stages are decision, environment, prompt, execution and finalize.
Use explicit commands for a custom implementation or `presetAgentId` for the
packaged `shadow-pm-agent`, `shadow-architecture-agent` and
`shadow-reviewer-agent` definitions. Presets run scripts from this package;
consumers do not need copies. Overrides remain supported.

[Configuration](docs/autonomy-v2-config-support.md) ·
[Orchestration](docs/orchestrator-flow.md) ·
[Repository metadata](docs/autonomy-v2-agents-schema.md)

## Development

```sh
npm run build
npm run typecheck
npm run lint
npm test
```
