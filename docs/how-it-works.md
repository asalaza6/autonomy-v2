# How Autonomy v2 works

The agent server independently polls configured custom agents. Decision commands
choose work; the custom worker runs environment, prompt, Codex and finalize
stages. Presets supply reusable lifecycle scripts and repos may override them.

Frontend pages use an injected local runtime. The host loads the configured
React component and mounts it. Registered actions provide shared chat/agent
controls, optional development workflows and optional maintenance operations.
The page owns layout and navigation; the host owns rendering. Neither the
runtime nor the page loader needs HTTP endpoints, a bridge or a hosted manager.

The previous control panel, browser client, hosted job queue, heartbeat transport
and bridge have been removed. There is no replacement fixed UI: repository pages
and page presets use the new contracts.

`control-plane.json` remains the config filename used by existing agents and
deployment commands. Deployment actions still deploy the consumer's project
when explicitly requested; Autonomy no longer deploys its own control panel.
Custom agents may still use remote model providers and configured external tools.

See [Local frontend](local-frontend.md), [configuration](autonomy-v2-config-support.md)
and [orchestration](orchestrator-flow.md).
