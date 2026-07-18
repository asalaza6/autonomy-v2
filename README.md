# Autonomy v2

Autonomy v2 is a small local process host for repository-defined custom agents.
It provides only:

- a polling server;
- custom-agent discovery and process bookkeeping;
- JSON-over-stdio lifecycle commands;
- Codex execution between the prompt and finalize lifecycle phases.

The consumer repository owns everything else: work selection, API clients,
prompts, tools, Git operations, validation, deployment, and recovery policy.
This package has no control plane, HTTP API, Git workflow, default agents,
queues, PRDs, templates, or repository scaffold.

## Install and run

```bash
cat >> .npmrc <<'EOF'
@asalaza6:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
EOF

npm install -O @asalaza6/autonomy-v2
npx autonomy-v2 custom-agent:list --root .
npx autonomy-v2-server serve --root .
```

`NODE_AUTH_TOKEN` must be able to read the package from GitHub Packages.

Run one configured agent immediately, while still honoring its decision hook:

```bash
npx autonomy-v2 custom-agent:run \
  --root . \
  --runtime-key game-agent:fluxborne
```

The server also supports a single detached polling pass:

```bash
npx autonomy-v2-server tick --root . --json
```

## Configuration

The default configuration path is:

```text
prompts/autonomous/v2/config/custom-agents.json
```

Use `--config <repo-relative-path>` or
`AUTONOMY_CUSTOM_AGENTS_CONFIG` to select another file inside the repository.
There is no `control-plane.json` indirection.

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "kind": "project-agents",
  "promptRole": "project maintenance agent",
  "context": {
    "globalReadOnly": ["docs/AGENT.md"],
    "workspaceReadWrite": ["context.md", "notes.md"],
    "allowRuntimeStateChanges": true
  },
  "agents": [
    {
      "id": "game-agent",
      "enabled": true,
      "target": {
        "type": "repository",
        "id": "fluxborne"
      },
      "workspace": ".autonomy/runtime/game-agent",
      "spawn": {
        "mode": "poll",
        "intervalSeconds": 10,
        "parallelism": 1,
        "singletonKey": "agent.id",
        "decision": {
          "mode": "command",
          "command": "node",
          "args": ["scripts/agent/should-run.mjs"],
          "timeoutMs": 15000
        }
      },
      "environment": {
        "command": "node",
        "args": ["scripts/agent/prepare.mjs"],
        "cwd": ".",
        "timeoutMs": 180000
      },
      "execution": {
        "prompt": {
          "command": "node",
          "args": ["scripts/agent/build-prompt.mjs"],
          "cwd": ".",
          "timeoutMs": 120000
        }
      },
      "finalize": {
        "command": "node",
        "args": ["scripts/agent/finalize.mjs"],
        "cwd": ".",
        "timeoutMs": 120000
      },
      "conversation": {
        "mode": "fresh"
      }
    }
  ]
}
```

The runtime key is `<agent.id>:<target.id>`.

Parallel workers are opt in. Set `spawn.parallelism` to an integer from 1 to
32; omitting it preserves the single-worker behavior. The logical runtime key
stays stable for the CLI and `custom-agent:list`. Internally, additional slots
use `#2`, `#3`, and so on. A single worker keeps the configured workspace; an
opted-in pool gives every slot the disjoint sibling workspace
`<workspace>-slots/slot-N`. Keeping the pool outside the single-worker path also
makes a live scale-up from one worker safe. A manual `custom-agent:run` starts at most one
available slot.

The decision hook is the general starting-criteria contract. Each free slot
invokes it independently. A consumer that selects shared work should atomically
claim or lease one eligible task before returning `shouldRun: true`; a
peek-only decision can assign the same task twice. Return the selected task in
`target` and/or other decision fields. That exact decision payload is carried
through environment, prompt, and finalize.

## Lifecycle protocol

Decision, environment, prompt, and finalize commands receive one JSON object
on stdin. Lifecycle envelopes include:

```json
{
  "invocationId": "game-agent-fluxborne-...",
  "runtimeKey": "game-agent:fluxborne",
  "baseRuntimeKey": "game-agent:fluxborne",
  "parallel": { "slot": 1, "total": 1 },
  "agentId": "game-agent",
  "agentType": "project-agents",
  "repoRoot": "/absolute/repository/path",
  "phase": "prompt",
  "target": {},
  "workspace": { "cwd": "/absolute/workspace/path" },
  "paths": {},
  "decision": {},
  "previous": {},
  "run": null
}
```

Commands also receive `AUTONOMY_CUSTOM_AGENT_RUNTIME_KEY`,
`AUTONOMY_CUSTOM_AGENT_BASE_RUNTIME_KEY`, `AUTONOMY_CUSTOM_AGENT_SLOT`, and
`AUTONOMY_CUSTOM_AGENT_PARALLELISM`. Slot identity is stable for the lifetime
of an invocation, so consumers can isolate claims, workspaces, locks, and other
local resources without adding task logic to this package.

Commands must exit successfully and write either no output or one JSON object.
The decision command returns `{ "shouldRun": true|false }` and may add a
`reason` and target fields. The environment command may return `cwd`. The
prompt command returns `prompt` or `promptPath`. Finalize receives
`run.status: "completed"` after Codex succeeds or `run.status: "failed"` when
environment preparation, prompt construction, or Codex execution fails.

When `conversation.mode` is `fresh`, Codex uses an ephemeral session. Other
values use a scoped resumable session. `allowRuntimeStateChanges: true` selects
Codex's `danger-full-access` sandbox; otherwise it selects `workspace-write`.

## Runtime state

Process state is stored locally at:

```text
.autonomy/runtime/state/runtime.json
```

It contains only `customAgents` and `customAgentInvocations`. Agent lifecycle
commands may read this file for liveness and fencing. It is local runtime data,
not a source-controlled workflow database.
