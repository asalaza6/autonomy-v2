# Dynamic Local UI Action Plan

## Context and reasoning

Autonomy v2 is moving from a fixed PRD → implementation → review product toward a runtime for custom agents. Repositories need different interfaces: development may expose PRDs and reviews, while Fluxborne agents may expose game controls. One fixed frontend would preserve obsolete assumptions and repository conditionals.

The frontend becomes a local shell loading repository-selected React pages. Presets provide defaults; repositories may override them. Pages receive a stable Autonomy runtime. Everything runs offline through the host and repository files, without HTTP APIs, servers, hosted backends, or deployments.

## Proposal structure

Configuration points to a page:

```json
{ "frontend": "./frontend/AgentPage.tsx" }
```

The shell resolves configuration, loads the page, and injects context and runtime. The page owns workflow, presentation, and navigation. The runtime owns local access, notifications, execution, and operation state. Presets package reusable pages and actions without repository names in the shell.

## Runtime functions

| Function | Purpose |
|---|---|
| `readFile(path)` | Read repository text or artifacts. |
| `readJson(path)` | Read and parse local structured data. |
| `listFiles(path, options)` | Discover records, runs, logs, and assets. |
| `watch(paths, onChange)` | Refresh React state after local changes. |
| `listAgents()` | Return configured agents and runtime status. |
| `getAgent(agentKey)` | Read one resolved agent definition. |
| `listRuns(agentKey)` | List an agent's execution history. |
| `getRun(runId)` | Read lifecycle state and run outputs. |
| `readLogs(runId, options)` | Stream or page local execution logs. |
| `runAction(name, input)` | Invoke a registered local operation. |
| `getOperation(operationId)` | Track asynchronous action progress and errors. |

Context supplies repository identity, selected agent, preset, and frontend configuration. Registered actions keep validation, locking, and lifecycle rules outside components.

## General plan

1. Define frontend configuration, runtime types, action registration, loading, and reload behavior.
2. Inventory pages; classify each UI item as shared, workflow-specific, or removable.
3. Make React use only the injected runtime. Remove HTTP, API routes, backend services, hosted builds, and deployments.
4. Migrate Chat first because it is workflow-neutral.
5. Rewrite Agents around the common lifecycle.
6. Remove Health entirely; its scripts are preserved separately in `health-script`.
7. Move Main, History, and Advanced into a development preset using runtime calls.
8. Remove Manager, Heroku, backend, legacy API, and fixed-tab code after migration.
9. Validate development, Fluxborne, and Game Agent workflows without repository conditionals.

## Pages identified for migration

| Page | Direction |
|---|---|
| Chat | Shared reusable page. |
| Agents | Shared lifecycle-focused page. |
| Health | Remove; standalone scripts live in `health-script`. |
| Main | Development-workflow preset page. |
| History | Development-workflow preset page. |
| Advanced | Split useful diagnostics from legacy controls. |
| Manager | Remove unless local multi-repository browsing remains required. |
