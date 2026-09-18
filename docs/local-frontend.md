# Local frontend integration

The package supplies the architecture for repository-selected React function
components. It does not supply a desktop host, browser server or fixed UI.

## Configuration

Use the repository's `prompts/autonomous/v2/config/control-plane.json`, or pass
another `configPath` to the factory:

```json
{
  "repoId": "example",
  "frontend": "./frontend/AgentPage.tsx",
  "actionPresets": ["shared"],
  "frontendOptions": { "compact": true }
}
```

`frontendPreset` selects a page from the host's preset registry. A repo's
`frontend` overrides that preset's module; `frontendOptions` shallowly overrides
its default options. No built-in page registry or fixed navigation is assumed.

## Host boundary

```ts
import { createFrontendRuntime, createPageLoader } from '@asalaza6/autonomy-v2/frontend';

const { runtime, context, configPath } = createFrontendRuntime({ rootDir });
const loader = createPageLoader({
  runtime, context, configPath,
  presets: pagePresets,
  importModule: compileAndImportPage,
  onPage: ({ component, props }) => mountReact(component, props),
  onError: showError,
});
await loader.reload();
// On close: loader.dispose(); runtime.dispose();
```

The host supplies the page registry, TSX compilation/module importer and React
mounting. Its importer receives a revision for cache invalidation. The loader
watches config and page files, ignores superseded loads and disposes watchers.
For preset files outside the repository, supply a host `watch` adapter.
Recreate the runtime when changing the selected action groups or repository.

React pages default-export a function accepting `FrontendPageProps`. `context`
contains repository identity, optional selected agent/preset, and page options.
`runtime` contains local file/JSON reads, listing/watching, agent/run lookup,
log paging and action/operation methods. Import the page types with `import type`;
Node-backed runtime construction belongs in the host, not a browser bundle.

## Actions

Call `await runtime.runAction(name, input)` to validate and start an operation.
Poll `runtime.getOperation(operation.id)` for success, failure, logs and result.
Operation records persist under `.autonomy/runtime/frontend/operations`.

| Group | Action | Input |
| --- | --- | --- |
| shared | `chat:send` | `{ message, threadId? }` |
| shared | `agent:toggle` | `{ agentKey, enabled }` |
| development | `prd:add` | `{ id, title, specification?, requirements?, priority? }` |
| development | `prd:reset` | `{ prdId, reason? }` |
| development | `prd:priority` | `{ prdId, priority, reason? }` |
| development | `deploy` | `{}` |
| maintenance | `package:update` | `{}` |
| maintenance | `server:restart` | `{}` |

PRD addition needs a specification or requirements. Priority is `highest`,
`high`, `normal` or `low`. Chat is workflow-neutral and saves local history;
it invokes the configured Codex CLI. Model execution and repository actions
may use their configured external services; UI access itself has no HTTP layer.

Only `shared` is enabled by default. `actionPresets: []` enables no built-ins.
Trusted host modules may supply `actionOverrides` to the factory, using `null`
to remove an action or `{ validate, run, lockKey? }` to replace/register one.
The renderer cannot provide arbitrary shell commands.

Blocking development and maintenance commands run in a fixed child dispatcher.
The registry serializes mutations within a runtime instance; underlying PRD and
agent mutations also use their existing repository state locks. Running
operations are not automatically resumed after a host crash.
