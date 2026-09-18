# Local frontend integration

Autonomy supplies a local runtime, module loader, and optional React pages.
The host imports and mounts a component. There is no HTTP layer, bridge, fixed
navigation in core, or desktop framework requirement. Agents and actions may
still use configured external model providers and tools.

## Three control files

```json
{
  "repoId": "example",
  "controls": {
    "preset": "development",
    "frontend": "./controls/frontend.tsx",
    "actions": "./controls/dist/actions.js",
    "options": "./controls/options.json"
  }
}
```

Use this in `prompts/autonomous/v2/config/control-plane.json`, or pass a custom
`configPath`. Each supplied file replaces that preset's corresponding file.
Omit overrides to use its tested defaults. Omit `preset` to supply entirely
repository-owned definitions. `controls: {}` loads no actions and no page.
`options.json` is an object passed to both pages and actions.

Agent presets under `presets/` are independent of `control-presets/`.

| Control preset | React pages | Actions |
| --- | --- | --- |
| `shared` | Chat, Agents | `chat:send`, `agent:toggle` |
| `development` | Main, Chat, Agents, History, Advanced | Shared and maintenance actions; `prd:list`, `prd:add`, `prd:reset`, `prd:priority`, `deploy` |
| `maintenance` | Package update and server restart | `package:update`, `server:restart` |

Development shows maintenance controls when `options.maintenance` is true.
Set `options.deployAfterArchive` to true to have the packaged reviewer invoke
the configured `deploy` action after successfully archiving a completed PRD.
It defaults to false.
The preset owns this composition; the runtime has no workflow-specific dispatch.
Legacy `actionPresets` and `frontend`/`frontendPreset` selection remain supported
when `controls` is absent. Legacy action selection defaults to `shared`.

## Host integration

```ts
import { createFrontendRuntime, createPageLoader } from '@asalaza6/autonomy-v2/frontend';

const { runtime, context, configPath } = await createFrontendRuntime({ rootDir });
const loader = createPageLoader({
  runtime, context, configPath,
  importModule: compileAndImportPage,
  onPage: ({ component, props }) => mountReact(component, props),
  onError: showError,
});
await loader.reload();
// On close: loader.dispose(); runtime.dispose();
```

The host supplies TSX compilation or JavaScript import and React mounting.
Packaged pages are already compiled. React 19 is an optional peer dependency
for hosts using these pages; the agent server does not require React.

The loader watches repository config, page and options files, rejects stale
imports, and disposes watchers. A host `watch` adapter can additionally watch
packaged files outside the repository. Recreate the action runtime after changing
action modules, options, or action selection so action context matches the page.

A page default-exports a React function receiving `{ context, runtime, options }`.
Import `FrontendPageProps` from `@asalaza6/autonomy-v2/frontend` as a type.
Pages use file reads, listings, watches, agent/run inspection, paged logs,
`runAction(name, input)`, and `getOperation(id)`. Pages own navigation and layout.
Node-backed runtime construction belongs to the host, outside the page bundle.

## Action contract

```ts
import type { LocalAction } from '@asalaza6/autonomy-v2/runtime';

export default {
  'game:save': {
    validate(input) {
      if (!input || typeof input !== 'object') throw Error('Object required');
      return input;
    },
    lockKey: 'game-state',
    async run(input, { runtime, log }) {
      await runtime.withLock(() => runtime.writeJson('game/state.json', input));
      log('Saved game state');
      return { saved: true };
    },
  },
} satisfies Record<string, LocalAction>;
```

The trusted action runtime supplies repository-contained reads, JSON IO, file
listing, atomic writes, removal, process execution, and repository locking.
`context.capabilities` supplies model execution, agent toggles and server process
control. These are generic runtime facilities; reuse them rather than copying
infrastructure into presets. Workflow decisions and Git policy stay in actions.

Both inline and worker actions receive these facilities. Export
`const execution = 'worker'` for subprocess execution. Node 20 worker modules must
be compiled JavaScript with resolvable imports. A host may supply `importModule`
for inline TypeScript actions; that importer is not transferred to workers.
Modules are trusted configuration, like lifecycle scripts, not renderer input.

`runAction` validates input and returns an operation. Poll `getOperation` for
status, logs, errors, and result. Records persist under
`.autonomy/runtime/frontend/operations`. Actions sharing a lock key cannot run
concurrently within one runtime; `runtime.withLock` coordinates repository
mutations across processes. Pending operations are not resumed after a crash.

The generic CLI can run a configured action:

```sh
npx autonomy-v2 action:run --root /path/to/repo --name prd:add \
  --input '{"id":"example","title":"Example","specification":"Build it"}'
```

## Development behavior

PRDs are read and committed on the integration branch, regardless of checkout.
`prd:add` requires ID, title, and specification or requirements. The first PRD
is active; subsequent ones are queued. `prd:priority` accepts highest, high,
normal or low. `prd:reset` archives the spec and matching custom-lifecycle tasks
and removes their PR records. History reads archived specs from the same branch.

`options.integrationBranch` defaults to existing `agents.json` metadata or `dev`.
`specsDir` defaults to `prompts/autonomous/v2/specs/prds`; `lifecycleDir` defaults
to `.autonomy/runtime/custom-lifecycle`. Custom paths must match your lifecycle
scripts. Deployment uses the configured integration/production branches and
repository deploy command. Git and deployment logic live only in this preset.

Maintenance updates use the selected package manager and refresh the newly
installed runtime config without replacing existing definitions. Server restart
uses the generic process controller. No workflow-specific CLI remains in core.
