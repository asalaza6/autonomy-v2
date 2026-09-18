# Local UI inventory

| Former page | Current location |
| --- | --- |
| Chat | `control-presets/shared/components.tsx` |
| Agents | `control-presets/shared/components.tsx` |
| Main | `control-presets/development/frontend.tsx` |
| History | `control-presets/development/frontend.tsx` |
| Advanced | Development page; optional maintenance component |
| Health | Removed; scripts preserved in `health-script` |
| Manager, Heroku, hosted panel | Removed |

`src/frontend/` loads definitions and injects the runtime. It contains no fixed
workflow tabs. `src/runtime/` supplies reusable action IO, processes, and locks.
A host supplies React mounting; no Electron, hosted backend, or bridge is needed.

See [Local frontend](local-frontend.md) for the file contract and examples.
