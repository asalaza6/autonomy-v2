# Autonomy workspace

Configure custom agents in the file or files selected by
`config/control-plane.json.spawnCustomAgents`. Init creates an empty
`config/custom-agents.json`; add your repository's lifecycle configuration there.

Each agent can configure:

1. `spawn.decision.command`: decide whether work is ready.
2. `environment.command`: prepare the workspace.
3. `execution.prompt.command`: build the Codex prompt.
4. `finalize.command`: record results and finish or clean up the work.

The repository owns those command files. Init does not generate or prune agent
prompts, scripts or queues, including with `--force`.

`config/agents.json` retains repository settings, Git identities and queue
metadata used by the CLI and control plane. Its entries do not start agents.
The built-in PM, implementation and review runners have been removed.

Edit `project-context.md` for your project. Local invocation state and logs live
under `.autonomy/`, which is ignored by Git. Preserve existing custom-agent
configuration and state when updating the package.
